import type { Pool } from 'pg';
import type { LatLng } from '../geo';
import { haversineDistanceKm } from '../geo';
import type { Candidate, CandidateSet } from './candidate-set';

export interface AmbiguousMustVisit {
  name: string;
  matches: Candidate[];
}

export interface MustVisitResolution {
  resolved: Candidate[];
  /** A name that matched no place in the destination - must never be silently dropped. */
  unresolved: string[];
  /** A name that matched more than one place in the destination - never guessed. */
  ambiguous: AmbiguousMustVisit[];
}

async function queryPlacesByName(
  pool: Pool,
  destination: string,
  name: string,
  center: LatLng,
): Promise<Candidate[]> {
  const rows = await pool.query(
    `select p.id as place_id, p.name, p.category,
            ST_Y(p.location::geometry) as latitude, ST_X(p.location::geometry) as longitude,
            fv.id as fact_version_id
     from places p
     join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
     join fact_versions fv on fv.id = f.current_version_id
     where p.destination = $1 and lower(p.name) = lower($2)`,
    [destination, name],
  );

  return rows.rows.map((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    return {
      placeId: row.place_id,
      factVersionId: row.fact_version_id,
      name: row.name,
      category: row.category,
      latitude,
      longitude,
      distanceFromCenterKm: haversineDistanceKm(center, { latitude, longitude }),
    };
  });
}

/**
 * Resolves must-visit references to real places (Phase 3 must-visit
 * functionality): deterministic exact-name (case-insensitive) matching
 * only - no LLM, no fuzzy matching, no guessing. A name matching nothing
 * is "unresolved"; a name matching more than one place in the
 * destination is "ambiguous". Both are hard stops the caller must
 * surface to the user, never silently drop or arbitrarily pick one of.
 * Free-text extraction of these names out of a sentence is explicitly
 * NOT this function's job - see Phase 3 Findings/Future Work.
 */
export async function resolveMustVisitPlaces(
  pool: Pool,
  destination: string,
  names: string[],
  center: LatLng,
): Promise<MustVisitResolution> {
  const resolved: Candidate[] = [];
  const unresolved: string[] = [];
  const ambiguous: AmbiguousMustVisit[] = [];

  for (const name of names) {
    const matches = await queryPlacesByName(pool, destination, name, center);
    if (matches.length === 0) {
      unresolved.push(name);
    } else if (matches.length > 1) {
      ambiguous.push({ name, matches });
    } else {
      resolved.push(matches[0]);
    }
  }

  return { resolved, unresolved, ambiguous };
}

/**
 * Ensures every resolved must-visit candidate is present in the
 * candidate set handed to the LLM, even if buildCandidateSet's
 * per-category proximity cap would otherwise have excluded it - a
 * must-visit place must never be dropped from consideration just
 * because something closer to the destination center outranked it.
 * Does not mutate the input CandidateSet.
 */
export function mergeMustVisitCandidates(candidateSet: CandidateSet, mustVisit: Candidate[]): CandidateSet {
  const attractions = [...candidateSet.attractions];
  const restaurants = [...candidateSet.restaurants];
  const shops = [...candidateSet.shops];
  const byCategory = { attraction: attractions, restaurant: restaurants, shop: shops };

  for (const candidate of mustVisit) {
    const list = byCategory[candidate.category];
    if (!list.some((c) => c.placeId === candidate.placeId)) {
      list.push(candidate);
    }
  }

  return { ...candidateSet, attractions, restaurants, shops };
}

/**
 * Which must-visit candidates, if any, are absent from the final
 * grounded itinerary - the deterministic check that makes "must visit"
 * an enforced constraint rather than a hope. The LLM is never the
 * authority for whether this constraint was satisfied (rule 9); this
 * function is. Takes a minimal structural shape rather than importing
 * GeneratedItinerary, so Travel Intelligence stays free of any
 * dependency on the AI layer's types.
 */
export function findMissingMustVisitPlaces(
  itinerary: { days: Array<{ items: Array<{ itemType: string; placeId?: string }> }> },
  mustVisit: Candidate[],
): Candidate[] {
  const presentPlaceIds = new Set(
    itinerary.days
      .flatMap((day) => day.items)
      .filter((item) => item.itemType === 'place')
      .map((item) => item.placeId),
  );

  return mustVisit.filter((candidate) => !presentPlaceIds.has(candidate.placeId));
}
