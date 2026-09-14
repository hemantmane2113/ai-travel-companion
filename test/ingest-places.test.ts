import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

// A fake PlacesProvider standing in for OsmOverpassAdapter - this proves
// the ingestion pipeline's own logic (write path + provenance) without a
// live network call, per the plan's provider-adapter testing strategy.
class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const RED_FORT_REF = 'osm:node/999000001';
const DELHI_BBOX: BoundingBox = { south: 28.55, west: 77.15, north: 28.7, east: 77.3 };

describe('ingestPlaces', () => {
  it('writes a normalized place with provenance, and supersedes (not overwrites) on re-ingestion', async () => {
    const firstPass = new FixturePlacesProvider([
      {
        externalRef: RED_FORT_REF,
        name: 'Red Fort',
        category: 'attraction',
        latitude: 28.6562,
        longitude: 77.241,
        raw: { tourism: 'attraction', name: 'Red Fort' },
      },
    ]);

    const result1 = await ingestPlaces(pool, firstPass, 'delhi', DELHI_BBOX);
    expect(result1).toEqual({ destination: 'delhi', placesCreated: 1, placesUpdated: 0 });

    const placeRow = await pool.query(
      `select id, name, category, destination from places where external_ref = $1`,
      [RED_FORT_REF],
    );
    expect(placeRow.rows).toHaveLength(1);
    const placeId = placeRow.rows[0].id as string;
    expect(placeRow.rows[0].name).toBe('Red Fort');
    expect(placeRow.rows[0].category).toBe('attraction');
    expect(placeRow.rows[0].destination).toBe('delhi');

    const factRow = await pool.query(
      `select id, current_version_id from facts where entity_table = 'places' and entity_id = $1`,
      [placeId],
    );
    expect(factRow.rows).toHaveLength(1);
    const factId = factRow.rows[0].id as string;
    const firstVersionId = factRow.rows[0].current_version_id as string;
    expect(firstVersionId).toBeTruthy();

    // "Why does the system believe this?" (plan §5) - the fact_version
    // must trace back to a real source record.
    const firstVersion = await pool.query(
      `select fv.confidence, s.name as source_name, s.licence, s.requires_attribution
       from fact_versions fv join sources s on s.id = fv.source_id
       where fv.id = $1`,
      [firstVersionId],
    );
    expect(firstVersion.rows[0].source_name).toBe('OpenStreetMap (Overpass)');
    expect(firstVersion.rows[0].licence).toBe('odbl');
    expect(firstVersion.rows[0].requires_attribution).toBe(true);

    try {
      // Re-ingest with a changed name, simulating a refreshed OSM tag.
      const secondPass = new FixturePlacesProvider([
        {
          externalRef: RED_FORT_REF,
          name: 'Red Fort (Lal Qila)',
          category: 'attraction',
          latitude: 28.6562,
          longitude: 77.241,
          raw: { tourism: 'attraction', name: 'Red Fort (Lal Qila)' },
        },
      ]);
      const result2 = await ingestPlaces(pool, secondPass, 'delhi', DELHI_BBOX);
      expect(result2).toEqual({ destination: 'delhi', placesCreated: 0, placesUpdated: 1 });

      const updatedPlace = await pool.query('select name from places where id = $1', [placeId]);
      expect(updatedPlace.rows[0].name).toBe('Red Fort (Lal Qila)');

      const updatedFact = await pool.query('select current_version_id from facts where id = $1', [
        factId,
      ]);
      const secondVersionId = updatedFact.rows[0].current_version_id as string;
      expect(secondVersionId).not.toBe(firstVersionId);

      // The prior version must be superseded, not deleted or overwritten.
      const firstVersionAfter = await pool.query(
        'select superseded_by from fact_versions where id = $1',
        [firstVersionId],
      );
      expect(firstVersionAfter.rows[0].superseded_by).toBe(secondVersionId);
    } finally {
      // current_version_id must be cleared before fact_versions can be
      // deleted (facts_current_version_fk).
      await pool.query('update facts set current_version_id = null where id = $1', [factId]);
      await pool.query('delete from fact_versions where fact_id = $1', [factId]);
      await pool.query('delete from facts where id = $1', [factId]);
      await pool.query('delete from places where id = $1', [placeId]);
    }
  });
});
