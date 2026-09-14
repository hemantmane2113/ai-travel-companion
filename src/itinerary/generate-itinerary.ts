import type { Pool } from 'pg';
import { DESTINATIONS, type Destination } from '../destinations';
import { buildCandidateSet } from '../travel-intelligence/candidate-set';
import { AiOrchestrationService } from '../ai/ai-orchestration-service';
import type { LlmProvider } from '../ai/llm-provider';
import type { DayPlanItem } from '../ai/day-plan';
import { createJob, markJobComplete, markJobFailed, markJobProcessing } from './jobs';
import { persistItinerary } from './persist-itinerary';

export interface GenerateItineraryInput {
  destinationSlug: string;
  interests: string[];
}

export interface GenerateItineraryResult {
  jobId: string;
  itineraryId: string;
  rejectedItems: DayPlanItem[];
}

function resolveDestination(destinationSlug: string): Destination {
  const destination = DESTINATIONS[destinationSlug];
  if (!destination) {
    throw new Error(`Unknown destination: ${destinationSlug}`);
  }
  return destination;
}

/**
 * Creates the job row and returns its id immediately - the HTTP layer
 * uses this to answer 202 Accepted without waiting for generation (plan
 * §9 step 3). Validates the destination up front so an unknown
 * destination never creates a job at all.
 */
export async function createItineraryJob(pool: Pool, input: GenerateItineraryInput): Promise<string> {
  resolveDestination(input.destinationSlug);
  return createJob(pool, input.destinationSlug, input.interests);
}

/**
 * Runs an already-created job to completion: Travel Intelligence ->
 * AI Orchestration (with grounding validation) -> persistence ->
 * job completion. Safe to call without awaiting it to completion (the
 * HTTP layer does exactly that) - failure is always recorded on the
 * job row before the error is rethrown, so a caller that doesn't await
 * this can still observe the outcome via the job's status.
 */
export async function runItineraryJob(
  pool: Pool,
  llmProvider: LlmProvider,
  jobId: string,
  input: GenerateItineraryInput,
): Promise<{ itineraryId: string; rejectedItems: DayPlanItem[] }> {
  const destination = resolveDestination(input.destinationSlug);

  try {
    await markJobProcessing(pool, jobId);

    const candidateSet = await buildCandidateSet(pool, destination.slug, destination.center);
    const aiService = new AiOrchestrationService(llmProvider);
    const dayPlanResult = await aiService.generateDayPlan(candidateSet, {
      destination: destination.slug,
      interests: input.interests,
    });

    const itineraryId = await persistItinerary(
      pool,
      destination.slug,
      input.interests,
      dayPlanResult,
      candidateSet,
    );

    await markJobComplete(pool, jobId, itineraryId, dayPlanResult.rejectedItems);

    return { itineraryId, rejectedItems: dayPlanResult.rejectedItems };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJobFailed(pool, jobId, message);
    throw err;
  }
}

/**
 * Ties Travel Intelligence and AI Orchestration into the itinerary job
 * lifecycle end to end (plan §9), waiting for the full result - used by
 * the CLI/tests/anywhere synchronous completion is actually wanted. The
 * HTTP layer instead calls createItineraryJob + runItineraryJob
 * separately so it can return 202 immediately (see src/http).
 */
export async function generateItinerary(
  pool: Pool,
  llmProvider: LlmProvider,
  input: GenerateItineraryInput,
): Promise<GenerateItineraryResult> {
  const jobId = await createItineraryJob(pool, input);
  const { itineraryId, rejectedItems } = await runItineraryJob(pool, llmProvider, jobId, input);
  return { jobId, itineraryId, rejectedItems };
}
