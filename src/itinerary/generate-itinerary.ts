import type { Pool } from 'pg';
import { DESTINATIONS } from '../destinations';
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

/**
 * Ties Travel Intelligence and AI Orchestration into the itinerary job
 * lifecycle (plan §9's request -> ... -> completion flow). Modeled here
 * as a direct async call rather than a real queue: BullMQ/Redis is
 * deferred until there's an HTTP layer that actually needs to return
 * 202 immediately (plan §8's Phase 0 table) - the itinerary_jobs table
 * already carries the status states a queue worker would update, so
 * wiring a real queue later doesn't change this function's contract.
 */
export async function generateItinerary(
  pool: Pool,
  llmProvider: LlmProvider,
  input: GenerateItineraryInput,
): Promise<GenerateItineraryResult> {
  const destination = DESTINATIONS[input.destinationSlug];
  if (!destination) {
    throw new Error(`Unknown destination: ${input.destinationSlug}`);
  }

  const jobId = await createJob(pool, input.destinationSlug, input.interests);

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

    return { jobId, itineraryId, rejectedItems: dayPlanResult.rejectedItems };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJobFailed(pool, jobId, message);
    throw err;
  }
}
