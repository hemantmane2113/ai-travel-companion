import type { Pool } from 'pg';
import type { PlaceCategory } from '../providers/places-provider';
import { haversineDistanceKm, type LatLng } from '../geo';

export interface PlaceSource {
  name: string;
  url: string | null;
  licence: string | null;
}

export interface PlaceRecord {
  placeId: string;
  /** The exact fact_version this record was read from - carries the
   * provenance chain (plan §5) through to any caller. */
  factVersionId: string;
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  distanceFromCenterKm: number;
  /** The provider's raw tags/fields, as captured at ingestion time. */
  rawValue: Record<string, unknown>;
  source: PlaceSource;
}

/**
 * Shared read over already-ingested places + their current fact_version
 * + source. This is the one query every domain built on top of Places
 * (Travel Intelligence, Food, Shopping) shares - plan §9 calls out that
 * Food and Shopping "ride on the same ingestion pipeline at near-zero
 * marginal cost", which is only true if they also share the read path
 * rather than each re-deriving it. Reads only Postgres - never an
 * external API, never an LLM (plan §2's runtime path).
 */
export async function queryPlacesByCategory(
  pool: Pool,
  destination: string,
  category: PlaceCategory,
  center: LatLng,
): Promise<PlaceRecord[]> {
  const rows = await pool.query(
    `select p.id as place_id, p.name,
            ST_Y(p.location::geometry) as latitude, ST_X(p.location::geometry) as longitude,
            fv.id as fact_version_id, fv.value as raw_value,
            s.name as source_name, s.url as source_url, s.licence as source_licence
     from places p
     join facts f
       on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
     join fact_versions fv on fv.id = f.current_version_id
     join sources s on s.id = fv.source_id
     where p.destination = $1 and p.category = $2`,
    [destination, category],
  );

  return rows.rows.map((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    return {
      placeId: row.place_id,
      factVersionId: row.fact_version_id,
      name: row.name,
      category,
      latitude,
      longitude,
      distanceFromCenterKm: haversineDistanceKm(center, { latitude, longitude }),
      rawValue: row.raw_value,
      source: { name: row.source_name, url: row.source_url, licence: row.source_licence },
    };
  });
}
