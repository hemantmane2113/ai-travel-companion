import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { recommendFood } from '../src/food/recommend-food';
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

const TEST_PREFIX = 'test:recommend-food';
const { bbox, center } = DESTINATIONS.delhi;

const KARIMS: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:0`,
  name: "Karim's",
  category: 'restaurant',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: { amenity: 'restaurant', cuisine: 'mughlai' },
};

const SAGAR_RATNA: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:1`,
  name: 'Sagar Ratna',
  category: 'restaurant',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: { amenity: 'restaurant', cuisine: 'south_indian' },
};

describe('recommendFood', () => {
  it('is a thin filter over places: no cuisine filter returns all restaurants, ranked by proximity, with provenance', async () => {
    const provider = new FixturePlacesProvider([SAGAR_RATNA, KARIMS]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    try {
      const results = await recommendFood(pool, 'delhi', center);
      const testResults = results.filter((r) => [KARIMS.name, SAGAR_RATNA.name].includes(r.name));

      expect(testResults).toHaveLength(2);
      // Karim's is closer to center, so it must rank first.
      expect(testResults[0].name).toBe("Karim's");
      expect(testResults[0].cuisine).toBe('mughlai');
      expect(testResults[0].source.name).toBe('OpenStreetMap (Overpass)');
      expect(testResults[0].factVersionId).toBeTruthy();
    } finally {
      await deletePlacesByExternalRef(pool, [KARIMS.externalRef, SAGAR_RATNA.externalRef]);
    }
  });

  it('filters by cuisine (case-insensitive substring match)', async () => {
    const provider = new FixturePlacesProvider([SAGAR_RATNA, KARIMS]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    try {
      const results = await recommendFood(pool, 'delhi', center, { cuisine: 'South' });
      const testResults = results.filter((r) => [KARIMS.name, SAGAR_RATNA.name].includes(r.name));

      expect(testResults).toHaveLength(1);
      expect(testResults[0].name).toBe('Sagar Ratna');
    } finally {
      await deletePlacesByExternalRef(pool, [KARIMS.externalRef, SAGAR_RATNA.externalRef]);
    }
  });

  it('never depends on a live external API call - reads only already-ingested places', async () => {
    // No ingestion in this test at all; an unknown destination simply
    // returns no results rather than reaching out to a provider.
    const results = await recommendFood(pool, 'nowhere', center);
    expect(results).toEqual([]);
  });
});
