import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { generateItinerary } from '../src/itinerary/generate-itinerary';
import { getItineraryWithProvenance } from '../src/itinerary/get-itinerary';
import { getJob } from '../src/itinerary/jobs';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { DESTINATIONS } from '../src/destinations';
import { deleteItineraryAndJob, deletePlacesByExternalRef } from './helpers/db-cleanup';

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

const TEST_PREFIX = 'test:generate-itinerary';
const { bbox, center } = DESTINATIONS.delhi;

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:0`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {},
};

const KARIMS: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:restaurant:0`,
  name: "Karim's",
  category: 'restaurant',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: {},
};

describe('generateItinerary', () => {
  it('runs the job to completion and persists a provenance-traceable itinerary', async () => {
    const provider = new FixturePlacesProvider([RED_FORT, KARIMS]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'History and food in central Delhi.',
        items: [
          { placeId: (await lookupPlaceId(RED_FORT)), note: 'A must-see fort.' },
          { placeId: (await lookupPlaceId(KARIMS)), note: 'Legendary Old Delhi kebabs.' },
        ],
      }),
    );

    let result: Awaited<ReturnType<typeof generateItinerary>> | undefined;
    try {
      result = await generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: ['history', 'food'],
      });

      expect(result.rejectedItems).toHaveLength(0);

      const job = await getJob(pool, result.jobId);
      expect(job?.status).toBe('complete');
      expect(job?.itineraryId).toBe(result.itineraryId);
      expect(job?.rejectedItems).toEqual([]);

      const itinerary = await getItineraryWithProvenance(pool, result.itineraryId);
      expect(itinerary?.destination).toBe('delhi');
      expect(itinerary?.days).toHaveLength(1);
      expect(itinerary?.days[0].items).toHaveLength(2);

      // "Why does the system believe this?" (plan §5) must resolve to a
      // real, attributable source for every item.
      for (const item of itinerary!.days[0].items) {
        expect(item.provenanceKind).toBe('verified');
        expect(item.source?.name).toBe('OpenStreetMap (Overpass)');
        expect(item.source?.licence).toBe('odbl');
      }
    } finally {
      if (result) await deleteItineraryAndJob(pool, result);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, KARIMS.externalRef]);
    }
  });

  it('strips a fabricated placeId end-to-end: it is never persisted, and is recorded on the job', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const realPlaceId = await lookupPlaceId(RED_FORT);
    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        items: [
          { placeId: realPlaceId, note: 'Real place.' },
          { placeId: 'not-a-real-place-id', note: 'The model made this up.' },
        ],
      }),
    );

    let result: Awaited<ReturnType<typeof generateItinerary>> | undefined;
    try {
      result = await generateItinerary(pool, llm, { destinationSlug: 'delhi', interests: [] });

      expect(result.rejectedItems).toEqual([
        { placeId: 'not-a-real-place-id', note: 'The model made this up.' },
      ]);

      const job = await getJob(pool, result.jobId);
      expect(job?.rejectedItems).toEqual([
        { placeId: 'not-a-real-place-id', note: 'The model made this up.' },
      ]);

      const itinerary = await getItineraryWithProvenance(pool, result.itineraryId);
      // Only the real place was persisted - the fabricated one never
      // reaches storage, not even as an unverified row.
      expect(itinerary?.days[0].items).toHaveLength(1);
      expect(itinerary?.days[0].items[0].placeId).toBe(realPlaceId);
    } finally {
      if (result) await deleteItineraryAndJob(pool, result);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('marks the job failed and creates no itinerary when the model response is invalid', async () => {
    const llm = new FakeLlmProvider('not json');

    await expect(
      generateItinerary(pool, llm, { destinationSlug: 'delhi', interests: [] }),
    ).rejects.toThrow(/not valid JSON/);

    const jobs = await pool.query(
      `select id, status, error, itinerary_id from itinerary_jobs
       where destination = 'delhi' and status = 'failed'
       order by created_at desc limit 1`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].error).toMatch(/not valid JSON/);
    expect(jobs.rows[0].itinerary_id).toBeNull();

    await deleteItineraryAndJob(pool, { jobId: jobs.rows[0].id });
  });

  it('rejects an unknown destination before creating any job', async () => {
    const llm = new FakeLlmProvider('{}');

    await expect(
      generateItinerary(pool, llm, { destinationSlug: 'atlantis', interests: [] }),
    ).rejects.toThrow(/Unknown destination/);

    const jobs = await pool.query(`select id from itinerary_jobs where destination = 'atlantis'`);
    expect(jobs.rows).toHaveLength(0);
  });
});

// Look up the id a just-ingested fixture place received, so the fake
// LLM response can reference a real placeId without hardcoding a UUID.
async function lookupPlaceId(place: NormalizedPlace): Promise<string> {
  const row = await pool.query('select id from places where external_ref = $1', [
    place.externalRef,
  ]);
  return row.rows[0].id as string;
}
