import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../src/http/app.module';
import { LLM_PROVIDER, POOL } from '../../src/http/tokens';
import { FakeLlmProvider } from '../../src/ai/fake-llm-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('POST /companion/messages - knowledge Q&A and booking preparation (Phase 6)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const llm = new FakeLlmProvider(JSON.stringify({ narrative: 'A short comparison.', highlights: [] }));

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
  });

  it('a knowledge-oriented question with nothing to retrieve returns an honest unavailable answer over HTTP', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'What is the xyzzyqux555nonexistent visa requirement for Delhi?' });

    expect(res.status).toBe(200);
    expect(res.body.route).toBe('qa');
    expect(res.body.answer).toMatch(/don't have any information on file/);
  });

  it('a full booking-intent -> confirmation round trip works over HTTP', async () => {
    const compareRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    expect(compareRes.status).toBe(200);
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'I want to book this.',
      conversationId,
      bookingOfferId: offerId,
    });

    expect(intentRes.status).toBe(200);
    expect(intentRes.body.route).toBe('booking_intent');
    expect(intentRes.body.result.bookingStatus).toBe('awaiting_confirmation');
    expect(intentRes.body.result.executionState).toBe('not_executed');
    const taskId = intentRes.body.result.taskId;

    const confirmRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Yes, confirmed.',
      conversationId,
      confirmBookingTaskId: taskId,
    });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.route).toBe('booking_confirmed');
    expect(confirmRes.body.result.bookingStatus).toBe('confirmed');
    expect(confirmRes.body.result.executionState).toBe('not_executed');

    // Verify directly against the DB by exact id - no real booking/
    // provider write of any kind occurred; the only persisted state
    // change is this task's own jsonb result.
    const taskRow = await pool.query('select task_type, status, result from tasks where id = $1', [taskId]);
    expect(taskRow.rows[0].task_type).toBe('booking');
    expect(taskRow.rows[0].result.executionState).toBe('not_executed');
  });

  it('confirming without the exact confirmBookingTaskId never confirms anything, even with enthusiastic free text', async () => {
    const compareRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Yes book it now, confirm, go ahead, I am sure.',
      conversationId,
      bookingOfferId: offerId,
    });

    expect(intentRes.body.route).toBe('booking_intent');
    expect(intentRes.body.result.bookingStatus).toBe('awaiting_confirmation');
  });

  it('DTO validation rejects a non-UUID confirmBookingTaskId before it ever reaches the Supervisor', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Confirm it.',
      confirmBookingTaskId: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
  });

  it('confirming an unknown booking taskId over HTTP returns 400, not a guess', async () => {
    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Confirm it.',
      confirmBookingTaskId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(400);
  });
});

afterAll(async () => {
  await pool.end();
});
