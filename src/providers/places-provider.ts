export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type PlaceCategory = 'attraction' | 'restaurant' | 'shop';

export interface NormalizedPlace {
  /** Provider-qualified id, e.g. "osm:node/123" - used for idempotent re-ingestion. */
  externalRef: string;
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  /** The provider's raw tags/fields, stored as the fact_version's value. */
  raw: Record<string, unknown>;
}

/**
 * Provider Abstraction (plan §8): the only shape the ingestion pipeline
 * is allowed to depend on. No domain or ingestion code may import an
 * OSM/OpenTripMap/etc. HTTP client directly - only an adapter that
 * implements this interface.
 */
export interface PlacesProvider {
  readonly sourceName: string;
  search(bbox: BoundingBox): Promise<NormalizedPlace[]>;
}
