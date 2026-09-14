import type {
  BoundingBox,
  NormalizedPlace,
  PlaceCategory,
  PlacesProvider,
} from './places-provider';

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

interface OsmTags {
  name?: string;
  tourism?: string;
  amenity?: string;
  shop?: string;
  [key: string]: string | undefined;
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
}

interface OverpassResponse {
  elements: OsmElement[];
}

const ATTRACTION_TOURISM_VALUES = new Set([
  'attraction',
  'museum',
  'gallery',
  'viewpoint',
  'artwork',
  'zoo',
  'theme_park',
]);
const RESTAURANT_AMENITY_VALUES = new Set(['restaurant', 'cafe', 'fast_food']);

/**
 * Pure normalization - external schema -> NormalizedPlace. Kept separate
 * from the network call so it's unit-testable against fixtures, per the
 * plan's provider-adapter testing strategy (no live/rate-limited calls
 * needed to test the part that actually has business logic).
 */
export function normalizeOsmElement(el: OsmElement): NormalizedPlace | null {
  const tags = el.tags ?? {};
  const name = tags.name?.trim();
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  let category: PlaceCategory | null = null;
  if (tags.tourism && ATTRACTION_TOURISM_VALUES.has(tags.tourism)) {
    category = 'attraction';
  } else if (tags.amenity && RESTAURANT_AMENITY_VALUES.has(tags.amenity)) {
    category = 'restaurant';
  } else if (tags.shop) {
    category = 'shop';
  }
  if (!category) return null;

  return {
    externalRef: `osm:${el.type}/${el.id}`,
    name,
    category,
    latitude: lat,
    longitude: lon,
    raw: { ...tags },
  };
}

function buildQuery(bbox: BoundingBox): string {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
    [out:json][timeout:25];
    (
      node["tourism"~"^(attraction|museum|gallery|viewpoint|artwork|zoo|theme_park)$"](${bboxStr});
      node["amenity"~"^(restaurant|cafe|fast_food)$"](${bboxStr});
      node["shop"](${bboxStr});
    );
    out center tags;
  `;
}

/**
 * Talks to OSM's Overpass API - the only place in this codebase allowed
 * to do so (plan §8). Everything else depends on the PlacesProvider
 * interface, not on this class or on Overpass's response shape.
 */
export class OsmOverpassAdapter implements PlacesProvider {
  readonly sourceName = 'OpenStreetMap (Overpass)';

  async search(bbox: BoundingBox): Promise<NormalizedPlace[]> {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      body: buildQuery(bbox),
    });
    if (!response.ok) {
      throw new Error(
        `Overpass request failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = (await response.json()) as OverpassResponse;
    return data.elements
      .map(normalizeOsmElement)
      .filter((p): p is NormalizedPlace => p !== null);
  }
}
