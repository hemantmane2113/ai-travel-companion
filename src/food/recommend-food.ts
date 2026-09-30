import type { Pool } from 'pg';
import { queryPlacesByCategory, type PlaceSource } from '../places/query-places';
import type { LatLng } from '../geo';

export interface FoodRecommendation {
  placeId: string;
  factVersionId: string;
  name: string;
  cuisine: string | null;
  latitude: number;
  longitude: number;
  distanceFromCenterKm: number;
  source: PlaceSource;
}

export interface FoodRecommendationFilters {
  /** Case-insensitive substring match against the OSM `cuisine` tag. */
  cuisine?: string;
}

const DEFAULT_LIMIT = 10;

function extractCuisine(rawValue: Record<string, unknown>): string | null {
  const value = rawValue.cuisine;
  return typeof value === 'string' ? value : null;
}

/**
 * Food (plan §3/§9): a thin filtering view over Places - no new
 * provider integration, no new ingestion pipeline. Rides on the same
 * `places` rows and provenance the Places ingestion pipeline already
 * wrote, via the shared queryPlacesByCategory read path.
 */
export async function recommendFood(
  pool: Pool,
  destination: string,
  center: LatLng,
  filters: FoodRecommendationFilters = {},
): Promise<FoodRecommendation[]> {
  const records = await queryPlacesByCategory(pool, destination, 'restaurant', center);

  let recommendations: FoodRecommendation[] = records.map((record) => ({
    placeId: record.placeId,
    factVersionId: record.factVersionId,
    name: record.name,
    cuisine: extractCuisine(record.rawValue),
    latitude: record.latitude,
    longitude: record.longitude,
    distanceFromCenterKm: record.distanceFromCenterKm,
    source: record.source,
  }));

  if (filters.cuisine) {
    const wanted = filters.cuisine.toLowerCase();
    recommendations = recommendations.filter((r) => r.cuisine?.toLowerCase().includes(wanted));
  }

  recommendations.sort((a, b) => a.distanceFromCenterKm - b.distanceFromCenterKm);
  return recommendations.slice(0, DEFAULT_LIMIT);
}
