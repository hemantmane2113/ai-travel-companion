import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createCancellationIntent, confirmCancellationIntent, executeCancellationIntent } from '../src/agents/cancellation-agent';
import { createBookingIntent, confirmBookingIntent } from '../src/booking/booking-intent';
import { executeBookingIntent } from '../src/agents/booking-agent';
import { insertKnowledgeDocument } from '../src/knowledge/knowledge-documents';
import { getBookingById, listBookingEvents } from '../src/booking/bookings';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import type { PreparedBooking, WriteProvider, BookingConfirmation, CancellationConfirmation } from '../src/providers/write-provider';
import { deleteBookingsByTaskIds, deleteKnowledgeDocumentsByIds } from './helpers/db-cleanup';

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
  cancelCalls = 0;
  getCancellationStatusCalls = 0;
  constructor(private readonly inner: WriteProvider) {}
  async prepare(offerId: string) {
    return this.inner.prepare(offerId);
  }
  async execute(prepared: PreparedBooking, idempotencyKey: string): Promise<BookingConfirmation> {
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
    this.getCancellationStatusCalls += 1;
    return this.inner.getCancellationStatus(idempotencyKey);
  }
}

async function setupBookedBooking(conversationId: string, provider: SandboxWriteProvider = new SandboxWriteProvider()) {
  const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
    domains: ['hotel'],
    location: 'Karol Bagh',
    conversationId,
  });
  const offer = result.offers[0];
  const intent = await createBookingIntent(pool, conversationId, offer.offerId);
  await confirmBookingIntent(pool, conversationId, intent.taskId);
  trackedTaskIds.push(intent.taskId);
  const booking = await executeBookingIntent(pool, provider, conversationId, intent.taskId);
  return { booking, offer, provider };
}

describe('createCancellationIntent', () => {
  it('identifies the exact booking by its own id and computes a policy/consequence snapshot', async () => {
    const conversationId = await createConversation(pool);
    const { booking, offer } = await setupBookedBooking(conversationId);

    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    expect(intent.bookingId).toBe(booking.id);
    expect(intent.provider).toBe(offer.provider);
    expect(intent.externalBookingId).toBe(booking.externalBookingId);
    expect(intent.cancellationStatus).toBe('awaiting_confirmation');
    expect(intent.idempotencyKey).toBeTruthy();
    expect(intent.taskId).toBeTruthy();
  });

  it('never fabricates a refund - reports refundStatus unavailable given only a free-text policy string', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedBooking(conversationId);

    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    expect(intent.policy.status).toBe('known');
    expect(intent.policy.source).toBe('structured_offer_field');
    expect(intent.consequences.fee).toBeNull();
    expect(intent.consequences.refund).toBeNull();
    expect(intent.consequences.refundStatus).toBe('unavailable');
  });

  it('falls back to RAG knowledge retrieval for the policy when the booking has no structured cancellationPolicy', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const booking = await executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, bookingIntent.taskId);
    expect(booking.offerSnapshot.cancellationPolicy).toBeNull();

    const doc = await insertKnowledgeDocument(pool, {
      category: 'cancellation_policy',
      title: `${offer.provider} cancellation policy`,
      content: `${offer.provider} allows free cancellation up to 24 hours before departure.`,
      sourceName: 'Test Cancellation Policy Source',
    });

    try {
      const intent = await createCancellationIntent(pool, conversationId, booking.id);
      expect(intent.policy.status).toBe('known');
      expect(intent.policy.source).toBe('knowledge_retrieval');
      expect(intent.policy.policy).toBe(doc.content);
    } finally {
      await deleteKnowledgeDocumentsByIds(pool, [doc.id]);
    }
  });

  it('honestly reports the policy as unavailable when no structured field or knowledge document exists', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const booking = await executeBookingIntent(pool, new SandboxWriteProvider(), conversationId, bookingIntent.taskId);

    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    expect(intent.policy.status).toBe('unavailable');
    expect(intent.policy.policy).toBeNull();
  });

  it('rejects an unknown booking id, never guessing', async () => {
    const conversationId = await createConversation(pool);
    await expect(createCancellationIntent(pool, conversationId, randomUUID())).rejects.toThrow(/can't find booking/);
  });

  it('rejects a booking belonging to a different conversation', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const { booking } = await setupBookedBooking(conversationId);

    await expect(createCancellationIntent(pool, otherConversationId, booking.id)).rejects.toThrow(/can't find booking/);
  });

  it('rejects a booking that is not yet in a completed booked state', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const failing = await executeBookingIntent(
      pool,
      new SandboxWriteProvider({ failOfferIds: [result.offers[0].offerId] }),
      conversationId,
      bookingIntent.taskId,
    );
    expect(failing.status).toBe('failed');

    await expect(createCancellationIntent(pool, conversationId, failing.id)).rejects.toThrow(/not in a cancellable state/);
  });

  it('rejects creating a new cancellation intent for an already-cancelled booking', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);

    const cancelIntent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, cancelIntent.taskId);
    await executeCancellationIntent(pool, provider, conversationId, cancelIntent.taskId);

    await expect(createCancellationIntent(pool, conversationId, booking.id)).rejects.toThrow(/already cancelled/);
  });

  it('can identify one exact booking among several for the same conversation without ambiguity', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking: bookingA } = await setupBookedBooking(conversationId, provider);
    const { booking: bookingB } = await setupBookedBooking(conversationId, provider);

    const intent = await createCancellationIntent(pool, conversationId, bookingB.id);

    expect(intent.bookingId).toBe(bookingB.id);
    expect(intent.bookingId).not.toBe(bookingA.id);
  });
});

describe('confirmCancellationIntent', () => {
  it('transitions cancellationStatus to confirmed only when given the exact taskId', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedBooking(conversationId);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    const confirmed = await confirmCancellationIntent(pool, conversationId, intent.taskId);

    expect(confirmed.cancellationStatus).toBe('confirmed');
    expect(confirmed.idempotencyKey).toBe(intent.idempotencyKey);
  });

  it('is idempotent - confirming an already-confirmed cancellation again returns the same state', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedBooking(conversationId);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    const first = await confirmCancellationIntent(pool, conversationId, intent.taskId);
    const second = await confirmCancellationIntent(pool, conversationId, intent.taskId);

    expect(second).toEqual(first);
  });

  it('rejects confirmation of an expired cancellation intent', async () => {
    const conversationId = await createConversation(pool);
    const { booking } = await setupBookedBooking(conversationId);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    await pool.query(`update tasks set result = jsonb_set(result, '{expiresAt}', '"2000-01-01T00:00:00.000Z"') where id = $1`, [
      intent.taskId,
    ]);

    await expect(confirmCancellationIntent(pool, conversationId, intent.taskId)).rejects.toThrow(/expired/);
  });

  it('rejects confirmation of a booking task id passed as if it were a cancellation task', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    trackedTaskIds.push(bookingIntent.taskId);

    await expect(confirmCancellationIntent(pool, conversationId, bookingIntent.taskId)).rejects.toThrow(/Unknown cancellation to confirm/);
  });
});

describe('executeCancellationIntent (the Cancellation Agent)', () => {
  it('cancels a confirmed cancellation intent through the WriteProvider and persists cancelled state', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    const result = await executeCancellationIntent(pool, provider, conversationId, intent.taskId);

    expect(result.status).toBe('cancelled');
    expect(result.id).toBe(booking.id);
  });

  it('persists the full cancellation event history in order: requested, started, succeeded', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    await executeCancellationIntent(pool, provider, conversationId, intent.taskId);
    const events = await listBookingEvents(pool, booking.id);

    expect(events.map((e) => e.eventType)).toEqual([
      'execution_requested',
      'execution_started',
      'booking_succeeded',
      'cancellation_requested',
      'cancellation_started',
      'cancellation_succeeded',
    ]);
  });

  it('rejects execution of an unconfirmed cancellation intent', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);

    await expect(executeCancellationIntent(pool, provider, conversationId, intent.taskId)).rejects.toThrow(/has not been confirmed yet/);
  });

  it('rejects execution against an unknown taskId', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      executeCancellationIntent(pool, new SandboxWriteProvider(), conversationId, randomUUID()),
    ).rejects.toThrow(/Unknown cancellation to execute/);
  });

  it('rejects execution against a conversation that does not own this cancellation task', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    await expect(executeCancellationIntent(pool, provider, otherConversationId, intent.taskId)).rejects.toThrow(
      /Unknown cancellation to execute/,
    );
  });

  it('a provider cancellation failure leaves the booking booked, never cancelled, and records a failure event', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    const failingProvider = new SandboxWriteProvider({ failCancellationForRefs: [booking.externalBookingId!] });
    const result = await executeCancellationIntent(pool, failingProvider, conversationId, intent.taskId);

    expect(result.status).toBe('booked');
    const events = await listBookingEvents(pool, booking.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'execution_requested',
      'execution_started',
      'booking_succeeded',
      'cancellation_requested',
      'cancellation_started',
      'cancellation_failed',
    ]);
  });

  it('repeated cancellation after success returns the existing cancelled state, never calling the provider again', async () => {
    const conversationId = await createConversation(pool);
    const inner = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, inner);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    const counting = new CountingWriteProvider(inner);
    const first = await executeCancellationIntent(pool, counting, conversationId, intent.taskId);
    const second = await executeCancellationIntent(pool, counting, conversationId, intent.taskId);

    expect(second).toEqual(first);
    expect(counting.cancelCalls).toBe(1);
  });

  it('recovers a cancellation stuck in "cancelling" (provider succeeded before local persistence) without duplicating it', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    // Simulate: the provider cancellation actually succeeded, but our
    // own process crashed before persisting it locally.
    const outOfBandConfirmation = await provider.cancel(booking.externalBookingId!, intent.idempotencyKey);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [booking.id]);

    const counting = new CountingWriteProvider(provider);
    const recovered = await executeCancellationIntent(pool, counting, conversationId, intent.taskId);

    expect(recovered.status).toBe('cancelled');
    expect(counting.cancelCalls).toBe(0);
    expect(counting.getCancellationStatusCalls).toBeGreaterThan(0);

    const events = await listBookingEvents(pool, booking.id);
    expect(events[events.length - 1].eventType).toBe('cancellation_succeeded');
    expect(events[events.length - 1].externalReference).toBe(outOfBandConfirmation.cancellationRef);
  });

  it('a database-level guard prevents two concurrent cancellation attempts from both calling the provider', async () => {
    const conversationId = await createConversation(pool);
    const inner = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, inner);
    const intent = await createCancellationIntent(pool, conversationId, booking.id);
    await confirmCancellationIntent(pool, conversationId, intent.taskId);

    const counting = new CountingWriteProvider(inner);
    const [a, b] = await Promise.all([
      executeCancellationIntent(pool, counting, conversationId, intent.taskId),
      executeCancellationIntent(pool, counting, conversationId, intent.taskId),
    ]);

    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('cancelled');
    expect(counting.cancelCalls).toBe(1);
  });

  it('rejects cancellation of a booking that was never successfully executed', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const failing = await executeBookingIntent(
      pool,
      new SandboxWriteProvider({ failOfferIds: [result.offers[0].offerId] }),
      conversationId,
      bookingIntent.taskId,
    );
    expect(failing.status).toBe('failed');

    await expect(createCancellationIntent(pool, conversationId, failing.id)).rejects.toThrow(/not in a cancellable state/);
  });

  it('getBookingById returns the persisted, provider-confirmed status directly - never reconstructed by the LLM', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedBooking(conversationId, provider);

    const reread = await getBookingById(pool, booking.id);
    expect(reread!.status).toBe('booked');
  });
});
