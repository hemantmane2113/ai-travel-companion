import type { Candidate, CandidateSet } from '../travel-intelligence/candidate-set';
import type { WarningCandidate } from '../travel-intelligence/warning-candidates';
import type { LlmProvider } from './llm-provider';
import {
  generateValidatedStructuredOutput,
  type StructuredGenerationConfig,
} from './generate-validated-structured-output';
import type {
  GeneratedItinerary,
  GeneratedItineraryDay,
  GeneratedItineraryItem,
} from './itinerary-plan';

export interface TripContext {
  destination: string;
  interests: string[];
  numberOfDays: number;
}

export interface ItineraryResult {
  itinerary: GeneratedItinerary;
  /**
   * Items the model produced that failed grounding - either the
   * referenced place/warning doesn't exist, or a cited fact_version id
   * was never actually supplied in context. This is the plan §7
   * grounding check's output: the system's only real hallucination
   * guard. Normally empty in production; a non-empty array means
   * something was caught and stripped, never silently kept.
   */
  rejectedItems: GeneratedItineraryItem[];
}

const SYSTEM_PROMPT = `You are a travel planning assistant. You will be given a list of
real, verified places and, separately, a list of travel warnings for a destination - each
with an id called a fact_version id. Using ONLY that supplied information, produce a
multi-day itinerary as JSON matching exactly this shape:
{
  "summary": string,
  "days": [
    {
      "dayNumber": number,
      "summary": string,
      "items": [
        {
          "itemType": "place" | "warning",
          "placeId": string,       // required when itemType is "place", omit for "warning"
          "reason": string,
          "factReferences": [string]  // fact_version id(s) this item is grounded in
        }
      ]
    }
  ]
}
Rules:
- Produce exactly the requested number of days, numbered 1..N in order.
- Every "placeId" MUST be copied exactly, character-for-character, from the supplied list.
- Every entry in "factReferences" MUST be copied exactly from the fact_version ids you were
  given. Never invent a placeId or a fact_version id, and never state a fact that was not
  given to you.
- A "place" item's factReferences MUST include that place's own fact_version id.
- Include a "warning" item only when a supplied warning is genuinely relevant to this trip.
  Warnings are static reference notes curated ahead of time, not live or real-time
  monitoring - phrase them accordingly (e.g. "Note:" rather than "Current alert:").
- If you are unsure whether something is true, do not state it as fact.
- Respond with JSON only, no other text.`;

function describePlaces(label: string, items: Candidate[]): string {
  if (items.length === 0) return `${label}: (none available)`;
  const lines = items.map((c) => `- placeId=${c.placeId} fact_version=${c.factVersionId} name="${c.name}"`);
  return `${label}:\n${lines.join('\n')}`;
}

function describeWarnings(items: WarningCandidate[]): string {
  if (items.length === 0) return 'Warnings: (none available)';
  const lines = items.map((w) => `- fact_version=${w.factVersionId} text="${w.text}"`);
  return `Warnings:\n${lines.join('\n')}`;
}

function buildUserPrompt(candidateSet: CandidateSet, context: TripContext): string {
  return [
    `Destination: ${candidateSet.destination}`,
    `Trip length: ${context.numberOfDays} day(s)`,
    `Traveler interests: ${context.interests.length > 0 ? context.interests.join(', ') : 'general'}`,
    describePlaces('Attractions', candidateSet.attractions),
    describePlaces('Restaurants', candidateSet.restaurants),
    describePlaces('Shops', candidateSet.shops),
    describeWarnings(candidateSet.warnings),
  ].join('\n\n');
}

function allPlaceCandidates(candidateSet: CandidateSet): Candidate[] {
  return [...candidateSet.attractions, ...candidateSet.restaurants, ...candidateSet.shops];
}

/** Every fact_version id actually supplied in this request's context - places and warnings alike. */
function allSuppliedFactVersionIds(candidateSet: CandidateSet): Set<string> {
  return new Set([
    ...allPlaceCandidates(candidateSet).map((c) => c.factVersionId),
    ...candidateSet.warnings.map((w) => w.factVersionId),
  ]);
}

function isWellFormedItem(value: unknown): value is GeneratedItineraryItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as GeneratedItineraryItem;
  if (item.itemType !== 'place' && item.itemType !== 'warning') return false;
  if (typeof item.reason !== 'string') return false;
  if (!Array.isArray(item.factReferences) || item.factReferences.some((f) => typeof f !== 'string')) {
    return false;
  }
  if (item.factReferences.length === 0) return false;
  if (item.itemType === 'place' && typeof item.placeId !== 'string') return false;
  return true;
}

function isWellFormedDay(value: unknown): value is GeneratedItineraryDay {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GeneratedItineraryDay).dayNumber === 'number' &&
    typeof (value as GeneratedItineraryDay).summary === 'string' &&
    Array.isArray((value as GeneratedItineraryDay).items)
  );
}

function isWellFormedItinerary(value: unknown): value is GeneratedItinerary {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as GeneratedItinerary;
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.days)) return false;
  return candidate.days.every(isWellFormedDay);
}

/** The itinerary-specific config for the generic grounded-generation primitive (§ generate-validated-structured-output.ts). */
const ITINERARY_GENERATION_CONFIG: StructuredGenerationConfig<GeneratedItinerary, GeneratedItineraryItem> = {
  isWellFormedOutput: isWellFormedItinerary,
  isWellFormedItem,
  extractItems: (parsed) => parsed.days.flatMap((day) => day.items),
  getFactReferences: (item) => item.factReferences,
};

/**
 * The only module allowed to call an LLM (plan §6). Itinerary-specific
 * caller of the generic grounded-generation primitive (V2 architecture
 * Phase 1 refactor): owns the itinerary prompt/schema, the exact
 * day-count enforcement, and the place-specific "must cite its own
 * fact_version" rule - none of which the generic primitive knows about.
 * The primitive itself already applies the fact-reference-membership
 * check (plan §7, strengthened per stabilization P0-3); this class
 * layers the place-ownership rule on top - a pure id-membership check,
 * not prose parsing - so a place item can't pass by citing an unrelated
 * fact (e.g. a warning's id) instead of the one for the place it's
 * actually about.
 */
export class AiOrchestrationService {
  constructor(private readonly provider: LlmProvider) {}

  async generateItinerary(
    candidateSet: CandidateSet,
    context: TripContext,
  ): Promise<ItineraryResult> {
    const userPrompt = buildUserPrompt(candidateSet, context);
    const suppliedFactVersionIds = allSuppliedFactVersionIds(candidateSet);

    const { parsed, groundedItems, rejectedItems } = await generateValidatedStructuredOutput(
      this.provider,
      SYSTEM_PROMPT,
      userPrompt,
      suppliedFactVersionIds,
      ITINERARY_GENERATION_CONFIG,
    );

    if (parsed.days.length !== context.numberOfDays) {
      throw new Error(
        `LLM response contained ${parsed.days.length} day(s), expected ${context.numberOfDays}`,
      );
    }

    const placesById = new Map(allPlaceCandidates(candidateSet).map((c) => [c.placeId, c]));
    const rejected = [...rejectedItems];

    const groundedDays: GeneratedItineraryDay[] = parsed.days.map((day) => {
      const groundedDayItems = day.items.filter(isWellFormedItem).filter((item) => {
        if (!groundedItems.has(item)) return false;

        if (item.itemType === 'place') {
          const place = item.placeId ? placesById.get(item.placeId) : undefined;
          const citesOwnFact = place ? item.factReferences.includes(place.factVersionId) : false;
          if (!place || !citesOwnFact) {
            rejected.push(item);
            return false;
          }
        }
        // 'warning' items: existence of the fact_version was already
        // confirmed by the generic primitive - no separate placeId to check.

        return true;
      });

      return { dayNumber: day.dayNumber, summary: day.summary, items: groundedDayItems };
    });

    return {
      itinerary: { summary: parsed.summary, days: groundedDays },
      rejectedItems: rejected,
    };
  }
}
