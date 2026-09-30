import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../src/http/app.module';
import { HOTEL_PROVIDERS, LLM_PROVIDER, POOL } from '../../src/http/tokens';
import { FakeLlmProvider } from '../../src/ai/fake-llm-provider';
import { MockHotelProvider } from '../../src/providers/mock-hotel-provider';
import { getJob } from '../../src/itinerary/jobs';
import { deleteItineraryAndJob } from '../helpers/db-cleanup';
import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../../src/providers/hotel-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

class FailingHotelProvider implements HotelProvider {
  readonly providerName = 'FailingHotelProvider';
  async search(_criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]> {
    throw new Error('simulated outage');
  }
}

describe('POST /companion/messages - hotel comparison (Phase 4)', () => {
  let app: INestApplication;
  // The full-trip regression test below only needs to prove routing
  // still dispatches correctly, not full itinerary generation (already
  // covered by companion.e2e.test.ts's own itinerary-shaped fixture) -
  // this file's shared FakeLlmProvider returns a narration-shaped
  // response, so that background job will fail schema validation and
  // must be cleaned up by its exact id rather than left as debris.
  let fullTripJobId: string | undefined;

  beforeAll(async () => {
    // Q&A/full-trip regression checks in this file don't cite any real
    // fact_version, so the LLM is never called on those paths (same as
    // the existing companion.e2e.test.ts's own noop provider); the fake
    // response below only matters for the comparison narration call.
    const llm = new FakeLlmProvider(
      JSON.stringify({
        narrative: 'A short comparison of the available hotels.',
        highlights: [],
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
    if (fullTripJobId) {
      const job = await getJob(pool, fullTripJobId);
      await deleteItineraryAndJob(pool, { jobId: fullTripJobId, itineraryId: job?.itineraryId });
    }
  });

  it('1-2-3. a hotel comparison request returns ordered offers and persists a comparison task', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('comparison');
    expect(res.body.taskId).toBeTruthy();
    expect(Array.isArray(res.body.result.offers)).toBe(true);
    expect(res.body.result.offers.length).toBeGreaterThan(0);
    expect(res.body.result.domains).toEqual(['hotel']);

    // Ordering is authoritative (plan §F) - ascending by price.
    const prices = res.body.result.offers.map((o: { price: number }) => o.price);
    expect(prices).toEqual([...prices].sort((a: number, b: number) => a - b));

    // `raw` must never reach the HTTP response (plan §C/§K).
    for (const offer of res.body.result.offers) {
      expect(offer).not.toHaveProperty('raw');
    }

    // Task persistence, verified directly against the DB by exact id.
    const taskRow = await pool.query('select id, status, result from tasks where id = $1', [res.body.taskId]);
    expect(taskRow.rows).toHaveLength(1);
    expect(taskRow.rows[0].status).toBe('complete');
    expect(taskRow.rows[0].result.offers).toEqual(res.body.result.offers);
  });

  it('4. a follow-up "I like the second one" resolves to the exact second persisted offer from the same conversation', async () => {
    const compareRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    expect(compareRes.status).toBe(200);
    const secondPersistedOffer = compareRes.body.result.offers[1];

    const followUpRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'I like the second one.',
      conversationId: compareRes.body.conversationId,
    });

    expect(followUpRes.status).toBe(200);
    expect(followUpRes.body.route).toBe('ordinal_selection');
    expect(followUpRes.body.selectedOfferId).toBe(secondPersistedOffer.offerId);
    expect(followUpRes.body.provider).toBe(secondPersistedOffer.provider);
    expect(followUpRes.body.domain).toBe('hotel');
  });

  it('an ordinal follow-up with no prior comparison in the conversation returns 400, not a guess', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'I like the second one.',
    });

    expect(res.status).toBe(400);
  });

  it('8. DTO validation still rejects an invalid hotelSearchLocation (non-string)', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels',
      hotelSearchLocation: 12345,
    });

    expect(res.status).toBe(400);
  });

  it('6. the existing full-trip route is unaffected by the comparison addition', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Plan a 1-day trip to Delhi.',
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-10-20',
      endDate: '2026-10-20',
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('full_trip');
    expect(res.body.jobId).toBeTruthy();
    fullTripJobId = res.body.jobId;
  });

  it('7. the existing Q&A route is unaffected by the comparison addition', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Tell me about Delhi.' });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('qa');
  });
});

describe('POST /companion/messages - hotel comparison provider failure isolation (Phase 4)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const llm = new FakeLlmProvider(JSON.stringify({ narrative: 'Comparison with a partial provider outage.', highlights: [] }));
    const hotelProviders: HotelProvider[] = [new MockHotelProvider(), new FailingHotelProvider()];

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .overrideProvider(POOL)
      .useValue(pool)
      .overrideProvider(HOTEL_PROVIDERS)
      .useValue(hotelProviders)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('5. a failing provider produces partial results, not a total failure', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('comparison');
    expect(res.body.result.failedProviders).toEqual(['FailingHotelProvider']);
    expect(res.body.result.offers.length).toBeGreaterThan(0);
    expect(res.body.result.offers.every((o: { provider: string }) => o.provider !== 'FailingHotelProvider')).toBe(
      true,
    );
  });
});

afterAll(async () => {
  await pool.end();
});
