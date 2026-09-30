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

const TEST_PREFIX = 'test:must-visit-e2e';
const { bbox, center } = DESTINATIONS.delhi;
const START_DATE = '2026-12-01';
const END_DATE = '2026-12-01';

// Disambiguating suffix on every fixture NAME (not just external_ref):
// several other test files also ingest a place literally named "Red
// Fort" into the same shared real 'delhi' destination (harmless there,
// since nothing before Phase 3 did a strict exact-name lookup). This
// file's resolveMustVisitPlaces calls DO care about name uniqueness by
// design (an ambiguous match must be rejected, not guessed) - so running
// in parallel with those other files could otherwise make this file's
// own must-visit resolution see two same-named places and correctly-but-
// unintentionally report them as ambiguous. Same disambiguation
// convention already used elsewhere in this codebase's own smoke tests.
const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:red-fort`,
  name: 'Red Fort (must-visit test)',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {},
};
const INDIA_GATE: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:india-gate`,
  name: 'India Gate (must-visit test)',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: {},
};
const HUMAYUNS_TOMB: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:humayun`,
  name: "Humayun's Tomb (must-visit test)",
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.03,
  raw: {},
};

describe('POST /companion/messages with mustVisit (Phase 3)', () => {
  let app: INestApplication;
  // Captured from the one test that creates a job, so afterAll can delete
  // by exact ID instead of a broad destination/date-range query - a
  // broad query risks racing another concurrently-running e2e file's own
  // broad cleanup query against the same shared real 'delhi' destination
  // (the same class of FK-ordering race a Phase 1 investigation found in
  // app.e2e.test.ts, reproduced here between sibling Phase 2/3 files).
  let createdJobId: string | undefined;

  beforeAll(async () => {
    await ingestPlaces(pool, new FixturePlacesProvider([RED_FORT, INDIA_GATE, HUMAYUNS_TOMB]), 'delhi', bbox);

    const rows = await pool.query(
      `select p.id as place_id, p.external_ref, f.current_version_id as fact_version_id
       from places p join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
       where p.external_ref = any($1::text[])`,
      [[RED_FORT.externalRef, INDIA_GATE.externalRef, HUMAYUNS_TOMB.externalRef]],
    );
    const byRef = new Map(rows.rows.map((r) => [r.external_ref, r]));
    const redFort = byRef.get(RED_FORT.externalRef);
    const indiaGate = byRef.get(INDIA_GATE.externalRef);
    const humayun = byRef.get(HUMAYUNS_TOMB.externalRef);

    // Scripted to include all three of the example request's must-visit
    // places (this is the literal "I definitely want to visit Red Fort,
    // India Gate and Humayun's Tomb" scenario) - the happy-path HTTP test
    // below confirms all three actually appear in the response.
    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day covering the must-visit places.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              { itemType: 'place', placeId: redFort!.place_id, reason: 'A must-see fort.', factReferences: [redFort!.fact_version_id] },
              { itemType: 'place', placeId: indiaGate!.place_id, reason: 'As requested.', factReferences: [indiaGate!.fact_version_id] },
              { itemType: 'place', placeId: humayun!.place_id, reason: 'As requested.', factReferences: [humayun!.fact_version_id] },
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
    // Delete only the exact job this file itself created (captured from
    // the happy-path test below) rather than any destination/date-range
    // query - a broad query here could match (or be matched by) another
    // concurrently-running e2e file's own broad cleanup query against the
    // same shared real 'delhi' destination, causing a cross-file FK race
    // on fact_versions still referenced by itinerary_items. If the
    // happy-path test itself failed before ever creating a job, there is
    // nothing to delete here.
    if (createdJobId) {
      const job = await pool.query('select itinerary_id from itinerary_jobs where id = $1', [createdJobId]);
      await deleteItineraryAndJob(pool, { jobId: createdJobId, itineraryId: job.rows[0]?.itinerary_id ?? null });
    }
    await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, INDIA_GATE.externalRef, HUMAYUNS_TOMB.externalRef]);
    await pool.end();
  });

  it('"I definitely want to visit Red Fort, India Gate and Humayun\'s Tomb" - all three appear in the final itinerary', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      // Message prose uses the plain, realistic names - only the
      // structured mustVisit array (what's actually queried) needs the
      // disambiguating suffix, matching how a real client would supply
      // exact place names regardless of what the free-text note says.
      message: "I am visiting Delhi for 1 day and I definitely want to visit Red Fort, India Gate and Humayun's Tomb.",
      destinationSlug: 'delhi',
      interests: [],
      startDate: START_DATE,
      endDate: END_DATE,
      mustVisit: ['Red Fort (must-visit test)', 'India Gate (must-visit test)', "Humayun's Tomb (must-visit test)"],
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('full_trip');
    createdJobId = res.body.jobId;

    let job: { status: string; itineraryId: string | null } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jobRes = await request(app.getHttpServer()).get(`/itineraries/jobs/${res.body.jobId}`);
      job = jobRes.body;
      if (job?.status === 'complete' || job?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(job?.status).toBe('complete');

    const itineraryRes = await request(app.getHttpServer()).get(`/itineraries/${job!.itineraryId}`);
    const names = itineraryRes.body.days[0].items.map((i: { placeName: string }) => i.placeName);
    expect(names).toEqual(
      expect.arrayContaining(['Red Fort (must-visit test)', 'India Gate (must-visit test)', "Humayun's Tomb (must-visit test)"]),
    );
  });

  it('an unresolvable must-visit place returns 400 with a clear message, not a silently degraded plan', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Plan my trip, I must see the Fictional Non-Existent Palace.',
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-12-10',
      endDate: '2026-12-10',
      mustVisit: ['Fictional Non-Existent Palace'],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Fictional Non-Existent Palace/);
  });
});
