import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../src/http/app.module';
import { LLM_PROVIDER, POOL } from '../../src/http/tokens';
import { FakeLlmProvider } from '../../src/ai/fake-llm-provider';
import { ingestPlaces } from '../../src/ingestion/ingest-places';
import { seedWarnings } from '../../src/advisory/seed-warnings';
import { DESTINATIONS } from '../../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../../src/providers/places-provider';
import { deleteDestination, deleteItineraryAndJob, deletePlacesByExternalRef } from '../helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const TEST_PREFIX = 'test:http-e2e';
const { bbox, center } = DESTINATIONS.delhi;
const START_DATE = '2026-10-01';
const END_DATE = '2026-10-01';

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:0`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: { tourism: 'attraction' },
};

const KARIMS: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:restaurant:0`,
  name: "Karim's",
  category: 'restaurant',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: { amenity: 'restaurant', cuisine: 'mughlai' },
};

describe('HTTP API (end-to-end, real Postgres, fake LLM)', () => {
  let app: INestApplication;
  let realPlaceId: string;
  let realFactVersionId: string;
  let warningFactVersionId: string;

  beforeAll(async () => {
    await ingestPlaces(pool, new FixturePlacesProvider([RED_FORT, KARIMS]), 'delhi', bbox);
    await seedWarnings(pool, 'delhi');

    const placeRow = await pool.query(
      `select p.id as place_id, f.current_version_id as fact_version_id
       from places p
       join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
       where p.external_ref = $1`,
      [RED_FORT.externalRef],
    );
    realPlaceId = placeRow.rows[0].place_id;
    realFactVersionId = placeRow.rows[0].fact_version_id;

    const warningRow = await pool.query(
      `select f.current_version_id as fact_version_id
       from destinations d
       join facts f on f.entity_table = 'destinations' and f.entity_id = d.id and f.fact_type = 'travel_warning'
       where d.slug = 'delhi' limit 1`,
    );
    warningFactVersionId = warningRow.rows[0].fact_version_id;

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'History and food in central Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History, food, and a travel note.',
            items: [
              {
                itemType: 'place',
                placeId: realPlaceId,
                reason: 'A must-see fort.',
                factReferences: [realFactVersionId],
              },
              {
                itemType: 'place',
                placeId: 'fabricated-place-id',
                reason: 'The model made this up.',
                factReferences: ['fabricated-fact-version'],
              },
              {
                itemType: 'warning',
                reason: 'Check visa requirements before travelling.',
                factReferences: [warningFactVersionId],
              },
            ],
          },
        ],
      }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .overrideProvider(POOL)
      .useValue(pool)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, KARIMS.externalRef]);
    await deleteDestination(pool, 'delhi');
    await pool.end();
  });

  it('GET /health responds ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('runs the full itinerary flow through the HTTP layer: create -> poll -> fetch -> provenance, including a seeded warning and grounding out a fabricated item', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/itineraries')
      .send({
        destinationSlug: 'delhi',
        interests: ['history', 'food'],
        startDate: START_DATE,
        endDate: END_DATE,
      });

    expect(createRes.status).toBe(202);
    const { jobId } = createRes.body;
    expect(jobId).toBeTruthy();

    // The job runs in the background (fire-and-forget) - poll until it's
    // no longer pending/processing, same as a real client would.
    let job:
      | { status: string; itineraryId: string | null; rejectedItems: unknown[] }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jobRes = await request(app.getHttpServer()).get(`/itineraries/jobs/${jobId}`);
      job = jobRes.body;
      if (job?.status === 'complete' || job?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(job?.status).toBe('complete');
    expect(job?.rejectedItems).toHaveLength(1);

    const itineraryId = job!.itineraryId!;
    try {
      const itineraryRes = await request(app.getHttpServer()).get(`/itineraries/${itineraryId}`);
      expect(itineraryRes.status).toBe(200);
      expect(itineraryRes.body.destination).toBe('delhi');
      expect(itineraryRes.body.startDate).toBe(START_DATE);
      // Only the two grounded items (place + warning) made it through -
      // the fabricated one was stripped before persistence.
      expect(itineraryRes.body.days[0].items).toHaveLength(2);

      const placeItem = itineraryRes.body.days[0].items.find(
        (i: { itemType: string }) => i.itemType === 'place',
      );
      const warningItem = itineraryRes.body.days[0].items.find(
        (i: { itemType: string }) => i.itemType === 'warning',
      );
      expect(placeItem).toBeTruthy();
      expect(warningItem).toBeTruthy();
      // The response makes the warning's source honestly clear - a
      // seeded/static note, never presented as a live advisory.
      expect(warningItem.placeId).toBeNull();
      expect(warningItem.source.name).toBe('Manually curated Phase 1 seed content');

      const provenanceRes = await request(app.getHttpServer()).get(
        `/itineraries/${itineraryId}/items/${placeItem.itemId}/provenance`,
      );
      expect(provenanceRes.status).toBe(200);
      expect(provenanceRes.body.source.name).toBe('OpenStreetMap (Overpass)');
    } finally {
      await deleteItineraryAndJob(pool, { jobId, itineraryId });
    }
  });

  it('GET /itineraries/jobs/:jobId 404s for an unknown (but valid) job id', async () => {
    const res = await request(app.getHttpServer()).get(
      '/itineraries/jobs/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  // P0-1 regression: a malformed id must never reach Postgres and
  // surface as an uncaught 500 - ParseUUIDPipe rejects it as a 400
  // before any handler code runs.
  it('GET /itineraries/:id 400s (not 500) for a malformed id', async () => {
    const res = await request(app.getHttpServer()).get('/itineraries/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('GET /itineraries/jobs/:jobId 400s (not 500) for a malformed job id', async () => {
    const res = await request(app.getHttpServer()).get('/itineraries/jobs/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('GET /itineraries/:id/items/:itemId/provenance 400s (not 500) for a malformed id or itemId', async () => {
    const badId = await request(app.getHttpServer()).get(
      `/itineraries/not-a-uuid/items/00000000-0000-0000-0000-000000000000/provenance`,
    );
    expect(badId.status).toBe(400);

    const badItemId = await request(app.getHttpServer()).get(
      `/itineraries/00000000-0000-0000-0000-000000000000/items/not-a-uuid/provenance`,
    );
    expect(badItemId.status).toBe(400);
  });

  it('POST /itineraries rejects a malformed body via explicit DTO validation', async () => {
    const res = await request(app.getHttpServer())
      .post('/itineraries')
      .send({ interests: 'not-an-array', startDate: START_DATE, endDate: END_DATE });
    expect(res.status).toBe(400);
  });

  it('POST /itineraries returns 400 (not 500) for an unknown destination, and creates no job', async () => {
    const res = await request(app.getHttpServer())
      .post('/itineraries')
      .send({ destinationSlug: 'atlantis', interests: [], startDate: START_DATE, endDate: END_DATE });
    expect(res.status).toBe(400);

    const jobs = await pool.query('select id from itinerary_jobs where destination = $1', ['atlantis']);
    expect(jobs.rows).toHaveLength(0);
  });

  // P0-4 regression: an invalid date range must 400, not create a job.
  it('POST /itineraries returns 400 for an invalid date range', async () => {
    const res = await request(app.getHttpServer()).post('/itineraries').send({
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-10-10',
      endDate: '2026-10-01',
    });
    expect(res.status).toBe(400);
  });

  it('GET /food filters by cuisine and returns provenance', async () => {
    const res = await request(app.getHttpServer()).get('/food').query({
      destination: 'delhi',
      cuisine: 'mughlai',
    });
    expect(res.status).toBe(200);
    const testResult = res.body.find((r: { name: string }) => r.name === "Karim's");
    expect(testResult).toBeTruthy();
    expect(testResult.source.name).toBe('OpenStreetMap (Overpass)');
  });

  it('GET /food 400s for an unknown destination', async () => {
    const res = await request(app.getHttpServer()).get('/food').query({ destination: 'atlantis' });
    expect(res.status).toBe(400);
  });

  it('GET /advisories returns the seeded warnings with provenance', async () => {
    const res = await request(app.getHttpServer()).get('/advisories').query({ destination: 'delhi' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].source.name).toBe('Manually curated Phase 1 seed content');
  });
});
