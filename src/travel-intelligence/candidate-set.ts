import type { Pool } from 'pg';
import type { PlaceCategory } from '../providers/places-provider';
import { haversineDistanceKm, type LatLng } from '../geo';

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

const EMPTY_BY_CATEGORY: Record<PlaceCategory, Candidate[]> = {
  attraction: [],
  restaurant: [],
  shop: [],
};

/**
 * The deterministic half of the Travel Intelligence Engine (plan §5/§7):
 * filters already-ingested places by destination/category and ranks by
 * proximity to the destination's reference center. Reads only from
 * Postgres - never an external API, never an LLM (plan §2's runtime
 * path). Pure code cannot hallucinate; it can only misapply a rule, so
 * this stays simple and is exhaustively unit/integration-tested.
 */
export async function buildCandidateSet(
  pool: Pool,
  destination: string,
  center: LatLng,
): Promise<CandidateSet> {
  const rows = await pool.query(
    `select p.id as place_id, p.name, p.category,
            ST_Y(p.location::geometry) as latitude, ST_X(p.location::geometry) as longitude,
            f.current_version_id as fact_version_id
     from places p
     join facts f
       on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
     where p.destination = $1 and f.current_version_id is not null`,
    [destination],
  );

  const byCategory: Record<PlaceCategory, Candidate[]> = {
    attraction: [...EMPTY_BY_CATEGORY.attraction],
    restaurant: [...EMPTY_BY_CATEGORY.restaurant],
    shop: [...EMPTY_BY_CATEGORY.shop],
  };

  for (const row of rows.rows) {
    const category = row.category as PlaceCategory;
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    byCategory[category].push({
      placeId: row.place_id,
      factVersionId: row.fact_version_id,
      name: row.name,
      category,
      latitude,
      longitude,
      distanceFromCenterKm: haversineDistanceKm(center, { latitude, longitude }),
    });
  }

  for (const category of Object.keys(byCategory) as PlaceCategory[]) {
    byCategory[category].sort((a, b) => a.distanceFromCenterKm - b.distanceFromCenterKm);
    byCategory[category] = byCategory[category].slice(0, CATEGORY_LIMITS[category]);
  }

  return {
    destination,
    attractions: byCategory.attraction,
    restaurants: byCategory.restaurant,
    shops: byCategory.shop,
  };
}
