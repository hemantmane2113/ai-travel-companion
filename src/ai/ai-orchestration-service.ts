import type { Candidate, CandidateSet } from '../travel-intelligence/candidate-set';
import type { LlmProvider } from './llm-provider';
import type { DayPlanItem, GeneratedDayPlan } from './day-plan';

export interface TripContext {
  destination: string;
  interests: string[];
}

export interface DayPlanResult {
  plan: GeneratedDayPlan;
  /**
   * Items the model referenced that did NOT resolve to a place actually
   * present in the candidate set it was given. This is the plan §7
   * grounding check's output: the system's only real hallucination
   * guard. It should normally be empty in production - a non-empty
   * array here means the model invented something and it was caught
   * and stripped before anything was returned, never silently kept.
   */
  rejectedItems: DayPlanItem[];
}

const SYSTEM_PROMPT = `You are a travel planning assistant. You will be given a list of
real, verified places (with ids) for a destination. Using ONLY those places, produce a
single day plan as JSON matching exactly this shape:
{"summary": string, "items": [{"placeId": string, "note": string}]}
Every "placeId" MUST be copied exactly, character-for-character, from the supplied list.
Never invent a place, a placeId, or any fact that was not given to you. If you are unsure
whether something is true, do not state it as fact. Keep each note to one short sentence.
Respond with JSON only, no other text.`;

function describeCandidates(label: string, items: Candidate[]): string {
  if (items.length === 0) return `${label}: (none available)`;
  const lines = items.map((c) => `- id=${c.placeId} name="${c.name}"`);
  return `${label}:\n${lines.join('\n')}`;
}

function buildUserPrompt(candidateSet: CandidateSet, context: TripContext): string {
  return [
    `Destination: ${candidateSet.destination}`,
    `Traveler interests: ${context.interests.length > 0 ? context.interests.join(', ') : 'general'}`,
    describeCandidates('Attractions', candidateSet.attractions),
    describeCandidates('Restaurants', candidateSet.restaurants),
    describeCandidates('Shops', candidateSet.shops),
  ].join('\n\n');
}

function allCandidateIds(candidateSet: CandidateSet): Set<string> {
  return new Set([
    ...candidateSet.attractions.map((c) => c.placeId),
    ...candidateSet.restaurants.map((c) => c.placeId),
    ...candidateSet.shops.map((c) => c.placeId),
  ]);
}

function isDayPlanItem(value: unknown): value is DayPlanItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DayPlanItem).placeId === 'string' &&
    typeof (value as DayPlanItem).note === 'string'
  );
}

/**
 * The only module allowed to call an LLM (plan §6). Applies the
 * deterministic post-generation grounding validation from plan §7
 * before returning anything to a caller - every fact claim (here, a
 * referenced placeId) must resolve to something actually present in the
 * candidate set it was given, or it is rejected, never persisted.
 */
export class AiOrchestrationService {
  constructor(private readonly provider: LlmProvider) {}

  async generateDayPlan(
    candidateSet: CandidateSet,
    context: TripContext,
  ): Promise<DayPlanResult> {
    const userPrompt = buildUserPrompt(candidateSet, context);
    const { text } = await this.provider.generate(SYSTEM_PROMPT, userPrompt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('LLM response was not valid JSON');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as GeneratedDayPlan).summary !== 'string' ||
      !Array.isArray((parsed as GeneratedDayPlan).items)
    ) {
      throw new Error('LLM response did not match the expected schema');
    }

    const plan = parsed as GeneratedDayPlan;
    const validIds = allCandidateIds(candidateSet);
    const grounded: DayPlanItem[] = [];
    const rejected: DayPlanItem[] = [];

    for (const item of plan.items) {
      if (isDayPlanItem(item) && validIds.has(item.placeId)) {
        grounded.push(item);
      } else if (isDayPlanItem(item)) {
        rejected.push(item);
      }
      // A structurally invalid item (not even a well-formed DayPlanItem)
      // is silently dropped rather than rejected-and-reported - it never
      // carried a factual claim to catch in the first place.
    }

    return {
      plan: { summary: plan.summary, items: grounded },
      rejectedItems: rejected,
    };
  }
}
