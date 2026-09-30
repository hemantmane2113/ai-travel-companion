import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createRebookingIntent, confirmRebookingIntent, executeRebookingIntent } from '../src/agents/rebooking-agent';
import { searchHotelOffersOnly } from '../src/agents/comparison-agent';
import { createBookingIntent, confirmBookingIntent } from '../src/booking/booking-intent';
import { executeBookingIntent } from '../src/agents/booking-agent';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import { MockHotelProvider } from '../src/providers/mock-hotel-provider';
import type {
  PreparedBooking,
  WriteProvider,
  BookingConfirmation,
  CancellationConfirmation,
} from '../src/providers/write-provider';
import { deleteBookingsByTaskIds } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

let trackedTaskIds: string[] = [];
afterEach(async () => {
  await deleteBookingsByTaskIds(pool, trackedTaskIds);
  trackedTaskIds = [];
});

class CountingWriteProvider implements WriteProvider {
  readonly providerName = 'CountingWriteProvider';
  executeCalls = 0;
  cancelCalls = 0;
  constructor(private readonly inner: WriteProvider) {}
  async prepare(offerId: string) {
    return this.inner.prepare(offerId);
  }
  async execute(prepared: PreparedBooking, idempotencyKey: string): Promise<BookingConfirmation> {
    this.executeCalls += 1;
    return this.inner.execute(prepared, idempotencyKey);
  }
  async getStatus(idempotencyKey: string): Promise<BookingConfirmation> {
    return this.inner.getStatus(idempotencyKey);
  }
  async cancel(providerBookingRef: string, idempotencyKey: string): Promise<CancellationConfirmation> {
    this.cancelCalls += 1;
    return this.inner.cancel(providerBookingRef, idempotencyKey);
  }
  async getCancellationStatus(idempotencyKey: string): Promise<CancellationConfirmation> {
    return this.inner.getCancellationStatus(idempotencyKey);
  }
}

async function setupBookedHotel(conversationId: string, provider: SandboxWriteProvider = new SandboxWriteProvider()) {
  const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
    domains: ['hotel'],
    location: 'Karol Bagh',
    conversationId,
  });
  const offer = result.offers[0];
  const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
  await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
  trackedTaskIds.push(bookingIntent.taskId);
  const booking = await executeBookingIntent(pool, provider, conversationId, bookingIntent.taskId);
  return { booking, offer, provider };
}

describe('createRebookingIntent', () => {
  it('identifies the exact booking, creates an inner cancellation intent, and quotes the cheapest fresh offer', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);

    const preview = await searchHotelOffersOnly({ location: 'Connaught Place' }, [new MockHotelProvider()]);

    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    expect(intent.originalBookingId).toBe(booking.id);
    expect(intent.rebookingStatus).toBe('awaiting_confirmation');
    expect(intent.outcome).toBe('pending');
    expect(intent.newOffer.offerId).toBe(preview.cheapestOfferId);
    expect(intent.newBookingTaskId).toBeNull();
  });

  it('never fabricates a fee/refund/net cost - reuses Phase 8\'s honestly-unavailable calculation', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);

    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    expect(intent.cancellationConsequences.fee).toBeNull();
    expect(intent.cancellationConsequences.refund).toBeNull();
    expect(intent.cancellationConsequences.refundStatus).toBe('unavailable');
    // The new offer's real quoted price IS shown.
    expect(intent.newOffer.price).toBeGreaterThan(0);
  });

  it('rejects rebooking for a non-hotel booking domain', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const booking = await executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, bookingIntent.taskId);

    await expect(createRebookingIntent(pool, conversationId, booking.id, 'Delhi')).rejects.toThrow(
      /only supported for hotel bookings/,
    );
  });

  it('rejects an unknown booking id, never guessing', async () => {
    const conversationId = await createConversation(pool);
    await expect(createRebookingIntent(pool, conversationId, randomUUID(), 'Connaught Place')).rejects.toThrow(
      /can't find booking/,
    );
  });

  it('rejects a booking belonging to a different conversation', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);

    await expect(createRebookingIntent(pool, otherConversationId, booking.id, 'Connaught Place')).rejects.toThrow(
      /can't find booking/,
    );
  });

  it('rejects rebooking a booking that is not currently in a booked state', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const failed = await executeBookingIntent(
      pool,
      new SandboxWriteProvider({ failOfferIds: [result.offers[0].offerId] }),
      conversationId,
      bookingIntent.taskId,
    );
    expect(failed.status).toBe('failed');

    await expect(createRebookingIntent(pool, conversationId, failed.id, 'Connaught Place')).rejects.toThrow(
      /not in a cancellable state/,
    );
  });
});

describe('confirmRebookingIntent', () => {
  it('transitions rebookingStatus to confirmed only when given the exact taskId', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    const confirmed = await confirmRebookingIntent(pool, conversationId, intent.taskId);
    expect(confirmed.rebookingStatus).toBe('confirmed');
  });

  it('is idempotent - confirming an already-confirmed rebooking again returns the same state', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    const first = await confirmRebookingIntent(pool, conversationId, intent.taskId);
    const second = await confirmRebookingIntent(pool, conversationId, intent.taskId);
    expect(second).toEqual(first);
  });

  it('rejects confirmation of a cancellation task id passed as if it were a rebooking task', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedHotel(conversationId);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    await expect(confirmRebookingIntent(pool, conversationId, intent.cancellationTaskId)).rejects.toThrow(
      /Unknown rebooking to confirm/,
    );
  });
});

describe('executeRebookingIntent (the composite)', () => {
  it('full success: cancels the original booking then books the new one, in that order', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const result = await executeRebookingIntent(pool, provider, conversationId, intent.taskId);
    if (result.newBooking) trackedTaskIds.push(result.newBooking.taskId);

    expect(result.outcome).toBe('completed');
    expect(result.originalBooking.status).toBe('cancelled');
    expect(result.newBooking!.status).toBe('booked');
    expect(result.newBooking!.offerSnapshot.offerId).toBe(intent.newOffer.offerId);
    expect(result.message).toMatch(/is confirmed/);
  });

  it('rejects execution of an unconfirmed rebooking intent', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);

    await expect(executeRebookingIntent(pool, provider, conversationId, intent.taskId)).rejects.toThrow(
      /has not been confirmed yet/,
    );
  });

  it('rejects execution against an unknown taskId', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      executeRebookingIntent(pool, new SandboxWriteProvider(), conversationId, randomUUID()),
    ).rejects.toThrow(/Unknown rebooking to execute/);
  });

  it('rejects execution against a conversation that does not own this rebooking task', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    await expect(executeRebookingIntent(pool, provider, otherConversationId, intent.taskId)).rejects.toThrow(
      /Unknown rebooking to execute/,
    );
  });

  it('cancellation failure: no rebooking is attempted, and the original booking remains booked', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const failingProvider = new SandboxWriteProvider({ failCancellationForRefs: [booking.externalBookingId!] });
    const result = await executeRebookingIntent(pool, failingProvider, conversationId, intent.taskId);

    expect(result.outcome).toBe('cancellation_failed');
    expect(result.originalBooking.status).toBe('booked');
    expect(result.newBooking).toBeNull();
  });

  it('cancellation succeeds but the new booking fails - the old booking stays cancelled, never falsely reported as rebooked', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);

    const preview = await searchHotelOffersOnly({ location: 'Connaught Place' }, [new MockHotelProvider()]);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const failingNewBookingProvider = new SandboxWriteProvider({ failOfferIds: [preview.cheapestOfferId!] });
    const result = await executeRebookingIntent(pool, failingNewBookingProvider, conversationId, intent.taskId);
    if (result.newBooking) trackedTaskIds.push(result.newBooking.taskId);

    expect(result.outcome).toBe('new_booking_failed_after_cancellation');
    expect(result.originalBooking.status).toBe('cancelled');
    expect(result.newBooking!.status).toBe('failed');
    expect(result.message).not.toMatch(/is confirmed/);
    expect(result.message).toMatch(/no active booking/);
  });

  it('repeated execution after completion returns the same result, never re-cancelling or double-booking', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const counting = new CountingWriteProvider(provider);
    const first = await executeRebookingIntent(pool, counting, conversationId, intent.taskId);
    if (first.newBooking) trackedTaskIds.push(first.newBooking.taskId);
    const second = await executeRebookingIntent(pool, counting, conversationId, intent.taskId);

    expect(second).toEqual(first);
    expect(counting.cancelCalls).toBe(1);
    expect(counting.executeCalls).toBe(1);
  });

  it('a rebooking stuck in "cancelling" (e.g. an interrupted process) is safely reported as still processing, never re-cancelled or double-booked', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    await pool.query(`update tasks set result = jsonb_set(result, '{outcome}', '"cancelling"') where id = $1`, [
      intent.taskId,
    ]);

    const counting = new CountingWriteProvider(provider);
    const result = await executeRebookingIntent(pool, counting, conversationId, intent.taskId);

    expect(result.outcome).toBe('cancelling');
    expect(result.message).toMatch(/already being processed/);
    expect(counting.cancelCalls).toBe(0);
    expect(counting.executeCalls).toBe(0);
  });

  it('a database-level guard ensures exactly one of two concurrent executions drives the composite to completion', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const counting = new CountingWriteProvider(provider);
    const [a, b] = await Promise.all([
      executeRebookingIntent(pool, counting, conversationId, intent.taskId),
      executeRebookingIntent(pool, counting, conversationId, intent.taskId),
    ]);
    for (const r of [a, b]) {
      if (r.newBooking) trackedTaskIds.push(r.newBooking.taskId);
    }

    expect([a.outcome, b.outcome]).toContain('completed');
    expect(counting.cancelCalls).toBe(1);
    expect(counting.executeCalls).toBe(1);
  });

  it('the new booking gets its own fresh idempotency key, distinct from the original booking\'s key', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const intent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(intent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, intent.taskId);

    const result = await executeRebookingIntent(pool, provider, conversationId, intent.taskId);
    if (result.newBooking) trackedTaskIds.push(result.newBooking.taskId);

    expect(result.newBooking!.idempotencyKey).toBeTruthy();
    expect(result.newBooking!.idempotencyKey).not.toBe(booking.idempotencyKey);
  });
});
