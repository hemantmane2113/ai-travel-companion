import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { executeBookingIntent } from '../src/agents/booking-agent';
import { createBookingIntent, confirmBookingIntent } from '../src/booking/booking-intent';
import { insertExecutingBooking, getBookingByTaskId, listBookingEvents } from '../src/booking/bookings';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import type { PreparedBooking, WriteProvider, BookingConfirmation, CancellationConfirmation } from '../src/providers/write-provider';
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
  getStatusCalls = 0;
  constructor(private readonly inner: WriteProvider) {}
  async prepare(offerId: string) {
    return this.inner.prepare(offerId);
  }
  async execute(prepared: PreparedBooking, idempotencyKey: string): Promise<BookingConfirmation> {
    this.executeCalls += 1;
    return this.inner.execute(prepared, idempotencyKey);
  }
  async getStatus(idempotencyKey: string): Promise<BookingConfirmation> {
    this.getStatusCalls += 1;
    return this.inner.getStatus(idempotencyKey);
  }
  async cancel(providerBookingRef: string, idempotencyKey: string): Promise<CancellationConfirmation> {
    return this.inner.cancel(providerBookingRef, idempotencyKey);
  }
  async getCancellationStatus(idempotencyKey: string): Promise<CancellationConfirmation> {
    return this.inner.getCancellationStatus(idempotencyKey);
  }
}

async function setupConfirmedIntent(conversationId: string, failOfferIds: string[] = []) {
  const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
    domains: ['hotel'],
    location: 'Karol Bagh',
    conversationId,
  });
  const offer = result.offers[0];
  const intent = await createBookingIntent(pool, conversationId, offer.offerId);
  await confirmBookingIntent(pool, conversationId, intent.taskId);
  trackedTaskIds.push(intent.taskId);
  const provider = new SandboxWriteProvider({ failOfferIds });
  return { taskId: intent.taskId, idempotencyKey: intent.idempotencyKey, offer, provider };
}

describe('executeBookingIntent (the Booking Agent)', () => {
  it('executes a confirmed booking intent through the WriteProvider and persists a booked row', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, idempotencyKey, offer, provider } = await setupConfirmedIntent(conversationId);

    const booking = await executeBookingIntent(pool, provider, conversationId, taskId);

    expect(booking.status).toBe('booked');
    expect(booking.externalBookingId).toBeTruthy();
    expect(booking.taskId).toBe(taskId);
    expect(booking.conversationId).toBe(conversationId);
    expect(booking.provider).toBe(offer.provider);
    expect(booking.domain).toBe(offer.domain);
    expect(booking.idempotencyKey).toBe(idempotencyKey);
    expect(booking.offerSnapshot.offerId).toBe(offer.offerId);
  });

  it('persists the full execution event history in order: requested, started, succeeded', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, provider } = await setupConfirmedIntent(conversationId);

    const booking = await executeBookingIntent(pool, provider, conversationId, taskId);
    const events = await listBookingEvents(pool, booking.id);

    expect(events.map((e) => e.eventType)).toEqual(['execution_requested', 'execution_started', 'booking_succeeded']);
    expect(events[2].externalReference).toBe(booking.externalBookingId);
  });

  it('rejects execution of a booking intent that has not been confirmed yet', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const intent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    trackedTaskIds.push(intent.taskId);

    await expect(executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, intent.taskId)).rejects.toThrow(
      /has not been confirmed yet/,
    );
  });

  it('rejects execution of an expired booking intent, even though it was confirmed', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, provider } = await setupConfirmedIntent(conversationId);

    await pool.query(`update tasks set result = jsonb_set(result, '{expiresAt}', '"2000-01-01T00:00:00.000Z"') where id = $1`, [
      taskId,
    ]);

    await expect(executeBookingIntent(pool, provider, conversationId, taskId)).rejects.toThrow(/expired/);
  });

  it('rejects execution of an unknown taskId, never guessing', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, randomUUID()),
    ).rejects.toThrow(/Unknown booking to execute/);
  });

  it('rejects execution against a conversation that does not own this booking task', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const { taskId, provider } = await setupConfirmedIntent(conversationId);

    await expect(executeBookingIntent(pool, provider, otherConversationId, taskId)).rejects.toThrow(
      /Unknown booking to execute/,
    );
  });

  it('rejects execution of a comparison task id passed as if it were a booking task', async () => {
    const conversationId = await createConversation(pool);
    const { taskId: comparisonTaskId } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    await expect(executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, comparisonTaskId)).rejects.toThrow(
      /Unknown booking to execute/,
    );
  });

  it('a provider failure produces a persisted failed state, never a false success', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, offer, provider } = await setupConfirmedIntent(conversationId, []);
    const failingProvider = new SandboxWriteProvider({ failOfferIds: [offer.offerId] });

    const booking = await executeBookingIntent(pool, failingProvider, conversationId, taskId);

    expect(booking.status).toBe('failed');
    expect(booking.externalBookingId).toBeNull();

    const events = await listBookingEvents(pool, booking.id);
    expect(events.map((e) => e.eventType)).toEqual(['execution_requested', 'execution_started', 'booking_failed']);
    void provider;
  });

  it('an already-booked intent returns the existing booking on a repeated request, never calling the provider again', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, provider } = await setupConfirmedIntent(conversationId);
    const counting = new CountingWriteProvider(provider);

    const first = await executeBookingIntent(pool, counting, conversationId, taskId);
    const second = await executeBookingIntent(pool, counting, conversationId, taskId);

    expect(second).toEqual(first);
    expect(counting.executeCalls).toBe(1);
  });

  it('a failed intent also returns the existing failed booking on a repeated request, never retrying automatically', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, offer } = await setupConfirmedIntent(conversationId);
    const counting = new CountingWriteProvider(new SandboxWriteProvider({ failOfferIds: [offer.offerId] }));

    const first = await executeBookingIntent(pool, counting, conversationId, taskId);
    const second = await executeBookingIntent(pool, counting, conversationId, taskId);

    expect(first.status).toBe('failed');
    expect(second).toEqual(first);
    expect(counting.executeCalls).toBe(1);
  });

  it('recovers a booking stuck in "executing" (application retry after provider success but before local persistence) without duplicating it', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const intent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, intent.taskId);
    trackedTaskIds.push(intent.taskId);

    const provider = new SandboxWriteProvider();
    const counting = new CountingWriteProvider(provider);

    // Simulate: the write actually succeeded against the provider, but
    // our own process crashed before persisting the result locally - the
    // bookings row is claimed ('executing') and the provider already has
    // a confirmation cached under this exact idempotency key.
    const prepared: PreparedBooking = {
      offerId: offer.offerId,
      provider: offer.provider,
      domain: offer.domain,
      price: offer.price,
      currency: offer.currency,
      cancellationPolicy: (offer as { cancellationPolicy?: string }).cancellationPolicy ?? null,
      expiresAt: intent.expiresAt,
    };
    const outOfBandConfirmation = await provider.execute(prepared, intent.idempotencyKey);

    const claimed = await insertExecutingBooking(pool, {
      taskId: intent.taskId,
      conversationId,
      provider: offer.provider,
      domain: offer.domain,
      idempotencyKey: intent.idempotencyKey,
      offerSnapshot: {
        offerId: offer.offerId,
        provider: offer.provider,
        domain: offer.domain,
        price: offer.price,
        currency: offer.currency,
        cancellationPolicy: (offer as { cancellationPolicy?: string }).cancellationPolicy ?? null,
      },
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('executing');

    const recovered = await executeBookingIntent(pool, counting, conversationId, intent.taskId);

    expect(recovered.status).toBe('booked');
    expect(recovered.externalBookingId).toBe(outOfBandConfirmation.providerBookingRef);
    // The agent must recover via getStatus, never by calling execute()
    // again (which would risk a second, duplicate provider booking).
    expect(counting.executeCalls).toBe(0);
    expect(counting.getStatusCalls).toBeGreaterThan(0);

    const events = await listBookingEvents(pool, claimed!.id);
    expect(events.map((e) => e.eventType)).toEqual(['execution_requested', 'booking_succeeded']);
    expect(events[1].payload).toEqual({ recoveredViaStatusCheck: true });
  });

  it('the idempotency key is reused verbatim from the booking intent - never regenerated by execution', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, idempotencyKey, provider } = await setupConfirmedIntent(conversationId);

    const booking = await executeBookingIntent(pool, provider, conversationId, taskId);

    expect(booking.idempotencyKey).toBe(idempotencyKey);
  });

  it('a database-level guard prevents two concurrent execution attempts from both calling the provider', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, provider } = await setupConfirmedIntent(conversationId);
    const counting = new CountingWriteProvider(provider);

    const [a, b] = await Promise.all([
      executeBookingIntent(pool, counting, conversationId, taskId),
      executeBookingIntent(pool, counting, conversationId, taskId),
    ]);

    expect(a.status).toBe('booked');
    expect(b.status).toBe('booked');
    expect(a.externalBookingId).toBe(b.externalBookingId);
    expect(counting.executeCalls).toBe(1);
  });
});
