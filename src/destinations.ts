import type { BoundingBox } from './providers/places-provider';
import type { LatLng } from './geo';

export interface Destination {
  slug: string;
  name: string;
  bbox: BoundingBox;
  /** Reference point used by Travel Intelligence for proximity ranking (plan §4). */
  center: LatLng;
}

// Phase 1 launch destination (plan §11, resolved: Delhi). A bounding box
// covering the major tourist/food/shopping areas - Connaught Place, India
// Gate, Red Fort, Chandni Chowk, Hauz Khas - not the full NCR. Shared by
// the ingestion pipeline (bbox) and the Travel Intelligence Engine (center).
export const DESTINATIONS: Record<string, Destination> = {
  delhi: {
    slug: 'delhi',
    name: 'Delhi',
    bbox: { south: 28.55, west: 77.15, north: 28.7, east: 77.3 },
    // Connaught Place - a reasonable "center of gravity" for central Delhi.
    center: { latitude: 28.6315, longitude: 77.2167 },
  },
};
