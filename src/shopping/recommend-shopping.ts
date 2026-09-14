import type { Pool } from 'pg';
import { queryPlacesByCategory, type PlaceSource } from '../places/query-places';
import type { LatLng } from '../geo';

export interface ShoppingRecommendation {
  placeId: string;
  factVersionId: string;
  name: string;
  shopType: string | null;
  latitude: number;
  longitude: number;
  distanceFromCenterKm: number;
  source: PlaceSource;
}

export interface ShoppingRecommendationFilters {
  /** Case-insensitive substring match against the OSM `shop` tag (e.g. "clothes", "textiles"). */
  shopType?: string;
}

const DEFAULT_LIMIT = 10;

function extractShopType(rawValue: Record<string, unknown>): string | null {
  const value = rawValue.shop;
  return typeof value === 'string' ? value : null;
}

/**
 * Shopping (plan §3/§9): a thin filtering view over Places, mirroring
 * Food - same shared read path, no new provider integration. Rides on
 * the Places ingestion pipeline's existing `shop` rows.
 */
export async function recommendShopping(
  pool: Pool,
  destination: string,
  center: LatLng,
  filters: ShoppingRecommendationFilters = {},
): Promise<ShoppingRecommendation[]> {
  const records = await queryPlacesByCategory(pool, destination, 'shop', center);

  let recommendations: ShoppingRecommendation[] = records.map((record) => ({
    placeId: record.placeId,
    factVersionId: record.factVersionId,
    name: record.name,
    shopType: extractShopType(record.rawValue),
    latitude: record.latitude,
    longitude: record.longitude,
    distanceFromCenterKm: record.distanceFromCenterKm,
    source: record.source,
  }));

  if (filters.shopType) {
    const wanted = filters.shopType.toLowerCase();
    recommendations = recommendations.filter((r) => r.shopType?.toLowerCase().includes(wanted));
  }

  recommendations.sort((a, b) => a.distanceFromCenterKm - b.distanceFromCenterKm);
  return recommendations.slice(0, DEFAULT_LIMIT);
}
