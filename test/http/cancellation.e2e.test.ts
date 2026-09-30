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

async function bookAHotel(app: INestApplication): Promise<{ conversationId: string; bookingId: string; taskId: string }> {
  const compareRes = await request(app.getHttpServer())
    .post('/companion/messages')
    .send({ message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' });
  const offerId = compareRes.body.result.offers[0].offerId;
  const conversationId = compareRes.body.conversationId;

  const intentRes = await request(app.getHttpServer())
    .post('/companion/messages')
    .send({ message: 'I want to book this.', conversationId, bookingOfferId: offerId });
  const taskId = intentRes.body.result.taskId;

  await request(app.getHttpServer())
    .post('/companion/messages')
    .send({ message: 'Yes, confirmed.', conversationId, confirmBookingTaskId: taskId });

  const executeRes = await request(app.getHttpServer())
    .post('/companion/messages')
    .send({ message: 'Go ahead and book it.', conversationId, executeBookingTaskId: taskId });

  return { conversationId, bookingId: executeRes.body.result.id, taskId };
}

describe('POST /companion/messages - cancellation (Phase 8)', () => {
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

  it('a full booked booking -> cancellation request -> confirmation -> execution round trip cancels successfully with a full event history', async () => {
    const { conversationId, bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const cancelRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'I want to cancel this booking.', conversationId, cancelBookingId: bookingId });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.route).toBe('cancellation_intent');
    expect(cancelRes.body.result.cancellationStatus).toBe('awaiting_confirmation');
    const cancellationTaskId = cancelRes.body.result.taskId;

    const confirmRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Yes, confirmed, cancel it.', conversationId, confirmCancellationTaskId: cancellationTaskId });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.route).toBe('cancellation_executed');
    expect(confirmRes.body.result.status).toBe('cancelled');
    expect(confirmRes.body.result.id).toBe(bookingId);

    const bookingRow = await pool.query('select status from bookings where id = $1', [bookingId]);
    expect(bookingRow.rows[0].status).toBe('cancelled');

    const events = await pool.query(
      `select event_type from booking_events where booking_id = $1 order by created_at, id`,
      [bookingId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'execution_requested',
      'execution_started',
      'booking_succeeded',
      'cancellation_requested',
      'cancellation_started',
      'cancellation_succeeded',
    ]);
  });

  it('a provider cancellation failure leaves the booking booked, never falsely reporting success', async () => {
    const failingLlm = new FakeLlmProvider(JSON.stringify({ narrative: 'A short comparison.', highlights: [] }));
    const failModuleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(failingLlm)
      .overrideProvider(POOL)
      .useValue(pool)
      .compile();
    const failApp = failModuleRef.createNestApplication();
    await failApp.init();

    try {
      const { conversationId, bookingId, taskId } = await bookAHotel(failApp);
      trackedTaskIds.push(taskId);

      const bookingRow = await pool.query('select external_booking_id from bookings where id = $1', [bookingId]);
      const externalBookingId = bookingRow.rows[0].external_booking_id;

      const failingProvider = new SandboxWriteProvider({ failCancellationForRefs: [externalBookingId] });
      const failModuleWithProvider = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(LLM_PROVIDER)
        .useValue(failingLlm)
        .overrideProvider(POOL)
        .useValue(pool)
        .overrideProvider(WRITE_PROVIDER)
        .useValue(failingProvider)
        .compile();
      const failingApp = failModuleWithProvider.createNestApplication();
      await failingApp.init();

      try {
        const cancelRes = await request(failingApp.getHttpServer())
          .post('/companion/messages')
          .send({ message: 'Cancel this.', conversationId, cancelBookingId: bookingId });
        const cancellationTaskId = cancelRes.body.result.taskId;

        const confirmRes = await request(failingApp.getHttpServer())
          .post('/companion/messages')
          .send({ message: 'Yes, confirmed.', conversationId, confirmCancellationTaskId: cancellationTaskId });

        expect(confirmRes.status).toBe(200);
        expect(confirmRes.body.route).toBe('cancellation_executed');
        expect(confirmRes.body.result.status).toBe('booked');

        const finalRow = await pool.query('select status from bookings where id = $1', [bookingId]);
        expect(finalRow.rows[0].status).toBe('booked');

        const events = await pool.query(
          `select event_type from booking_events where booking_id = $1 order by created_at, id`,
          [bookingId],
        );
        expect(events.rows.map((r) => r.event_type)).toContain('cancellation_failed');
      } finally {
        await failingApp.close();
      }
    } finally {
      await failApp.close();
    }
  });

  it('saying "cancel it, yes, go ahead, please cancel, I am sure" as free text alone never cancels a booking', async () => {
    const { conversationId, bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel it, yes, go ahead, please cancel, I am sure, do it now.', conversationId });

    const bookingRow = await pool.query('select status from bookings where id = $1', [bookingId]);
    expect(bookingRow.rows[0].status).toBe('booked');
  });

  it('an unrelated conversation cannot cancel another conversation\'s booking', async () => {
    const { bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const otherConversationRes = await request(app.getHttpServer()).post('/companion/messages').send({ message: 'hi' });
    const otherConversationId = otherConversationRes.body.conversationId;

    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel this.', conversationId: otherConversationId, cancelBookingId: bookingId });
    expect(res.status).toBe(400);
  });

  it('cancelling a non-existent booking id is rejected, never guessed at', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel this.', cancelBookingId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
  });

  it('DTO validation rejects a malformed UUID for cancelBookingId before it ever reaches the Supervisor', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel this.', cancelBookingId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('confirming cancellation of an already-cancelled booking returns the existing cancelled state idempotently', async () => {
    const { conversationId, bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const cancelRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel this.', conversationId, cancelBookingId: bookingId });
    const cancellationTaskId = cancelRes.body.result.taskId;

    const first = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Confirm.', conversationId, confirmCancellationTaskId: cancellationTaskId });
    expect(first.body.result.status).toBe('cancelled');

    const second = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Confirm again.', conversationId, confirmCancellationTaskId: cancellationTaskId });
    expect(second.status).toBe(200);
    expect(second.body.result.status).toBe('cancelled');
    expect(second.body.result.id).toBe(bookingId);
  });
});
