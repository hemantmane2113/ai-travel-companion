import type { HotelComparisonResult } from '../hotels/compare-hotels';
import type { LlmProvider } from './llm-provider';
import {
  generateValidatedStructuredOutput,
  type StructuredGenerationConfig,
} from './generate-validated-structured-output';

export interface ComparisonNarrationHighlight {
  offerId: string;
  note: string;
}

interface ComparisonNarrationOutput {
  narrative: string;
  highlights: ComparisonNarrationHighlight[];
}

export interface ComparisonNarrationResult {
  narrative: string;
  /** true when the LLM was skipped/failed/produced ungrounded output and this is the deterministic-only fallback instead (plan §G/§H: the workflow must stay useful even with an unavailable/broken LLM). */
  fellBackToDeterministic: boolean;
}

const SYSTEM_PROMPT = `You are a travel comparison assistant. You will be given a list of
real, already-verified hotel offers and a deterministic comparison summary (cheapest,
most expensive, price differences, availability) - each offer identified by an offerId.
Using ONLY that supplied information, produce a short narration as JSON matching exactly
this shape:
{
  "narrative": string,
  "highlights": [
    { "offerId": string, "note": string }
  ]
}
Rules:
- Every "offerId" in "highlights" MUST be copied exactly, character-for-character, from
  the supplied offer list. Never invent an offerId.
- Do not state a price, currency, rating, availability, or provider that was not given
  to you. Do not recalculate or contradict the supplied cheapest/most-expensive/price
  difference values - only explain them in plain language.
- Respond with JSON only, no other text.`;

function isWellFormedHighlight(value: unknown): value is ComparisonNarrationHighlight {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as ComparisonNarrationHighlight;
  return typeof item.offerId === 'string' && typeof item.note === 'string';
}

function isWellFormedOutput(value: unknown): value is ComparisonNarrationOutput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as ComparisonNarrationOutput;
  return typeof candidate.narrative === 'string' && Array.isArray(candidate.highlights);
}

const NARRATION_CONFIG: StructuredGenerationConfig<ComparisonNarrationOutput, ComparisonNarrationHighlight> = {
  isWellFormedOutput,
  isWellFormedItem: isWellFormedHighlight,
  extractItems: (parsed) => parsed.highlights,
  getReferencedIds: (item) => [item.offerId],
};

function buildUserPrompt(comparison: HotelComparisonResult): string {
  const offerLines = comparison.offers.map(
    (o) =>
      `- offerId=${o.offerId} provider=${o.provider} name="${o.name}" price=${o.price} ${o.currency} rating=${o.rating} availability=${o.availability} cancellationPolicy="${o.cancellationPolicy}" priceDeltaFromCheapest=${o.priceDeltaFromCheapest ?? 'n/a'}`,
  );
  return [
    `Offers (${comparison.offers.length}):`,
    offerLines.join('\n'),
    `Cheapest available offerId: ${comparison.cheapestOfferId ?? 'none available'}`,
    `Most expensive available offerId: ${comparison.mostExpensiveOfferId ?? 'none available'}`,
    `Available: ${comparison.availableCount}, Unavailable: ${comparison.unavailableCount}`,
  ].join('\n\n');
}

/** Deterministic-only summary - no LLM involved, always available regardless of model health. */
function deterministicFallback(comparison: HotelComparisonResult): string {
  if (comparison.offers.length === 0) {
    return 'No hotel offers were found for this search.';
  }
  const parts = [`Found ${comparison.offers.length} hotel offer(s).`];
  const cheapest = comparison.offers.find((o) => o.offerId === comparison.cheapestOfferId);
  if (cheapest) {
    parts.push(`Cheapest available: ${cheapest.name} at ${cheapest.price} ${cheapest.currency}.`);
  }
  const mostExpensive = comparison.offers.find((o) => o.offerId === comparison.mostExpensiveOfferId);
  if (mostExpensive && mostExpensive.offerId !== cheapest?.offerId) {
    parts.push(`Most expensive available: ${mostExpensive.name} at ${mostExpensive.price} ${mostExpensive.currency}.`);
  }
  parts.push(`${comparison.availableCount} available, ${comparison.unavailableCount} unavailable.`);
  return parts.join(' ');
}

/**
 * The Comparison Agent's optional narration step (plan §G). Reuses the
 * exact same generic grounded-generation primitive itinerary generation
 * uses (Phase 1) - offerId-membership checked the same way fact_version
 * ids are, not a second grounding implementation. The LLM is never
 * authoritative for any comparison field (plan §E/§H): this function's
 * output is prose only, and any highlight citing an offerId outside the
 * supplied set - or any failure at all (bad JSON, wrong shape, provider
 * error/timeout) - discards the ENTIRE narration in favor of the
 * deterministic-only fallback, never a partially-trusted result. This
 * keeps the comparison workflow useful even with no LLM available.
 */
export async function narrateComparison(
  provider: LlmProvider,
  comparison: HotelComparisonResult,
): Promise<ComparisonNarrationResult> {
  if (comparison.offers.length === 0) {
    return { narrative: deterministicFallback(comparison), fellBackToDeterministic: true };
  }

  const allowedOfferIds = new Set(comparison.offers.map((o) => o.offerId));

  try {
    const { parsed, rejectedItems } = await generateValidatedStructuredOutput(
      provider,
      SYSTEM_PROMPT,
      buildUserPrompt(comparison),
      allowedOfferIds,
      NARRATION_CONFIG,
    );

    if (rejectedItems.length > 0) {
      return { narrative: deterministicFallback(comparison), fellBackToDeterministic: true };
    }

    return { narrative: parsed.narrative, fellBackToDeterministic: false };
  } catch {
    return { narrative: deterministicFallback(comparison), fellBackToDeterministic: true };
  }
}
