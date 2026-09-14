import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { recommendShopping } from '../src/shopping/recommend-shopping';
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

// A dedicated destination bucket, not the shared 'delhi' - see
// candidate-set.test.ts for why (parallel test-file execution).
const DESTINATION = 'delhi-test-recommend-shopping';
const TEST_PREFIX = 'test:recommend-shopping';
const { bbox, center } = DESTINATIONS.delhi;

const TEXTILES: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:0`,
  name: 'Chandni Chowk Textiles',
  category: 'shop',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: { shop: 'textiles' },
};

const BOOKS: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:1`,
  name: 'Bahrisons Booksellers',
  category: 'shop',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: { shop: 'books' },
};

describe('recommendShopping', () => {
  it('is a thin filter over places: no shopType filter returns all shops, ranked by proximity, with provenance', async () => {
    const provider = new FixturePlacesProvider([BOOKS, TEXTILES]);
    await ingestPlaces(pool, provider, DESTINATION, bbox);

    try {
      const results = await recommendShopping(pool, DESTINATION, center);
      const testResults = results.filter((r) => [TEXTILES.name, BOOKS.name].includes(r.name));

      expect(testResults).toHaveLength(2);
      expect(testResults[0].name).toBe('Chandni Chowk Textiles'); // closer to center
      expect(testResults[0].shopType).toBe('textiles');
      expect(testResults[0].source.licence).toBe('odbl');
      expect(testResults[0].factVersionId).toBeTruthy();
    } finally {
      await deletePlacesByExternalRef(pool, [TEXTILES.externalRef, BOOKS.externalRef]);
    }
  });

  it('filters by shop type (case-insensitive substring match)', async () => {
    const provider = new FixturePlacesProvider([BOOKS, TEXTILES]);
    await ingestPlaces(pool, provider, DESTINATION, bbox);

    try {
      const results = await recommendShopping(pool, DESTINATION, center, { shopType: 'book' });
      const testResults = results.filter((r) => [TEXTILES.name, BOOKS.name].includes(r.name));

      expect(testResults).toHaveLength(1);
      expect(testResults[0].name).toBe('Bahrisons Booksellers');
    } finally {
      await deletePlacesByExternalRef(pool, [TEXTILES.externalRef, BOOKS.externalRef]);
    }
  });
});
