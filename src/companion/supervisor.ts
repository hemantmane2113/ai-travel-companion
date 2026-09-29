import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { createItineraryJob, runItineraryJob } from '../itinerary/generate-itinerary';
import { answerQuestion } from './answer-question';
import { appendMessage, createConversation, requireConversation } from './conversations';

export interface CompanionInput {
  message: string;
  conversationId?: string;
  destinationSlug?: string;
  interests?: string[];
  startDate?: string;
  endDate?: string;
}

export type CompanionResult =
  | { route: 'full_trip'; conversationId: string; jobId: string }
  | { route: 'qa'; conversationId: string; answer: string };

/**
 * The Phase 2 Supervisor (docs/architecture-v2-agent-companion.md §N
 * Phase 2): a deterministic-first router with exactly two routes.
 * Routing is decided purely by whether the request actually supplies
 * the structured fields the existing itinerary pipeline requires
 * (destinationSlug + startDate + endDate) - not by fuzzy keyword or LLM
 * classification of the message text, which stays out of scope until a
 * later phase. No LLM call is made to decide the route; the Q&A route
 * below makes no LLM call at all.
 *
 * Route A ("full trip"): delegates to the EXISTING, unmodified
 * createItineraryJob/runItineraryJob pipeline - same grounding, same
 * persistence, same async job lifecycle as POST /itineraries today.
 * Route B ("everything else"): the new Q&A capability - answers from
 * existing deterministic reads only, creates no itinerary and no task.
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
    const jobInput = {
      destinationSlug: input.destinationSlug!,
      interests: input.interests ?? [],
      startDate: input.startDate!,
      endDate: input.endDate!,
    };

    const jobId = await createItineraryJob(pool, jobInput);
    // Fire-and-forget, exactly like ItinerariesController.create - the
    // failure is always recorded on the job row by runItineraryJob
    // before it rethrows, so this .catch() only stops that rethrow from
    // becoming an unhandled promise rejection.
    void runItineraryJob(pool, llmProvider, jobId, jobInput).catch(() => {});

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
