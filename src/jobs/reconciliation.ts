import type { Pool } from 'pg';
import type { WriteProvider } from '../providers/write-provider';
import { getBookingById, markBookingBooked, markBookingFailed, markBookingCancelled, revertBookingToBooked, insertBookingEvent } from '../booking/bookings';

/**
 * V2 architecture Phase 10 (docs/architecture-v2-agent-companion.md §L:
 * "this reconciliation sweep (finding tasks stuck in `processing`)
 * doesn't exist even for today's `itinerary_jobs` - a real existing gap
 * to fix as part of generalizing the pattern"). A manual CLI script
 * (src/jobs/reconciliation-cli.ts), not a scheduler/worker/HTTP endpoint
 * - matches this repository's existing maintenance-operation convention
 * (seed:warnings/seed:knowledge/ingest:places are all manual CLI
 * commands, never a background daemon).
 *
 * Deterministic infrastructure: zero LLM calls, and never calls a
 * provider WRITE method (`execute`/`cancel`) - only the read-only
 * `getStatus`/`getCancellationStatus` methods Phases 7/8 already use for
 * exactly this kind of ambiguity resolution. A stuck record is only ever
 * moved to a state the provider (or, for itinerary jobs/comparison
 * tasks, the absence of any external write at all) actually supports -
 * never fabricated, and never "processing -> completed"/"executing ->
 * booked"/"cancelling -> cancelled" without that authoritative evidence.
 *
 * Every write here reuses an EXISTING guarded conditional UPDATE
 * (bookings.ts's markBookingBooked/markBookingFailed/markBookingCancelled/
 * revertBookingToBooked are already `WHERE status = '<expected>'`) or a
 * new one written the same way - never an in-memory boolean - so a
 * record a live request is genuinely still processing is never
 * clobbered: the guarded UPDATE simply affects zero rows, and that is
 * reported as 'unresolved' (lost the race to the active operation)
 * rather than treated as an error.
 */

const DEFAULT_STALE_MINUTES = 30;

export function resolveStaleMinutes(explicit?: number): number {
  if (typeof explicit === 'number' && explicit >= 0) return explicit;
  const raw = process.env.RECONCILIATION_STALE_MINUTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALE_MINUTES;
}

export type ReconciliationAction =
  | 'marked_failed'
  | 'marked_booked'
  | 'marked_cancelled'
  | 'reverted_to_booked'
  | 'marked_cancellation_failed'
  | 'unresolved';

export interface ReconciliationItemResult {
  kind: 'itinerary_job' | 'task' | 'booking_executing' | 'booking_cancelling' | 'rebooking';
  id: string;
  action: ReconciliationAction;
  detail?: string;
}

export interface ReconciliationReport {
  staleMinutes: number;
  itineraryJobs: ReconciliationItemResult[];
  tasks: ReconciliationItemResult[];
  bookingsExecuting: ReconciliationItemResult[];
  bookingsCancelling: ReconciliationItemResult[];
  rebookings: ReconciliationItemResult[];
}

/**
 * itinerary_jobs stuck in 'processing' (plan §L's own named gap). There
 * is no external provider write associated with itinerary generation -
 * it is a read/search + one LLM call + persistence, nothing to
 * "confirm" with anyone - so the only honest terminal state for a
 * genuinely stuck job is 'failed', never a fabricated 'complete'.
 * Guarded on `status = 'processing'` so a job a live process just
 * finished is never overwritten.
 */
async function reconcileItineraryJobs(pool: Pool, staleBefore: Date): Promise<ReconciliationItemResult[]> {
  const stale = await pool.query(`select id from itinerary_jobs where status = 'processing' and updated_at < $1`, [
    staleBefore,
  ]);

  const results: ReconciliationItemResult[] = [];
  for (const row of stale.rows) {
    const updated = await pool.query(
      `update itinerary_jobs set status = 'failed', error = $1, updated_at = now() where id = $2 and status = 'processing'`,
      ['Reconciliation: job was stuck in processing with no authoritative completion signal.', row.id],
    );
    results.push({
      kind: 'itinerary_job',
      id: row.id,
      action: updated.rowCount === 1 ? 'marked_failed' : 'unresolved',
      detail: updated.rowCount === 1 ? undefined : 'lost the race to an active operation',
    });
  }
  return results;
}

/**
 * Generic `tasks` rows stuck in 'processing'. Only `comparison` tasks
 * are ever actually left in this status by the current codebase -
 * `createBookingIntent`/`createCancellationIntent`/`createRebookingIntent`
 * all go straight from 'pending' to 'complete' and never set
 * 'processing' at all (verified by inspection, not assumed). A stuck
 * comparison task has no external write to reconcile against either
 * (search + narrate only), so 'failed' is safe and honest. Any OTHER
 * task_type found here (which the current code should never produce) is
 * deliberately left unresolved rather than assuming the same rule
 * applies - plan's own instruction not to invent a blanket
 * "processing -> failed" rule beyond what the existing semantics
 * actually justify.
 */
async function reconcileTasks(pool: Pool, staleBefore: Date): Promise<ReconciliationItemResult[]> {
  const stale = await pool.query(`select id, task_type from tasks where status = 'processing' and updated_at < $1`, [
    staleBefore,
  ]);

  const results: ReconciliationItemResult[] = [];
  for (const row of stale.rows) {
    if (row.task_type !== 'comparison') {
      results.push({
        kind: 'task',
        id: row.id,
        action: 'unresolved',
        detail: `no established reconciliation semantics for task_type '${row.task_type}' in 'processing'`,
      });
      continue;
    }
    const updated = await pool.query(
      `update tasks set status = 'failed', error = $1, updated_at = now() where id = $2 and status = 'processing'`,
      ['Reconciliation: comparison task was stuck in processing with no authoritative completion signal.', row.id],
    );
    results.push({
      kind: 'task',
      id: row.id,
      action: updated.rowCount === 1 ? 'marked_failed' : 'unresolved',
      detail: updated.rowCount === 1 ? undefined : 'lost the race to an active operation',
    });
  }
  return results;
}

/**
 * `bookings` stuck in 'executing' (Phase 7's own transient claim state).
 * Reuses the booking's own persisted `idempotency_key` directly - the
 * exact key `executeBookingIntent` already generated/used - and
 * `writeProvider.getStatus()` (read-only), never `execute()`. On a
 * confirmed success, reuses `markBookingBooked` unchanged (already
 * guarded `WHERE status = 'executing'`); on a confirmed non-execution,
 * reuses `markBookingFailed` unchanged (same guard). An ambiguous/
 * unavailable status, or a lost race, is reported unresolved - never a
 * fabricated transition either way.
 */
async function reconcileExecutingBookings(
  pool: Pool,
  writeProvider: WriteProvider,
  staleBefore: Date,
): Promise<ReconciliationItemResult[]> {
  const stale = await pool.query(`select id, idempotency_key from bookings where status = 'executing' and updated_at < $1`, [
    staleBefore,
  ]);

  const results: ReconciliationItemResult[] = [];
  for (const row of stale.rows) {
    let statusCheck;
    try {
      statusCheck = await writeProvider.getStatus(row.idempotency_key);
    } catch {
      statusCheck = null;
    }

    if (statusCheck?.executionState === 'confirmed' && statusCheck.providerBookingRef) {
      const booked = await markBookingBooked(pool, row.id, statusCheck.providerBookingRef);
      if (!booked) {
        results.push({ kind: 'booking_executing', id: row.id, action: 'unresolved', detail: 'lost the race to an active operation' });
        continue;
      }
      await insertBookingEvent(pool, row.id, 'booking_succeeded', {
        status: 'booked',
        externalReference: statusCheck.providerBookingRef,
        payload: { recoveredViaReconciliation: true },
      });
      results.push({ kind: 'booking_executing', id: row.id, action: 'marked_booked' });
    } else if (statusCheck?.executionState === 'not_executed') {
      const failed = await markBookingFailed(pool, row.id);
      if (!failed) {
        results.push({ kind: 'booking_executing', id: row.id, action: 'unresolved', detail: 'lost the race to an active operation' });
        continue;
      }
      await insertBookingEvent(pool, row.id, 'booking_failed', {
        status: 'failed',
        payload: {
          message: 'Reconciliation: provider confirmed nothing was executed for this idempotency key.',
          recoveredViaReconciliation: true,
        },
      });
      results.push({ kind: 'booking_executing', id: row.id, action: 'marked_failed' });
    } else {
      results.push({ kind: 'booking_executing', id: row.id, action: 'unresolved', detail: 'provider status is ambiguous or unavailable' });
    }
  }
  return results;
}

/**
 * `bookings` stuck in 'cancelling' (Phase 8's own transient claim
 * state). The CANCELLATION's own idempotency key lives on its own
 * `tasks` row (task_type='cancellation'), not on `bookings` itself
 * (Phase 8 deliberately never added a second idempotency-key column to
 * `bookings`) - so it is derived from persisted data: the most recent
 * CONFIRMED cancellation intent recorded against this booking (only a
 * confirmed intent's execution could ever have set 'cancelling' in the
 * first place). No confirmed intent found -> unresolved, never guessed.
 * Otherwise identical discipline to reconcileExecutingBookings, using
 * `getCancellationStatus()` (read-only, never `cancel()`) and reusing
 * `markBookingCancelled`/`revertBookingToBooked` unchanged.
 */
async function reconcileCancellingBookings(
  pool: Pool,
  writeProvider: WriteProvider,
  staleBefore: Date,
): Promise<ReconciliationItemResult[]> {
  const stale = await pool.query(`select id from bookings where status = 'cancelling' and updated_at < $1`, [staleBefore]);

  const results: ReconciliationItemResult[] = [];
  for (const row of stale.rows) {
    const keyResult = await pool.query(
      `select result ->> 'idempotencyKey' as idempotency_key
       from tasks
       where task_type = 'cancellation' and result ->> 'bookingId' = $1 and result ->> 'cancellationStatus' = 'confirmed'
       order by created_at desc limit 1`,
      [row.id],
    );
    if (keyResult.rows.length === 0) {
      results.push({ kind: 'booking_cancelling', id: row.id, action: 'unresolved', detail: 'no confirmed cancellation intent found for this booking' });
      continue;
    }
    const idempotencyKey: string = keyResult.rows[0].idempotency_key;

    let statusCheck;
    try {
      statusCheck = await writeProvider.getCancellationStatus(idempotencyKey);
    } catch {
      statusCheck = null;
    }

    if (statusCheck?.executionState === 'confirmed' && statusCheck.cancellationRef) {
      const cancelled = await markBookingCancelled(pool, row.id);
      if (!cancelled) {
        results.push({ kind: 'booking_cancelling', id: row.id, action: 'unresolved', detail: 'lost the race to an active operation' });
        continue;
      }
      await insertBookingEvent(pool, row.id, 'cancellation_succeeded', {
        status: 'cancelled',
        externalReference: statusCheck.cancellationRef,
        payload: { recoveredViaReconciliation: true },
      });
      results.push({ kind: 'booking_cancelling', id: row.id, action: 'marked_cancelled' });
    } else if (statusCheck?.executionState === 'not_executed') {
      const reverted = await revertBookingToBooked(pool, row.id);
      if (!reverted) {
        results.push({ kind: 'booking_cancelling', id: row.id, action: 'unresolved', detail: 'lost the race to an active operation' });
        continue;
      }
      await insertBookingEvent(pool, row.id, 'cancellation_failed', {
        status: 'booked',
        payload: {
          message: 'Reconciliation: provider confirmed no cancellation went through for this idempotency key.',
          recoveredViaReconciliation: true,
        },
      });
      results.push({ kind: 'booking_cancelling', id: row.id, action: 'reverted_to_booked' });
    } else {
      results.push({ kind: 'booking_cancelling', id: row.id, action: 'unresolved', detail: 'provider status is ambiguous or unavailable' });
    }
  }
  return results;
}

/**
 * `rebooking`-type tasks stuck at outcome='cancelling' (Phase 9's own
 * acknowledged, un-self-healing gap - see rebooking-agent.ts's module
 * doc comment). Deliberately does NOT re-implement any provider check
 * here: by the time this runs, `reconcileCancellingBookings` above has
 * already resolved the underlying booking (if it was reconcilable at
 * all), so this step only ever reads that ALREADY-established,
 * authoritative persisted state - it never talks to a provider itself.
 *
 * Per explicit instruction: reconciliation must NEVER perform a new
 * booking. If the underlying booking is confirmed 'cancelled' but no
 * new booking was ever attempted, this is reported as unresolved and
 * left exactly as-is - never silently completed, never a state the
 * Phase 9 state machine doesn't already define. The one write this
 * function DOES make - outcome 'cancelling' -> 'cancellation_failed' -
 * is safe because that is the EXACT terminal value `executeRebookingIntent`
 * itself would already set for this exact situation (the cancellation
 * did not go through) - not a new state, not an invented one.
 */
async function reconcileStuckRebookings(pool: Pool, staleBefore: Date): Promise<ReconciliationItemResult[]> {
  const stale = await pool.query(
    `select id, result from tasks where task_type = 'rebooking' and result ->> 'outcome' = 'cancelling' and updated_at < $1`,
    [staleBefore],
  );

  const results: ReconciliationItemResult[] = [];
  for (const row of stale.rows) {
    const originalBookingId: string = row.result.originalBookingId;
    const newBookingTaskId: string | null = row.result.newBookingTaskId ?? null;
    const booking = await getBookingById(pool, originalBookingId);

    if (!booking) {
      results.push({ kind: 'rebooking', id: row.id, action: 'unresolved', detail: 'original booking not found' });
      continue;
    }

    if (booking.status === 'cancelled') {
      results.push({
        kind: 'rebooking',
        id: row.id,
        action: 'unresolved',
        detail: newBookingTaskId
          ? 'cancellation confirmed; the new booking already exists and is reconciled separately'
          : 'cancellation confirmed but no new booking was ever attempted - never auto-booked by reconciliation; requires a fresh rebooking request',
      });
      continue;
    }

    if (booking.status === 'booked') {
      const updated = await pool.query(
        `update tasks set result = jsonb_set(result, '{outcome}', '"cancellation_failed"'), updated_at = now()
         where id = $1 and result ->> 'outcome' = 'cancelling'`,
        [row.id],
      );
      results.push({
        kind: 'rebooking',
        id: row.id,
        action: updated.rowCount === 1 ? 'marked_cancellation_failed' : 'unresolved',
        detail: updated.rowCount === 1 ? undefined : 'lost the race to an active operation',
      });
      continue;
    }

    results.push({
      kind: 'rebooking',
      id: row.id,
      action: 'unresolved',
      detail: `underlying booking is in an unresolved state (${booking.status})`,
    });
  }
  return results;
}

export async function runReconciliation(
  pool: Pool,
  writeProvider: WriteProvider,
  options: { staleMinutes?: number } = {},
): Promise<ReconciliationReport> {
  const staleMinutes = resolveStaleMinutes(options.staleMinutes);
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000);

  const itineraryJobs = await reconcileItineraryJobs(pool, staleBefore);
  const tasks = await reconcileTasks(pool, staleBefore);
  const bookingsExecuting = await reconcileExecutingBookings(pool, writeProvider, staleBefore);
  const bookingsCancelling = await reconcileCancellingBookings(pool, writeProvider, staleBefore);
  // Runs last - reads the (possibly just-updated) booking state above.
  const rebookings = await reconcileStuckRebookings(pool, staleBefore);

  return { staleMinutes, itineraryJobs, tasks, bookingsExecuting, bookingsCancelling, rebookings };
}
