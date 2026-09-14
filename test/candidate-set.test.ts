import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { buildCandidateSet } from '../src/travel-intelligence/candidate-set';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { DESTINATIONS } from '../src/destinations';
import { deletePlacesByExternalRef } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const DESTINATION = 'delhi';
const { bbox, center } = DESTINATIONS.delhi;
const TEST_PREFIX = 'test:candidate-set';

// Each step of 0.01deg longitude at a fixed latitude is monotonically
// farther from `center`, which is all this test needs for ranking -
// exact km values are covered by geo.test.ts.
function makePlace(category: 'attraction' | 'restaurant', index: number): NormalizedPlace {
  return {
    externalRef: `${TEST_PREFIX}:${category}:${index}`,
    name: `${category} ${index}`,
    category,
    latitude: center.latitude,
    longitude: center.longitude + index * 0.01,
    raw: {},
  };
}

describe('buildCandidateSet', () => {
  it('filters by destination/category, ranks by proximity to center, and caps each category', async () => {
    // 9 attractions but the category limit is 8 - the farthest must be dropped.
    const attractions = Array.from({ length: 9 }, (_, i) => makePlace('attraction', i));
    // 3 restaurants, under the limit of 6 - all should be kept, in order.
    const restaurants = Array.from({ length: 3 }, (_, i) => makePlace('restaurant', i));
    const allRefs = [...attractions, ...restaurants].map((p) => p.externalRef);

    try {
      const provider = new FixturePlacesProvider([...attractions, ...restaurants]);
      await ingestPlaces(pool, provider, DESTINATION, bbox);

      const candidateSet = await buildCandidateSet(pool, DESTINATION, center);

      const testAttractions = candidateSet.attractions.filter((c) =>
        c.name.startsWith('attraction '),
      );
      expect(testAttractions).toHaveLength(8);
      expect(testAttractions[0].name).toBe('attraction 0'); // distance 0, must sort first
      expect(testAttractions.some((c) => c.name === 'attraction 8')).toBe(false); // farthest, dropped
      for (let i = 1; i < testAttractions.length; i++) {
        expect(testAttractions[i].distanceFromCenterKm).toBeGreaterThanOrEqual(
          testAttractions[i - 1].distanceFromCenterKm,
        );
      }

      const testRestaurants = candidateSet.restaurants.filter((c) =>
        c.name.startsWith('restaurant '),
      );
      expect(testRestaurants).toHaveLength(3);
      expect(testRestaurants[0].name).toBe('restaurant 0');

      // Every candidate must carry a real fact_version reference (plan
      // §5) - this is what lets the AI layer's grounding check work.
      for (const candidate of [...testAttractions, ...testRestaurants]) {
        expect(candidate.factVersionId).toBeTruthy();
      }

      expect(candidateSet.shops).toEqual([]);
    } finally {
      await deletePlacesByExternalRef(pool, allRefs);
    }
  });
});
