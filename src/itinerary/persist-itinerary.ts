import type { Pool } from 'pg';
import type { Candidate, CandidateSet } from '../travel-intelligence/candidate-set';
import type { WarningCandidate } from '../travel-intelligence/warning-candidates';
import type { ItineraryResult } from '../ai/ai-orchestration-service';
import type { GeneratedItineraryItem } from '../ai/itinerary-plan';

export interface PersistItineraryInput {
  destination: string;
  interests: string[];
  startDate: string;
  endDate: string;
}

function findPlaceCandidate(candidateSet: CandidateSet, placeId: string): Candidate | undefined {
  return (
    candidateSet.attractions.find((c) => c.placeId === placeId) ??
    candidateSet.restaurants.find((c) => c.placeId === placeId) ??
    candidateSet.shops.find((c) => c.placeId === placeId)
  );
}

function findWarningCandidate(
  candidateSet: CandidateSet,
  factVersionId: string,
): WarningCandidate | undefined {
  return candidateSet.warnings.find((w) => w.factVersionId === factVersionId);
}

/**
 * Resolves the (placeId | null, fact_version_id) an already-validated
 * item persists as. AiOrchestrationService guarantees factReferences
 * only ever contains ids it was actually supplied, and for a 'place'
 * item that the place's own fact_version is among them - so lookups
 * here cannot fail in normal operation. They still throw loudly rather
 * than silently persisting something ungrounded if that invariant is
 * ever violated by a future change (same posture as before this task).
 */
function resolvePersistedFact(
  candidateSet: CandidateSet,
  item: GeneratedItineraryItem,
): { placeId: string | null; factVersionId: string } {
  if (item.itemType === 'place') {
    const place = item.placeId ? findPlaceCandidate(candidateSet, item.placeId) : undefined;
    if (!place) {
      throw new Error(`Grounded place item referenced an unknown placeId: ${item.placeId}`);
    }
    return { placeId: place.placeId, factVersionId: place.factVersionId };
  }

  const warning = findWarningCandidate(candidateSet, item.factReferences[0]);
  if (!warning) {
    throw new Error(
      `Grounded warning item referenced an unknown fact_version: ${item.factReferences[0]}`,
    );
  }
  return { placeId: null, factVersionId: warning.factVersionId };
}

/**
 * Persists an already grounding-validated (plan §7, strengthened by
 * stabilization P0-3) multi-day itinerary. Every item is tagged
 * 'verified' with its exact referenced_fact_version_id (plan §5) and
 * an item_type distinguishing a place recommendation from a warning
 * (stabilization P0-2) - both trace to a real fact_version, so what
 * differs is the kind of entity, not whether it's verified.
 */
export async function persistItinerary(
  pool: Pool,
  input: PersistItineraryInput,
  itineraryResult: ItineraryResult,
  candidateSet: CandidateSet,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itinerary = await client.query(
      `insert into itineraries (destination, interests, start_date, end_date)
       values ($1, $2, $3, $4) returning id`,
      [input.destination, input.interests, input.startDate, input.endDate],
    );
    const itineraryId = itinerary.rows[0].id as string;

    for (const day of itineraryResult.itinerary.days) {
      const dayRow = await client.query(
        `insert into itinerary_days (itinerary_id, day_number, summary) values ($1, $2, $3) returning id`,
        [itineraryId, day.dayNumber, day.summary],
      );
      const dayId = dayRow.rows[0].id as string;

      let sortOrder = 0;
      for (const item of day.items) {
        const { placeId, factVersionId } = resolvePersistedFact(candidateSet, item);
        await client.query(
          `insert into itinerary_items
             (itinerary_day_id, place_id, note, referenced_fact_version_id, provenance_kind, item_type, sort_order)
           values ($1, $2, $3, $4, 'verified', $5, $6)`,
          [dayId, placeId, item.reason, factVersionId, item.itemType, sortOrder],
        );
        sortOrder += 1;
      }
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
