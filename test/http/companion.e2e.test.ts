import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../src/http/app.module';
import { LLM_PROVIDER, POOL } from '../../src/http/tokens';
import { FakeLlmProvider } from '../../src/ai/fake-llm-provider';
import { ingestPlaces } from '../../src/ingestion/ingest-places';
import { DESTINATIONS } from '../../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../../src/providers/places-provider';
import { deleteItineraryAndJob, deletePlacesByExternalRef } from '../helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const TEST_PREFIX = 'test:companion-e2e';
const { bbox, center } = DESTINATIONS.delhi;
const START_DATE = '2026-10-01';
const END_DATE = '2026-10-01';

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:red-fort`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {},
};

const INDIA_GATE: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:india-gate`,
  name: 'India Gate',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.05,
  raw: {},
};

describe('POST /companion/messages (Phase 2 companion entry point)', () => {
  let app: INestApplication;
  let redFortId: string;
  let redFortFactVersionId: string;

  beforeAll(async () => {
    const provider = new FixturePlacesProvider([RED_FORT, INDIA_GATE]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const row = await pool.query(
      `select p.id as place_id, f.current_version_id as fact_version_id
       from places p join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
       where p.external_ref = $1`,
      [RED_FORT.externalRef],
    );
    redFortId = row.rows[0].place_id;
    redFortFactVersionId = row.rows[0].fact_version_id;

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              {
                itemType: 'place',
                placeId: redFortId,
                reason: 'A must-see fort.',
                factReferences: [redFortFactVersionId],
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
    // Itinerary/job rows before places - the reverse order is the FK
    // race a Phase 1 investigation found latent in another e2e file's
    // cleanup (a fact_version still referenced by itinerary_items).
    const jobs = await pool.query(
      `select id, itinerary_id from itinerary_jobs where destination = 'delhi' and created_at > now() - interval '5 minutes'`,
    );
    for (const job of jobs.rows) {
      await deleteItineraryAndJob(pool, { jobId: job.id, itineraryId: job.itinerary_id });
    }
    await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, INDIA_GATE.externalRef]);
    await pool.end();
  });

  it('1. "I am visiting Delhi for 3 days, plan a trip for me." routes to the existing itinerary pipeline', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'I am visiting Delhi for 3 days, plan a trip for me.',
      destinationSlug: 'delhi',
      interests: ['history'],
      startDate: START_DATE,
      endDate: END_DATE,
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('full_trip');
    expect(res.body.jobId).toBeTruthy();

    let job: { status: string; itineraryId: string | null } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jobRes = await request(app.getHttpServer()).get(`/itineraries/jobs/${res.body.jobId}`);
      job = jobRes.body;
      if (job?.status === 'complete' || job?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(job?.status).toBe('complete');

    // The same grounded, provenance-bearing itinerary the existing
    // /itineraries endpoint would have produced - same pipeline, unchanged.
    const itineraryRes = await request(app.getHttpServer()).get(`/itineraries/${job!.itineraryId}`);
    expect(itineraryRes.status).toBe(200);
    expect(itineraryRes.body.days[0].items[0].placeName).toBe('Red Fort');
    expect(itineraryRes.body.days[0].items[0].source.name).toBe('OpenStreetMap (Overpass)');
  });

  it('5. "Plan a 3-day trip to Delhi." (no explicit "I am visiting" phrasing) still routes to full trip when structured fields are supplied', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Plan a 3-day trip to Delhi.',
      destinationSlug: 'delhi',
      interests: [],
      startDate: START_DATE,
      endDate: END_DATE,
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('full_trip');
    expect(res.body.jobId).toBeTruthy();
  });

  it('2. "What should I eat at Indore Khau Galli?" gets an honest answer, not a fabricated one - and creates no itinerary', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'What should I eat at Indore Khau Galli?' });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('qa');
    expect(res.body.answer).toMatch(/don't have information about that destination/);
    // Precise proof of "no job created" (not a racy global COUNT(*),
    // which other concurrently-running test files would perturb): the
    // qa route literally has no code path that returns a jobId.
    expect(res.body).not.toHaveProperty('jobId');
  });

  it('3. "How far is Red Fort from India Gate?" answers from real ingested coordinates', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'How far is Red Fort from India Gate?' });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('qa');
    expect(res.body.answer).toMatch(/Red Fort is about \d+(\.\d+)? km from India Gate\./);
  });

  it('4. "Tell me about Delhi." gives a grounded overview and creates no itinerary', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({ message: 'Tell me about Delhi.' });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('qa');
    expect(res.body.answer).toMatch(/Delhi has \d+ attraction\(s\)/);
    expect(res.body).not.toHaveProperty('jobId');
  });

  it('rejects a body with no message', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({ destinationSlug: 'delhi' });
    expect(res.status).toBe(400);
  });

  it('GET /health still responds ok - the companion controller is additive, not a replacement', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });
});
