import type { Pool } from 'pg';
import type { Candidate, CandidateSet } from '../travel-intelligence/candidate-set';
import type { DayPlanResult } from '../ai/ai-orchestration-service';

function findCandidate(candidateSet: CandidateSet, placeId: string): Candidate | undefined {
  return (
    candidateSet.attractions.find((c) => c.placeId === placeId) ??
    candidateSet.restaurants.find((c) => c.placeId === placeId) ??
    candidateSet.shops.find((c) => c.placeId === placeId)
  );
}

/**
 * Persists an already grounding-validated (plan §7) day plan. Every
 * item is tagged 'verified' with its exact referenced_fact_version_id
 * (plan §5) - this V1 slice only ever persists items the AI
 * Orchestration layer already confirmed trace back to a real ingested
 * fact. Free-floating 'ai_inference' items (narrative with no single
 * backing fact) are a later concern, not needed to prove this loop.
 */
export async function persistItinerary(
  pool: Pool,
  destination: string,
  interests: string[],
  dayPlanResult: DayPlanResult,
  candidateSet: CandidateSet,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itinerary = await client.query(
      `insert into itineraries (destination, interests) values ($1, $2) returning id`,
      [destination, interests],
    );
    const itineraryId = itinerary.rows[0].id as string;

    const day = await client.query(
      `insert into itinerary_days (itinerary_id, day_number, summary) values ($1, 1, $2) returning id`,
      [itineraryId, dayPlanResult.plan.summary],
    );
    const dayId = day.rows[0].id as string;

    let sortOrder = 0;
    for (const item of dayPlanResult.plan.items) {
      const candidate = findCandidate(candidateSet, item.placeId);
      if (!candidate) {
        // Unreachable in normal operation - AiOrchestrationService already
        // stripped anything not in the candidate set. Fail loudly rather
        // than silently persist an ungrounded item if this invariant is
        // ever violated by a future change.
        throw new Error(`Grounded item referenced an unknown placeId: ${item.placeId}`);
      }
      await client.query(
        `insert into itinerary_items
           (itinerary_day_id, place_id, note, referenced_fact_version_id, provenance_kind, sort_order)
         values ($1, $2, $3, $4, 'verified', $5)`,
        [dayId, candidate.placeId, item.note, candidate.factVersionId, sortOrder],
      );
      sortOrder += 1;
    }

    await client.query('COMMIT');
    return itineraryId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
