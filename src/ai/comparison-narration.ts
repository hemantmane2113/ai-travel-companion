import type { Domain } from '../providers/hotel-provider';
import type { LlmProvider } from './llm-provider';
import {
  generateValidatedStructuredOutput,
  type StructuredGenerationConfig,
} from './generate-validated-structured-output';

/** A minimal, domain-agnostic view of one offer for narration purposes only - never `raw`, never provider-internal fields (V2 architecture Phase 4/5 §C/§K/§14). */
export interface NarrationOfferSummary {
  offerId: string;
  domain: Domain;
  provider: string;
  /** Human-readable identity - the hotel's name, or "IndiGo 6E-204" for a flight. */
  label: string;
  price: number;
  currency: string;
  availability: boolean;
  priceDeltaFromCheapest: number | null;
}

export interface NarrationDomainSummary {
  domain: Domain;
  cheapestOfferId: string | null;
  mostExpensiveOfferId: string | null;
  availableCount: number;
  unavailableCount: number;
}

/** What the Comparison Agent hands the narration step (Phase 5: generalized from a single HotelComparisonResult to a merged, multi-domain view - see runComparison). */
export interface ComparisonNarrationInput {
  offers: NarrationOfferSummary[];
  domainSummaries: NarrationDomainSummary[];
}

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
real, already-verified travel offers (hotels and/or transport) and, per domain, a
deterministic comparison summary (cheapest, most expensive, availability) - each offer
identified by an offerId. Using ONLY that supplied information, produce a short narration
as JSON matching exactly this shape:
{
  "narrative": string,
  "highlights": [
    { "offerId": string, "note": string }
  ]
}
Rules:
- Every "offerId" in "highlights" MUST be copied exactly, character-for-character, from
  the supplied offer list. Never invent an offerId.
- Do not state a price, currency, provider, or availability that was not given to you.
  Do not recalculate or contradict the supplied cheapest/most-expensive values - only
  explain them in plain language.
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

function buildUserPrompt(input: ComparisonNarrationInput): string {
  const offerLines = input.offers.map(
    (o) =>
      `- offerId=${o.offerId} domain=${o.domain} provider=${o.provider} label="${o.label}" price=${o.price} ${o.currency} availability=${o.availability} priceDeltaFromCheapest=${o.priceDeltaFromCheapest ?? 'n/a'}`,
  );
  const summaryLines = input.domainSummaries.map(
    (s) =>
      `- domain=${s.domain} cheapest=${s.cheapestOfferId ?? 'none available'} mostExpensive=${s.mostExpensiveOfferId ?? 'none available'} available=${s.availableCount} unavailable=${s.unavailableCount}`,
  );
  return [`Offers (${input.offers.length}):`, offerLines.join('\n'), 'Per-domain summary:', summaryLines.join('\n')].join('\n\n');
}

/** Deterministic-only summary - no LLM involved, always available regardless of model health. */
function deterministicFallback(input: ComparisonNarrationInput): string {
  if (input.offers.length === 0) {
    return 'No offers were found for this search.';
  }
  const offersById = new Map(input.offers.map((o) => [o.offerId, o]));
  const parts: string[] = [];
  for (const summary of input.domainSummaries) {
    const count = input.offers.filter((o) => o.domain === summary.domain).length;
    if (count === 0) continue;
    const cheapest = summary.cheapestOfferId ? offersById.get(summary.cheapestOfferId) : undefined;
    const segment = [`Found ${count} ${summary.domain} offer(s).`];
    if (cheapest) segment.push(`Cheapest available: ${cheapest.label} at ${cheapest.price} ${cheapest.currency}.`);
    segment.push(`${summary.availableCount} available, ${summary.unavailableCount} unavailable.`);
    parts.push(segment.join(' '));
  }
  return parts.join(' ');
}

/**
 * The Comparison Agent's optional narration step (plan §G), generalized
 * in Phase 5 to narrate over any mix of domains in one call - never one
 * LLM call per domain (§9's "do not increase LLM calls unnecessarily").
 * Reuses the exact same generic grounded-generation primitive itinerary
 * generation uses (Phase 1) - offerId-membership checked the same way
 * fact_version ids are, not a second grounding implementation. The LLM
 * is never authoritative for any comparison field: this function's
 * output is prose only, and any highlight citing an offerId outside the
 * supplied set - or any failure at all (bad JSON, wrong shape, provider
 * error/timeout) - discards the ENTIRE narration in favor of the
 * deterministic-only fallback, never a partially-trusted result.
 */
export async function narrateComparison(
  provider: LlmProvider,
  input: ComparisonNarrationInput,
): Promise<ComparisonNarrationResult> {
  if (input.offers.length === 0) {
    return { narrative: deterministicFallback(input), fellBackToDeterministic: true };
  }

  const allowedOfferIds = new Set(input.offers.map((o) => o.offerId));

  try {
    const { parsed, rejectedItems } = await generateValidatedStructuredOutput(
      provider,
      SYSTEM_PROMPT,
      buildUserPrompt(input),
      allowedOfferIds,
      NARRATION_CONFIG,
    );

    if (rejectedItems.length > 0) {
      return { narrative: deterministicFallback(input), fellBackToDeterministic: true };
    }

    return { narrative: parsed.narrative, fellBackToDeterministic: false };
  } catch {
    return { narrative: deterministicFallback(input), fellBackToDeterministic: true };
  }
}
