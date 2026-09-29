import type { Pool } from 'pg';
import { DESTINATIONS, type Destination } from '../destinations';
import { buildCandidateSet, type Candidate } from '../travel-intelligence/candidate-set';
import { mergeMustVisitCandidates, findMissingMustVisitPlaces } from '../travel-intelligence/must-visit';
import { AiOrchestrationService } from '../ai/ai-orchestration-service';
import type { LlmProvider } from '../ai/llm-provider';
import type { GeneratedItineraryItem } from '../ai/itinerary-plan';
import { parseTripDuration } from './trip-dates';
import { createJob, markJobComplete, markJobFailed, markJobProcessing } from './jobs';
import { persistItinerary } from './persist-itinerary';

export interface GenerateItineraryInput {
  destinationSlug: string;
  interests: string[];
  startDate: string;
  endDate: string;
  /**
   * Already-resolved must-visit candidates (Phase 3) - resolution
   * itself (free-text name -> real place, rejecting unresolved/ambiguous
   * references) happens upstream in the Planning Agent, never here. This
   * module's only responsibility for them is (a) guaranteeing they're
   * offered to the LLM regardless of the candidate-set proximity cap,
   * and (b) failing loudly if the generated result omits one - it never
   * silently drops a must-visit place.
   */
  mustVisitCandidates?: Candidate[];
}

export interface GenerateItineraryResult {
  jobId: string;
  itineraryId: string;
  rejectedItems: GeneratedItineraryItem[];
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
 * §9 step 3). Validates the destination and trip date range up front so
 * bad input never creates a job at all (stabilization P0-4).
 */
export async function createItineraryJob(pool: Pool, input: GenerateItineraryInput): Promise<string> {
  resolveDestination(input.destinationSlug);
  parseTripDuration(input.startDate, input.endDate);
  return createJob(pool, input.destinationSlug, input.interests, input.startDate, input.endDate);
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
): Promise<{ itineraryId: string; rejectedItems: GeneratedItineraryItem[] }> {
  const destination = resolveDestination(input.destinationSlug);
  const { numberOfDays } = parseTripDuration(input.startDate, input.endDate);

  try {
    await markJobProcessing(pool, jobId);

    const baseCandidateSet = await buildCandidateSet(pool, destination.slug, destination.center);
    const mustVisit = input.mustVisitCandidates ?? [];
    const candidateSet = mustVisit.length > 0 ? mergeMustVisitCandidates(baseCandidateSet, mustVisit) : baseCandidateSet;

    const aiService = new AiOrchestrationService(llmProvider);
    const itineraryResult = await aiService.generateItinerary(candidateSet, {
      destination: destination.slug,
      interests: input.interests,
      numberOfDays,
    });

    if (mustVisit.length > 0) {
      const missing = findMissingMustVisitPlaces(itineraryResult.itinerary, mustVisit);
      if (missing.length > 0) {
        throw new Error(
          `The generated itinerary did not include required must-visit place(s): ${missing.map((c) => c.name).join(', ')}`,
        );
      }
    }

    const itineraryId = await persistItinerary(
      pool,
      {
        destination: destination.slug,
        interests: input.interests,
        startDate: input.startDate,
        endDate: input.endDate,
      },
      itineraryResult,
      candidateSet,
    );

    await markJobComplete(pool, jobId, itineraryId, itineraryResult.rejectedItems);

    return { itineraryId, rejectedItems: itineraryResult.rejectedItems };
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
