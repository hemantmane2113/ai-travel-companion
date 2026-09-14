import type { Pool } from 'pg';
import type { PlaceCategory } from '../providers/places-provider';
import { queryPlacesByCategory } from '../places/query-places';
import type { LatLng } from '../geo';

export interface Candidate {
  placeId: string;
  /** The exact fact_version this candidate was read from - carried through
   * so the AI layer can only ever cite evidence that was actually given
   * to it (plan §5/§7's grounding chain). */
  factVersionId: string;
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  distanceFromCenterKm: number;
}

export interface CandidateSet {
  destination: string;
  attractions: Candidate[];
  restaurants: Candidate[];
  shops: Candidate[];
}

// Context-window discipline (plan §7): cap candidate lists rather than
// sending every ingested place to the model.
const CATEGORY_LIMITS: Record<PlaceCategory, number> = {
  attraction: 8,
  restaurant: 6,
  shop: 4,
};

async function rankedCandidates(
  pool: Pool,
  destination: string,
  category: PlaceCategory,
  center: LatLng,
): Promise<Candidate[]> {
  const records = await queryPlacesByCategory(pool, destination, category, center);
  return records
    .map(({ placeId, factVersionId, name, latitude, longitude, distanceFromCenterKm }) => ({
      placeId,
      factVersionId,
      name,
      category,
      latitude,
      longitude,
      distanceFromCenterKm,
    }))
    .sort((a, b) => a.distanceFromCenterKm - b.distanceFromCenterKm)
    .slice(0, CATEGORY_LIMITS[category]);
}

/**
 * The deterministic half of the Travel Intelligence Engine (plan §5/§7):
 * filters already-ingested places by destination/category and ranks by
 * proximity to the destination's reference center. Pure code cannot
 * hallucinate; it can only misapply a rule, so this stays simple and is
 * exhaustively unit/integration-tested.
 */
export async function buildCandidateSet(
  pool: Pool,
  destination: string,
  center: LatLng,
): Promise<CandidateSet> {
  const [attractions, restaurants, shops] = await Promise.all([
    rankedCandidates(pool, destination, 'attraction', center),
    rankedCandidates(pool, destination, 'restaurant', center),
    rankedCandidates(pool, destination, 'shop', center),
  ]);

  return { destination, attractions, restaurants, shops };
}
