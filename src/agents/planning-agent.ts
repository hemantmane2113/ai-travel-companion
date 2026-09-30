import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { DESTINATIONS } from '../destinations';
import { createItineraryJob, runItineraryJob, type GenerateItineraryInput } from '../itinerary/generate-itinerary';
import { resolveMustVisitPlaces } from '../travel-intelligence/must-visit';

export interface PlanTripInput {
  destinationSlug: string;
  interests: string[];
  startDate: string;
  endDate: string;
  /** Free-text place names the traveler explicitly wants included. Resolved deterministically here - never trusted from the LLM. */
  mustVisit?: string[];
}

/**
 * The Phase 3 Planning Agent (docs/architecture-v2-agent-companion.md
 * §C/§D): the architectural owner of itinerary planning. Deliberately a
 * thin wrapper around the EXISTING, unmodified job pipeline
 * (itinerary/generate-itinerary.ts) rather than a rewrite - the only new
 * responsibility this phase adds is must-visit resolution, applied
 * BEFORE the existing pipeline ever runs.
 *
 * Flow: must-visit references (already extracted by the caller - see
 * Phase 3 Findings/Future Work) -> resolved against known places HERE,
 * deterministically -> real placeId candidates -> passed into the
 * existing pipeline, which merges them into Travel Intelligence's
 * candidate set, calls the unchanged Planning LLM
 * (AiOrchestrationService), and applies deterministic validation
 * (existing grounding check, plus the must-visit presence check) before
 * persisting. This module never calls a provider, never reasons about
 * travel itself, and never talks to the LLM directly.
 */
export async function planTrip(
  pool: Pool,
  llmProvider: LlmProvider,
  input: PlanTripInput,
): Promise<{ jobId: string }> {
  const jobInput: GenerateItineraryInput = {
    destinationSlug: input.destinationSlug,
    interests: input.interests,
    startDate: input.startDate,
    endDate: input.endDate,
  };

  if (input.mustVisit && input.mustVisit.length > 0) {
    const destination = DESTINATIONS[input.destinationSlug];
    if (!destination) {
      throw new Error(`Unknown destination: ${input.destinationSlug}`);
    }

    const resolution = await resolveMustVisitPlaces(pool, destination.slug, input.mustVisit, destination.center);

    // A must-visit place that can't be resolved, or resolves ambiguously,
    // must never silently disappear or be guessed at - fail clearly,
    // before any job row is created (mirrors the existing
    // unknown-destination/invalid-date-range pattern).
    if (resolution.unresolved.length > 0 || resolution.ambiguous.length > 0) {
      const parts: string[] = [];
      if (resolution.unresolved.length > 0) {
        parts.push(`I couldn't find these place(s) in ${destination.name}: ${resolution.unresolved.join(', ')}.`);
      }
      for (const { name, matches } of resolution.ambiguous) {
        parts.push(
          `"${name}" matches more than one place in ${destination.name} (${matches.map((m) => m.name).join(', ')}) - please be more specific.`,
        );
      }
      throw new Error(parts.join(' '));
    }

    jobInput.mustVisitCandidates = resolution.resolved;
  }

  const jobId = await createItineraryJob(pool, jobInput);
  // Fire-and-forget, exactly like the existing pipeline's own callers -
  // failure is always recorded on the job row by runItineraryJob before
  // it rethrows.
  void runItineraryJob(pool, llmProvider, jobId, jobInput).catch(() => {});

  return { jobId };
}
