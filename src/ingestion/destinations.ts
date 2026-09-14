import type { BoundingBox } from '../providers/places-provider';

export interface Destination {
  slug: string;
  name: string;
  bbox: BoundingBox;
}

// Phase 1 launch destination (plan §11, resolved: Delhi). A bounding box
// covering the major tourist/food/shopping areas - Connaught Place, India
// Gate, Red Fort, Chandni Chowk, Hauz Khas - not the full NCR.
export const DESTINATIONS: Record<string, Destination> = {
  delhi: {
    slug: 'delhi',
    name: 'Delhi',
    bbox: { south: 28.55, west: 77.15, north: 28.7, east: 77.3 },
  },
};
