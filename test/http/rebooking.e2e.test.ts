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

describe('POST /companion/messages - hotel cancel-and-rebook (Phase 9)', () => {
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

  it('a full booked hotel -> rebooking request -> combined confirmation -> execution round trip cancels the old and books a new one', async () => {
    const { conversationId, bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const rebookRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({
        message: 'I want to change hotels.',
        conversationId,
        rebookBookingId: bookingId,
        rebookLocation: 'Connaught Place',
      });
    expect(rebookRes.status).toBe(200);
    expect(rebookRes.body.route).toBe('rebooking_intent');
    expect(rebookRes.body.result.cancellationConsequences.fee).toBeNull();
    expect(rebookRes.body.result.cancellationConsequences.refund).toBeNull();
    expect(rebookRes.body.result.cancellationConsequences.refundStatus).toBe('unavailable');
    expect(rebookRes.body.result.newOffer.price).toBeGreaterThan(0);
    const rebookingTaskId = rebookRes.body.result.taskId;
    trackedTaskIds.push(rebookRes.body.result.cancellationTaskId);

    const confirmRes = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Yes, confirmed.', conversationId, confirmRebookingTaskId: rebookingTaskId });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.route).toBe('rebooking_executed');
    expect(confirmRes.body.result.outcome).toBe('completed');
    expect(confirmRes.body.result.originalBooking.status).toBe('cancelled');
    expect(confirmRes.body.result.newBooking.status).toBe('booked');
    trackedTaskIds.push(confirmRes.body.result.newBooking.taskId);

    const oldRow = await pool.query('select status from bookings where id = $1', [bookingId]);
    expect(oldRow.rows[0].status).toBe('cancelled');
    const newRow = await pool.query('select status from bookings where id = $1', [confirmRes.body.result.newBooking.id]);
    expect(newRow.rows[0].status).toBe('booked');
  });

  it('saying "cancel it, rebook it, yes, go ahead" as free text alone never triggers a rebooking', async () => {
    const { conversationId, bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Cancel it, rebook it, yes, go ahead, I am sure, do it now.', conversationId });

    const row = await pool.query('select status from bookings where id = $1', [bookingId]);
    expect(row.rows[0].status).toBe('booked');
  });

  it('an unrelated conversation cannot rebook another conversation\'s booking', async () => {
    const { bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const otherConversationRes = await request(app.getHttpServer()).post('/companion/messages').send({ message: 'hi' });
    const otherConversationId = otherConversationRes.body.conversationId;

    const res = await request(app.getHttpServer()).post('/companion/messages').send({
      message: 'Rebook this.',
      conversationId: otherConversationId,
      rebookBookingId: bookingId,
      rebookLocation: 'Connaught Place',
    });
    expect(res.status).toBe(400);
  });

  it('DTO validation rejects a malformed UUID for rebookBookingId before it ever reaches the Supervisor', async () => {
    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Rebook this.', rebookBookingId: 'not-a-uuid', rebookLocation: 'Connaught Place' });
    expect(res.status).toBe(400);
  });

  it('rebookBookingId without rebookLocation is rejected rather than guessing a location', async () => {
    const { bookingId, taskId } = await bookAHotel(app);
    trackedTaskIds.push(taskId);

    const res = await request(app.getHttpServer())
      .post('/companion/messages')
      .send({ message: 'Rebook this.', rebookBookingId: bookingId });
    expect(res.status).toBe(400);
  });
});
