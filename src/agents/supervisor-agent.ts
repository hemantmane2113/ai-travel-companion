import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { planTrip } from './planning-agent';
import { answerQuestion } from '../companion/answer-question';
import { appendMessage, createConversation, requireConversation } from '../companion/conversations';

export interface CompanionInput {
  message: string;
  conversationId?: string;
  destinationSlug?: string;
  interests?: string[];
  startDate?: string;
  endDate?: string;
  /** Free-text must-visit place names (Phase 3) - resolved deterministically by the Planning Agent, never guessed here. */
  mustVisit?: string[];
}

export type CompanionResult =
  | { route: 'full_trip'; conversationId: string; jobId: string }
  | { route: 'qa'; conversationId: string; answer: string };

/**
 * The Supervisor Agent (docs/architecture-v2-agent-companion.md §C):
 * a deterministic-first router with exactly two routes. Routing is
 * decided purely by whether the request actually supplies the
 * structured fields the Planning Agent requires (destinationSlug +
 * startDate + endDate) - not by fuzzy keyword or LLM classification of
 * the message text, which stays out of scope until a later phase. No
 * LLM call is made to decide the route; the Q&A route makes no LLM call
 * at all.
 *
 * This module intentionally does no travel reasoning of its own and
 * never calls a provider directly - it selects a capability (Planning
 * Agent, or the Q&A tool) and dispatches to it, nothing more. Adding a
 * future capability (Comparison, Booking, ...) means adding another
 * branch here that calls that capability's own entry point - it does
 * not require rewriting this dispatch shape.
 *
 * Route A ("full trip"): delegates to the Planning Agent, which owns
 * the existing itinerary pipeline (same grounding, same persistence,
 * same async job lifecycle as POST /itineraries today) plus must-visit
 * resolution (Phase 3).
 * Route B ("everything else"): the existing Q&A capability - answers
 * from existing deterministic reads only, creates no itinerary and no
 * task.
 */
export async function routeMessage(
  pool: Pool,
  llmProvider: LlmProvider,
  input: CompanionInput,
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

  const { text, matchedDestinationSlug } = await answerQuestion(pool, input.message);
  await appendMessage(pool, conversationId, 'assistant', text, { route: 'qa', matchedDestinationSlug });

  return { route: 'qa', conversationId, answer: text };
}
