import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../src/http/app.module';
import { LLM_PROVIDER, POOL, WRITE_PROVIDER } from '../../src/http/tokens';
import { FakeLlmProvider } from '../../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../../src/providers/sandbox-write-provider';
import { deleteBookingsByTaskIds } from '../helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('POST /companion/messages - booking execution (Phase 7)', () => {
  let app: INestApplication;
  const trackedTaskIds: string[] = [];

  beforeAll(async () => {
    const llm = new FakeLlmProvider(JSON.stringify({ narrative: 'A short comparison.', highlights: [] }));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .overrideProvider(POOL)
      .useValue(pool)
      .overrideProvider(WRITE_PROVIDER)
      .useValue(new SandboxWriteProvider())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await deleteBookingsByTaskIds(pool, trackedTaskIds);
    await pool.end();
  });

  it('a full comparison -> booking intent -> confirmation -> execution round trip books successfully, and a second execution request does not create another booking', async () => {
    const compareRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' });
    expect(compareRes.status).toBe(200);
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'I want to book this.', conversationId, bookingOfferId: offerId });
    expect(intentRes.status).toBe(200);
    expect(intentRes.body.route).toBe('booking_intent');
    const taskId = intentRes.body.result.taskId;
    trackedTaskIds.push(taskId);

    const confirmRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Yes, confirmed.', conversationId, confirmBookingTaskId: taskId });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.route).toBe('booking_confirmed');

    const executeRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Go ahead and book it now.', conversationId, executeBookingTaskId: taskId });
    expect(executeRes.status).toBe(200);
    expect(executeRes.body.route).toBe('booking_executed');
    expect(executeRes.body.result.status).toBe('booked');
    expect(executeRes.body.result.externalBookingId).toBeTruthy();
    const firstExternalRef = executeRes.body.result.externalBookingId;

    const secondExecuteRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Book it again please.', conversationId, executeBookingTaskId: taskId });
    expect(secondExecuteRes.status).toBe(200);
    expect(secondExecuteRes.body.result.status).toBe('booked');
    expect(secondExecuteRes.body.result.externalBookingId).toBe(firstExternalRef);

    const bookingRow = await pool.query('select count(*)::int as count from bookings where task_id = $1', [taskId]);
    expect(bookingRow.rows[0].count).toBe(1);
  });

  it('saying "book this" with enthusiastic free text alone never executes anything without the exact executeBookingTaskId', async () => {
    const compareRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' });
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({
        message: 'Book this hotel now, yes confirm it, go ahead, execute it, I am sure.',
        conversationId,
        bookingOfferId: offerId,
      });
    expect(intentRes.body.route).toBe('booking_intent');
    trackedTaskIds.push(intentRes.body.result.taskId);

    const bookingRow = await pool.query('select count(*)::int as count from bookings where task_id = $1', [
      intentRes.body.result.taskId,
    ]);
    expect(bookingRow.rows[0].count).toBe(0);
  });

  it('executing without prior confirmation is rejected over HTTP', async () => {
    const compareRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' });
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Book this.', conversationId, bookingOfferId: offerId });
    trackedTaskIds.push(intentRes.body.result.taskId);

    const executeRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Execute it.', conversationId, executeBookingTaskId: intentRes.body.result.taskId });
    expect(executeRes.status).toBe(400);
  });

  it('an unrelated conversation cannot execute another conversation\'s booking', async () => {
    const compareRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' });
    const offerId = compareRes.body.result.offers[0].offerId;
    const conversationId = compareRes.body.conversationId;

    const intentRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Book this.', conversationId, bookingOfferId: offerId });
    trackedTaskIds.push(intentRes.body.result.taskId);

    await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Confirm it.', conversationId, confirmBookingTaskId: intentRes.body.result.taskId });

    const otherConversationRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'hi' });
    const otherConversationId = otherConversationRes.body.conversationId;

    const executeRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({
        message: 'Execute it.',
        conversationId: otherConversationId,
        executeBookingTaskId: intentRes.body.result.taskId,
      });
    expect(executeRes.status).toBe(400);
  });

  it('DTO validation rejects a non-UUID executeBookingTaskId before it ever reaches the Supervisor', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Execute it.', executeBookingTaskId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});
