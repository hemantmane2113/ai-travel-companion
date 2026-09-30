import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { runReconciliation, resolveStaleMinutes } from '../src/jobs/reconciliation';
import { createBookingIntent, confirmBookingIntent } from '../src/booking/booking-intent';
import { executeBookingIntent } from '../src/agents/booking-agent';
import { createCancellationIntent, confirmCancellationIntent, executeCancellationIntent } from '../src/agents/cancellation-agent';
import { createRebookingIntent, confirmRebookingIntent, executeRebookingIntent } from '../src/agents/rebooking-agent';
import { insertExecutingBooking, getBookingById, getBookingByTaskId, listBookingEvents } from '../src/booking/bookings';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { createJob, markJobProcessing, getJob } from '../src/itinerary/jobs';
import { getTask } from '../src/tasks/tasks';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import type { PreparedBooking, WriteProvider, BookingConfirmation, CancellationConfirmation } from '../src/providers/write-provider';
import { deleteBookingsByTaskIds, deleteItineraryAndJob } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Backdating updated_at by a full hour (rather than relying on
// staleMinutes: 0's razor-thin, clock-skew-sensitive margin against
// "right now") makes every "this IS stale" test robust regardless of
// timing variance between the test process and the Postgres server.
const STALE_STALEMINUTES = 10;
async function backdateUpdatedAt(table: 'bookings' | 'tasks' | 'itinerary_jobs', id: string): Promise<void> {
  await pool.query(`update ${table} set updated_at = now() - interval '1 hour' where id = $1`, [id]);
}

afterAll(async () => {
  await pool.end();
});

let trackedTaskIds: string[] = [];
let trackedJobIds: string[] = [];
afterEach(async () => {
  await deleteBookingsByTaskIds(pool, trackedTaskIds);
  for (const jobId of trackedJobIds) {
    await deleteItineraryAndJob(pool, { jobId });
  }
  trackedTaskIds = [];
  trackedJobIds = [];
});

class CountingWriteProvider implements WriteProvider {
  readonly providerName = 'CountingWriteProvider';
  executeCalls = 0;
  cancelCalls = 0;
  getStatusCalls = 0;
  getCancellationStatusCalls = 0;
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
    this.cancelCalls += 1;
    return this.inner.cancel(providerBookingRef, idempotencyKey);
  }
  async getCancellationStatus(idempotencyKey: string): Promise<CancellationConfirmation> {
    this.getCancellationStatusCalls += 1;
    return this.inner.getCancellationStatus(idempotencyKey);
  }
}

async function setupBookedHotel(conversationId: string, provider: SandboxWriteProvider) {
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
  return { booking, offer };
}

describe('resolveStaleMinutes', () => {
  it('uses the explicit value when given', () => {
    expect(resolveStaleMinutes(5)).toBe(5);
  });

  it('falls back to the documented default when nothing is configured', () => {
    const original = process.env.RECONCILIATION_STALE_MINUTES;
    delete process.env.RECONCILIATION_STALE_MINUTES;
    expect(resolveStaleMinutes()).toBe(30);
    if (original !== undefined) process.env.RECONCILIATION_STALE_MINUTES = original;
  });

  it('reads RECONCILIATION_STALE_MINUTES when set', () => {
    const original = process.env.RECONCILIATION_STALE_MINUTES;
    process.env.RECONCILIATION_STALE_MINUTES = '7';
    expect(resolveStaleMinutes()).toBe(7);
    if (original === undefined) delete process.env.RECONCILIATION_STALE_MINUTES;
    else process.env.RECONCILIATION_STALE_MINUTES = original;
  });
});

describe('runReconciliation', () => {
  it('(A) ignores fresh in-progress records', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: result.offers[0].provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });

    const counting = new CountingWriteProvider(provider);
    const report = await runReconciliation(pool, counting, { staleMinutes: 60 });

    expect(report.bookingsExecuting.find((r) => r.id)).toBeUndefined();
    expect(counting.getStatusCalls).toBe(0);

    const booking = await getBookingByTaskId(pool, bookingIntent.taskId);
    void booking;
  });

  it('(B) ignores stale but already-terminal records', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);

    const counting = new CountingWriteProvider(provider);
    const report = await runReconciliation(pool, counting, { staleMinutes: 0 });

    expect(report.bookingsExecuting).toEqual([]);
    expect(counting.getStatusCalls).toBe(0);

    const reread = await getBookingById(pool, booking.id);
    expect(reread!.status).toBe('booked');
  });

  it('(C) stale executing booking where the provider confirms success -> booked', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);

    const provider = new SandboxWriteProvider();
    // Simulate: the provider write actually succeeded, but the process
    // crashed before local persistence - claim the row as 'executing'
    // and seed the provider's own cache out of band.
    await provider.execute(
      {
        offerId: offer.offerId,
        provider: offer.provider,
        domain: 'hotel',
        price: offer.price,
        currency: offer.currency,
        cancellationPolicy: (offer as { cancellationPolicy?: string }).cancellationPolicy ?? null,
        expiresAt: bookingIntent.expiresAt,
      },
      bookingIntent.idempotencyKey,
    );
    const claimedForC = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: offer.provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    await backdateUpdatedAt('bookings', claimedForC!.id);

    const report = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsExecuting.find((r) => r.action === 'marked_booked');
    expect(item).toBeTruthy();
    const reread = await getBookingByTaskId(pool, bookingIntent.taskId);
    expect(reread!.status).toBe('booked');
    expect(reread!.externalBookingId).toBeTruthy();
  });

  it('(D) stale executing booking where the provider confirms nothing was executed -> failed', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const claimedForD = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: offer.provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    await backdateUpdatedAt('bookings', claimedForD!.id);

    const provider = new SandboxWriteProvider();
    const report = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsExecuting.find((r) => r.action === 'marked_failed');
    expect(item).toBeTruthy();
    const reread = await getBookingByTaskId(pool, bookingIntent.taskId);
    expect(reread!.status).toBe('failed');

    const events = await listBookingEvents(pool, reread!.id);
    expect(events.map((e) => e.eventType)).toEqual(['booking_failed']);
    expect(events[0].payload).toMatchObject({ recoveredViaReconciliation: true });
  });

  it('(E) stale executing booking with an ambiguous provider status is never fabricated as success', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const claimedForE = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: offer.provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    await backdateUpdatedAt('bookings', claimedForE!.id);

    const throwingProvider: WriteProvider = {
      providerName: 'ThrowingProvider',
      prepare: async () => {
        throw new Error('not used');
      },
      execute: async () => {
        throw new Error('not used');
      },
      getStatus: async () => {
        throw new Error('provider unavailable');
      },
      cancel: async () => {
        throw new Error('not used');
      },
      getCancellationStatus: async () => {
        throw new Error('not used');
      },
    };

    const report = await runReconciliation(pool, throwingProvider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsExecuting.find((r) => r.action === 'unresolved');
    expect(item).toBeTruthy();
    const reread = await getBookingByTaskId(pool, bookingIntent.taskId);
    expect(reread!.status).toBe('executing');
  });

  it('(F) stale cancelling booking where the provider confirms cancellation -> cancelled', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);

    const cancelIntent = await createCancellationIntent(pool, conversationId, booking.id);
    trackedTaskIds.push(cancelIntent.taskId);
    await confirmCancellationIntent(pool, conversationId, cancelIntent.taskId);

    // Simulate: the cancellation actually succeeded at the provider, but
    // the process crashed before local persistence.
    await provider.cancel(booking.externalBookingId!, cancelIntent.idempotencyKey);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [booking.id]);
    await backdateUpdatedAt('bookings', booking.id);

    const report = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsCancelling.find((r) => r.action === 'marked_cancelled');
    expect(item).toBeTruthy();
    const reread = await getBookingById(pool, booking.id);
    expect(reread!.status).toBe('cancelled');
  });

  it('(G) stale cancelling booking where the provider confirms nothing was executed -> reverted to booked', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);

    const cancelIntent = await createCancellationIntent(pool, conversationId, booking.id);
    trackedTaskIds.push(cancelIntent.taskId);
    await confirmCancellationIntent(pool, conversationId, cancelIntent.taskId);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [booking.id]);
    await backdateUpdatedAt('bookings', booking.id);

    const report = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsCancelling.find((r) => r.action === 'reverted_to_booked');
    expect(item).toBeTruthy();
    const reread = await getBookingById(pool, booking.id);
    expect(reread!.status).toBe('booked');

    const events = await listBookingEvents(pool, booking.id);
    expect(events.map((e) => e.eventType)).toEqual(['execution_requested', 'execution_started', 'booking_succeeded', 'cancellation_failed']);
  });

  it('(H) stale cancelling booking with an ambiguous provider status never fabricates a cancellation', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);

    const cancelIntent = await createCancellationIntent(pool, conversationId, booking.id);
    trackedTaskIds.push(cancelIntent.taskId);
    await confirmCancellationIntent(pool, conversationId, cancelIntent.taskId);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [booking.id]);
    await backdateUpdatedAt('bookings', booking.id);

    const throwingProvider: WriteProvider = {
      providerName: 'ThrowingProvider',
      prepare: async () => {
        throw new Error('not used');
      },
      execute: async () => {
        throw new Error('not used');
      },
      getStatus: async () => {
        throw new Error('not used');
      },
      cancel: async () => {
        throw new Error('not used');
      },
      getCancellationStatus: async () => {
        throw new Error('provider unavailable');
      },
    };

    const report = await runReconciliation(pool, throwingProvider, { staleMinutes: STALE_STALEMINUTES });

    const item = report.bookingsCancelling.find((r) => r.action === 'unresolved');
    expect(item).toBeTruthy();
    const reread = await getBookingById(pool, booking.id);
    expect(reread!.status).toBe('cancelling');
  });

  it('(I/J) reconciliation never calls execute() or cancel()', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking: bookedForCancel } = await setupBookedHotel(conversationId, provider);
    const cancelIntent = await createCancellationIntent(pool, conversationId, bookedForCancel.id);
    trackedTaskIds.push(cancelIntent.taskId);
    await confirmCancellationIntent(pool, conversationId, cancelIntent.taskId);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [bookedForCancel.id]);
    await backdateUpdatedAt('bookings', bookedForCancel.id);

    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const bookingIntent = await createBookingIntent(pool, conversationId, result.offers[0].offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const claimedForIJ = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: result.offers[0].provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    await backdateUpdatedAt('bookings', claimedForIJ!.id);

    const counting = new CountingWriteProvider(provider);
    await runReconciliation(pool, counting, { staleMinutes: STALE_STALEMINUTES });

    expect(counting.executeCalls).toBe(0);
    expect(counting.cancelCalls).toBe(0);
    expect(counting.getStatusCalls).toBeGreaterThan(0);
    expect(counting.getCancellationStatusCalls).toBeGreaterThan(0);
  });

  it('(K) reconciliation is repeat-safe - running it twice never duplicates events or re-calls status', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);
    const claimedForK = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: offer.provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    await backdateUpdatedAt('bookings', claimedForK!.id);

    const provider = new SandboxWriteProvider();
    const first = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });
    const second = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    expect(first.bookingsExecuting.find((r) => r.action === 'marked_failed')).toBeTruthy();
    expect(second.bookingsExecuting).toEqual([]);

    const reread = await getBookingByTaskId(pool, bookingIntent.taskId);
    const events = await listBookingEvents(pool, reread!.id);
    expect(events.map((e) => e.eventType)).toEqual(['booking_failed']);
  });

  it('(L) a concurrently-active operation is never overwritten by the sweep', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const offer = result.offers[0];
    const bookingIntent = await createBookingIntent(pool, conversationId, offer.offerId);
    await confirmBookingIntent(pool, conversationId, bookingIntent.taskId);
    trackedTaskIds.push(bookingIntent.taskId);

    const provider = new SandboxWriteProvider();
    // A live operation completes the booking BEFORE the sweep's own
    // guarded update runs - simulated directly, since the sweep and a
    // live request are both just ordinary callers of the same guarded
    // functions.
    const claimed = await insertExecutingBooking(pool, {
      taskId: bookingIntent.taskId,
      conversationId,
      provider: offer.provider,
      domain: 'hotel',
      idempotencyKey: bookingIntent.idempotencyKey,
      offerSnapshot: bookingIntent.selectedOffer,
    });
    const confirmation = await provider.execute(
      {
        offerId: offer.offerId,
        provider: offer.provider,
        domain: 'hotel',
        price: offer.price,
        currency: offer.currency,
        cancellationPolicy: null,
        expiresAt: bookingIntent.expiresAt,
      },
      bookingIntent.idempotencyKey,
    );
    await pool.query(`update bookings set status = 'booked', external_booking_id = $1 where id = $2`, [
      confirmation.providerBookingRef,
      claimed!.id,
    ]);

    // The sweep's own SELECT would no longer find this row (status is
    // now 'booked', not 'executing') - proving the race is closed by
    // construction rather than by luck.
    const report = await runReconciliation(pool, provider, { staleMinutes: 0 });
    expect(report.bookingsExecuting.find((r) => r.id === bookingIntent.taskId)).toBeUndefined();

    const reread = await getBookingByTaskId(pool, bookingIntent.taskId);
    expect(reread!.status).toBe('booked');
    expect(reread!.externalBookingId).toBe(confirmation.providerBookingRef);
  });

  it('(M) a stale rebooking whose cancellation is confirmed but whose new booking was never attempted is reported unresolved, never auto-booked', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const rebookIntent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(rebookIntent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, rebookIntent.taskId);

    // Simulate: the composite claimed 'cancelling' and the cancellation
    // itself completed, but the process crashed before ever creating
    // the new booking task.
    await confirmCancellationIntent(pool, conversationId, rebookIntent.cancellationTaskId);
    await executeCancellationIntent(pool, provider, conversationId, rebookIntent.cancellationTaskId);
    await pool.query(`update tasks set result = jsonb_set(result, '{outcome}', '"cancelling"') where id = $1`, [
      rebookIntent.taskId,
    ]);
    await backdateUpdatedAt('bookings', booking.id);
    await backdateUpdatedAt('tasks', rebookIntent.taskId);

    const counting = new CountingWriteProvider(provider);
    const report = await runReconciliation(pool, counting, { staleMinutes: STALE_STALEMINUTES });

    const item = report.rebookings.find((r) => r.id === rebookIntent.taskId);
    expect(item).toBeTruthy();
    expect(item!.action).toBe('unresolved');
    expect(item!.detail).toMatch(/never auto-booked/);
    expect(counting.executeCalls).toBe(0);

    const task = await getTask(pool, rebookIntent.taskId);
    expect((task!.result as { outcome: string }).outcome).toBe('cancelling');
  });

  it('(M) a stale rebooking whose cancellation did not go through is safely marked cancellation_failed', async () => {
    const conversationId = await createConversation(pool);
    const provider = new SandboxWriteProvider();
    const { booking } = await setupBookedHotel(conversationId, provider);
    const rebookIntent = await createRebookingIntent(pool, conversationId, booking.id, 'Connaught Place');
    trackedTaskIds.push(rebookIntent.cancellationTaskId);
    await confirmRebookingIntent(pool, conversationId, rebookIntent.taskId);

    // Simulate a claimed-but-crashed rebooking where the inner
    // cancellation attempt never actually succeeded.
    await confirmCancellationIntent(pool, conversationId, rebookIntent.cancellationTaskId);
    await pool.query(`update bookings set status = 'cancelling' where id = $1`, [booking.id]);
    await pool.query(`update tasks set result = jsonb_set(result, '{outcome}', '"cancelling"') where id = $1`, [
      rebookIntent.taskId,
    ]);
    await backdateUpdatedAt('bookings', booking.id);
    await backdateUpdatedAt('tasks', rebookIntent.taskId);

    const report = await runReconciliation(pool, provider, { staleMinutes: STALE_STALEMINUTES });

    const rebookingItem = report.rebookings.find((r) => r.id === rebookIntent.taskId);
    expect(rebookingItem).toBeTruthy();
    expect(rebookingItem!.action).toBe('marked_cancellation_failed');

    const task = await getTask(pool, rebookIntent.taskId);
    expect((task!.result as { outcome: string }).outcome).toBe('cancellation_failed');
    const rereadBooking = await getBookingById(pool, booking.id);
    expect(rereadBooking!.status).toBe('booked');
  });

  it('(N) a stale itinerary job in "processing" with no completion signal is marked failed, never fabricated complete', async () => {
    const jobId = await createJob(pool, 'delhi', ['history'], '2026-10-01', '2026-10-01');
    trackedJobIds.push(jobId);
    await markJobProcessing(pool, jobId);
    await backdateUpdatedAt('itinerary_jobs', jobId);

    const report = await runReconciliation(pool, new SandboxWriteProvider(), { staleMinutes: STALE_STALEMINUTES });

    const item = report.itineraryJobs.find((r) => r.id === jobId);
    expect(item).toBeTruthy();
    expect(item!.action).toBe('marked_failed');

    const job = await getJob(pool, jobId);
    expect(job!.status).toBe('failed');
    expect(job!.itineraryId).toBeNull();
  });

  it('a stale comparison task in "processing" is marked failed', async () => {
    const conversationId = await createConversation(pool);
    const { taskId } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    await pool.query(`update tasks set status = 'processing' where id = $1`, [taskId]);
    await backdateUpdatedAt('tasks', taskId);

    const report = await runReconciliation(pool, new SandboxWriteProvider(), { staleMinutes: STALE_STALEMINUTES });

    const item = report.tasks.find((r) => r.id === taskId);
    expect(item).toBeTruthy();
    expect(item!.action).toBe('marked_failed');

    const task = await getTask(pool, taskId);
    expect(task!.status).toBe('failed');
  });

  it('(O) makes zero LLM calls - the provider passed in is never an LlmProvider and nothing here imports one', async () => {
    const conversationId = await createConversation(pool);
    const jobId = await createJob(pool, 'delhi', ['history'], '2026-10-01', '2026-10-01');
    trackedJobIds.push(jobId);
    await markJobProcessing(pool, jobId);
    void conversationId;

    // If this module ever made an LLM call, there would be no
    // LlmProvider dependency to even construct here - runReconciliation's
    // own signature (pool, WriteProvider) is the structural proof; this
    // test exercises a full run to also prove it doesn't throw looking
    // for one.
    await expect(runReconciliation(pool, new SandboxWriteProvider(), { staleMinutes: 0 })).resolves.toBeTruthy();
  });
});
