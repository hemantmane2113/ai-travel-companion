import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import type { HotelProvider } from '../providers/hotel-provider';
import { planTrip } from './planning-agent';
import { runComparison, type ComparisonTaskResult, type Domain } from './comparison-agent';
import { parseOrdinal } from './ordinal-resolution';
import { answerQuestion } from '../companion/answer-question';
import { appendMessage, createConversation, requireConversation } from '../companion/conversations';
import { getLatestTaskForConversation } from '../tasks/tasks';

export interface CompanionInput {
  message: string;
  conversationId?: string;
  destinationSlug?: string;
  interests?: string[];
  startDate?: string;
  endDate?: string;
  /** Free-text must-visit place names (Phase 3) - resolved deterministically by the Planning Agent, never guessed here. */
  mustVisit?: string[];
  /** Structured hotel-comparison trigger (Phase 4) - presence alone routes to the Comparison Agent; no NLP extraction of the location from `message`. */
  hotelSearchLocation?: string;
}

export type CompanionResult =
  | { route: 'full_trip'; conversationId: string; jobId: string }
  | { route: 'qa'; conversationId: string; answer: string }
  | { route: 'comparison'; conversationId: string; taskId: string; result: ComparisonTaskResult }
  | {
      route: 'ordinal_selection';
      conversationId: string;
      selectedOfferId: string;
      provider: string;
      domain: Domain;
    };

/**
 * Resolves "the second one" (V2 architecture Phase 4 §J) against the
 * conversation's most recent COMPLETE comparison task - never a fresh
 * provider search, never LLM memory. Intentionally the smallest
 * possible mechanism: exact ordinal parse (src/agents/ordinal-resolution.ts)
 * -> exact array-index lookup into the persisted `tasks.result.offers`.
 * Ambiguity, an out-of-range ordinal, or no open comparison task all
 * throw a plain Error rather than guessing - same clarify-don't-guess
 * posture Phase 3's must-visit resolution already established, and the
 * same "throw, let the HTTP layer translate to 400" pattern.
 */
async function resolveOrdinalSelection(
  pool: Pool,
  conversationId: string,
  ordinalIndex: number,
): Promise<Extract<CompanionResult, { route: 'ordinal_selection' }>> {
  const task = await getLatestTaskForConversation(pool, conversationId, 'comparison');
  if (!task || task.status !== 'complete' || !task.result) {
    throw new Error(
      "I don't have a completed hotel comparison in this conversation to select from - try comparing hotels first.",
    );
  }

  const result = task.result as unknown as ComparisonTaskResult;
  if (ordinalIndex >= result.offers.length) {
    throw new Error(
      `There is no option #${ordinalIndex + 1} in the last comparison - it only had ${result.offers.length} offer(s).`,
    );
  }

  const offer = result.offers[ordinalIndex];
  return {
    route: 'ordinal_selection',
    conversationId,
    selectedOfferId: offer.offerId,
    provider: offer.provider,
    domain: offer.domain,
  };
}

/**
 * The Supervisor Agent (docs/architecture-v2-agent-companion.md §C):
 * a deterministic-first router. Routing is decided purely by structured
 * signals - field presence for full-trip/comparison, an exact ordinal
 * pattern for a follow-up selection - never fuzzy keyword or LLM
 * classification of the message text (still out of scope, per plan §G's
 * hybrid router: deterministic first, LLM fallback only for genuine
 * ambiguity, not yet needed while every route has an unambiguous
 * structured signal).
 *
 * This module intentionally does no travel/comparison reasoning of its
 * own and never calls a provider directly - it selects a capability
 * (Planning Agent, Comparison Agent, ordinal resolution, or the Q&A
 * tool) and dispatches to it, nothing more.
 *
 * Route priority: full trip > hotel comparison > ordinal follow-up > Q&A.
 * The first three are structured/pattern signals checked in that fixed
 * order; Q&A is the default when none matches.
 */
export async function routeMessage(
  pool: Pool,
  llmProvider: LlmProvider,
  input: CompanionInput,
  /** Injectable for testability - see comparison-agent.ts's RunComparisonInput.providers. Omit to use the Comparison Agent's own default (the mock provider). */
  hotelProviders?: HotelProvider[],
): Promise<CompanionResult> {
  const conversationId = input.conversationId
    ? await requireConversation(pool, input.conversationId)
    : await createConversation(pool);

  await appendMessage(pool, conversationId, 'user', input.message);

  const isFullTripRequest = Boolean(input.destinationSlug && input.startDate && input.endDate);

  if (isFullTripRequest) {
    const { jobId } = await planTrip(pool, llmProvider, {
      destinationSlug: input.destinationSlug!,
      interests: input.interests ?? [],
      startDate: input.startDate!,
      endDate: input.endDate!,
      mustVisit: input.mustVisit,
    });

    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `I'm planning your trip now - check job ${jobId} for progress.`,
      { route: 'full_trip', jobId },
    );

    return { route: 'full_trip', conversationId, jobId };
  }

  const isComparisonRequest = Boolean(input.hotelSearchLocation);

  if (isComparisonRequest) {
    const { taskId, result } = await runComparison(pool, llmProvider, {
      domains: ['hotel'],
      location: input.hotelSearchLocation!,
      conversationId,
      providers: hotelProviders,
    });

    await appendMessage(pool, conversationId, 'assistant', result.narrative, { route: 'comparison', taskId });

    return { route: 'comparison', conversationId, taskId, result };
  }

  const ordinalParse = parseOrdinal(input.message);

  if (ordinalParse.kind === 'ambiguous') {
    throw new Error('I\'m not sure which option you mean - please refer to just one, like "the second one".');
  }

  if (ordinalParse.kind === 'resolved') {
    const selection = await resolveOrdinalSelection(pool, conversationId, ordinalParse.index);
    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `Got it - you selected ${selection.provider}'s offer (${selection.selectedOfferId}).`,
      { route: 'ordinal_selection', selectedOfferId: selection.selectedOfferId },
    );
    return selection;
  }

  const { text, matchedDestinationSlug } = await answerQuestion(pool, input.message);
  await appendMessage(pool, conversationId, 'assistant', text, { route: 'qa', matchedDestinationSlug });

  return { route: 'qa', conversationId, answer: text };
}
