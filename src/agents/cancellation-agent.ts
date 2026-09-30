import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { WriteProvider } from '../providers/write-provider';
import { createTask, completeTask, getTask } from '../tasks/tasks';
import {
  getBookingById,
  claimBookingForCancellation,
  markBookingCancelled,
  revertBookingToBooked,
  insertBookingEvent,
  type BookingRow,
} from '../booking/bookings';
import {
  getCancellationPolicyForBooking,
  calculateCancellationConsequences,
  type BookingCancellationPolicy,
  type CancellationConsequences,
} from '../booking/cancellation-consequences';

const CANCELLATION_INTENT_TTL_MS = 15 * 60 * 1000;

export type CancellationStatus = 'awaiting_confirmation' | 'confirmed';

export interface CancellationTaskResult {
  cancellationStatus: CancellationStatus;
  idempotencyKey: string;
  bookingId: string;
  provider: string;
  externalBookingId: string | null;
  policy: BookingCancellationPolicy;
  consequences: CancellationConsequences;
  expiresAt: string;
}

export interface CancellationIntentResult extends CancellationTaskResult {
  taskId: string;
}

function isCancellationTaskResult(value: unknown): value is CancellationTaskResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CancellationTaskResult).cancellationStatus === 'string' &&
    typeof (value as CancellationTaskResult).idempotencyKey === 'string' &&
    typeof (value as CancellationTaskResult).bookingId === 'string'
  );
}

function sanitizedErrorMessage(err: unknown): string {
  // Same posture as booking-agent.ts's own helper: errors here only ever
  // come from SandboxWriteProvider's own thrown Error objects (never raw
  // provider payloads), narrowed to `.message` only so a future real
  // WriteProvider can't accidentally leak a credential/secret either
  // (CLAUDE.md §20/§21).
  return err instanceof Error ? err.message : 'Unknown provider error';
}

/**
 * The booking-identification + policy/consequence preparation step (V2
 * architecture Phase 8/§5/§6/§7): creates a cancellation *intent*, never
 * a cancellation. Reuses the generic `tasks` table (task_type =
 * 'cancellation', migrations/1700000011000_cancellation-support.js),
 * exactly mirroring Phase 6's createBookingIntent.
 *
 * The booking is identified ONLY by its own stable id - never by hotel
 * name, provider name, or any inference from free text. A bookingId
 * that doesn't exist, or belongs to another conversation, is a clear
 * error, never a guess (plan §5).
 */
export async function createCancellationIntent(
  pool: Pool,
  conversationId: string,
  bookingId: string,
): Promise<CancellationIntentResult> {
  const booking = await getBookingById(pool, bookingId);
  if (!booking || booking.conversationId !== conversationId) {
    throw new Error(`I can't find booking ${bookingId} in this conversation - check the booking id.`);
  }

  if (booking.status === 'cancelled') {
    throw new Error('This booking is already cancelled.');
  }
  if (booking.status !== 'booked') {
    throw new Error(`This booking is not in a cancellable state (currently: ${booking.status}).`);
  }

  const policy = await getCancellationPolicyForBooking(pool, booking);
  const consequences = calculateCancellationConsequences(policy, booking);

  const cancellationTaskResult: CancellationTaskResult = {
    cancellationStatus: 'awaiting_confirmation',
    idempotencyKey: randomUUID(),
    bookingId: booking.id,
    provider: booking.provider,
    externalBookingId: booking.externalBookingId,
    policy,
    consequences,
    expiresAt: new Date(Date.now() + CANCELLATION_INTENT_TTL_MS).toISOString(),
  };

  const taskId = await createTask(pool, conversationId, 'cancellation');
  await completeTask(pool, taskId, cancellationTaskResult);

  return { taskId, ...cancellationTaskResult };
}

/**
 * The confirmation boundary (V2 architecture Phase 8/§8, mirroring Phase
 * 6's confirmBookingIntent exactly): the ONLY way `cancellationStatus`
 * can ever move from 'awaiting_confirmation' to 'confirmed'. Never
 * inferred from "cancel it", "yes", "go ahead", or any other free text -
 * the caller must supply the EXACT taskId this function's counterpart
 * (createCancellationIntent) returned, scoped to the SAME conversation.
 */
export async function confirmCancellationIntent(
  pool: Pool,
  conversationId: string,
  taskId: string,
): Promise<CancellationIntentResult> {
  const task = await getTask(pool, taskId);
  if (
    !task ||
    task.taskType !== 'cancellation' ||
    task.conversationId !== conversationId ||
    task.status !== 'complete' ||
    !isCancellationTaskResult(task.result)
  ) {
    throw new Error('Unknown cancellation to confirm - try requesting a cancellation first.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This cancellation request has expired - please request cancellation again.');
  }

  if (task.result.cancellationStatus === 'confirmed') {
    return { taskId, ...task.result };
  }

  const updated = await pool.query(
    `update tasks set result = jsonb_set(result, '{cancellationStatus}', '"confirmed"'), updated_at = now()
     where id = $1 and result ->> 'cancellationStatus' = 'awaiting_confirmation'
     returning result`,
    [taskId],
  );

  if (updated.rows.length === 0) {
    const refreshed = await getTask(pool, taskId);
    return { taskId, ...(refreshed!.result as unknown as CancellationTaskResult) };
  }

  return { taskId, ...(updated.rows[0].result as CancellationTaskResult) };
}

async function finalizeCancellationViaStatusCheck(
  pool: Pool,
  provider: WriteProvider,
  booking: BookingRow,
  idempotencyKey: string,
  failureNote: string,
): Promise<BookingRow> {
  // Same rule as booking-agent.ts's finalizeViaStatusCheck (plan §I,
  // applied symmetrically to cancellation): never conclude "the
  // cancellation failed" without first asking the provider whether it
  // actually went through - covers both a genuinely ambiguous/timed-out
  // cancel() call and a second caller finding another attempt still
  // 'cancelling' (crash-recovery), with one code path for both.
  let statusCheck;
  try {
    statusCheck = await provider.getCancellationStatus(idempotencyKey);
  } catch {
    statusCheck = null;
  }

  if (statusCheck?.executionState === 'confirmed' && statusCheck.cancellationRef) {
    const cancelled = await markBookingCancelled(pool, booking.id);
    if (cancelled) {
      await insertBookingEvent(pool, booking.id, 'cancellation_succeeded', {
        status: 'cancelled',
        externalReference: statusCheck.cancellationRef,
        payload: { recoveredViaStatusCheck: true },
      });
      return cancelled;
    }
  } else {
    // Never mark 'cancelled' on failure/ambiguity that resolves to "not
    // confirmed" - revert to 'booked', the externally accurate state.
    const reverted = await revertBookingToBooked(pool, booking.id);
    if (reverted) {
      await insertBookingEvent(pool, booking.id, 'cancellation_failed', {
        status: 'booked',
        payload: { message: failureNote },
      });
      return reverted;
    }
  }

  const reread = await getBookingById(pool, booking.id);
  return reread ?? booking;
}

/**
 * The Cancellation Agent's execution step (V2 architecture Phase 8/§3/
 * §9): executes an already-CONFIRMED cancellation intent through the
 * WriteProvider. Consumes the persisted booking/idempotency key -
 * never a fresh lookup, never LLM-decided.
 *
 * Idempotency mirrors Phase 7 exactly, adapted to an UPDATE-based claim
 * since the target `bookings` row already exists:
 * 1. Our side: `claimBookingForCancellation`'s guarded
 *    `UPDATE ... WHERE status = 'booked'` means at most one caller ever
 *    proceeds to call the provider for a given booking's cancellation.
 * 2. Provider side: the cancellation intent's own idempotency key
 *    (generated once, in createCancellationIntent - distinct from the
 *    original booking's key) is reused verbatim on every
 *    `cancel()`/`getCancellationStatus()` call.
 */
export async function executeCancellationIntent(
  pool: Pool,
  writeProvider: WriteProvider,
  conversationId: string,
  taskId: string,
): Promise<BookingRow> {
  const task = await getTask(pool, taskId);
  if (
    !task ||
    task.taskType !== 'cancellation' ||
    task.conversationId !== conversationId ||
    task.status !== 'complete' ||
    !isCancellationTaskResult(task.result)
  ) {
    throw new Error('Unknown cancellation to execute - try requesting and confirming a cancellation first.');
  }

  if (task.result.cancellationStatus !== 'confirmed') {
    throw new Error('This cancellation has not been confirmed yet - confirm it before executing.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This cancellation request has expired - please request cancellation again.');
  }

  const { bookingId, idempotencyKey } = task.result;
  const booking = await getBookingById(pool, bookingId);
  if (!booking || booking.conversationId !== conversationId) {
    throw new Error('Unknown booking to cancel - check the booking id.');
  }

  if (booking.status === 'cancelled') {
    // Idempotent - repeated cancellation after success returns the
    // existing cancelled state, never calling the provider again.
    await insertBookingEvent(pool, booking.id, 'cancellation_requested', { status: 'cancelled' });
    return booking;
  }

  if (booking.status === 'cancelling') {
    // Someone else's attempt is in flight, or a prior attempt was
    // interrupted between provider success and our own persistence -
    // resolve via status check, never call cancel() ourselves.
    await insertBookingEvent(pool, booking.id, 'cancellation_requested', { status: 'cancelling' });
    return finalizeCancellationViaStatusCheck(
      pool,
      writeProvider,
      booking,
      idempotencyKey,
      'Provider status check found no confirmed cancellation for this idempotency key.',
    );
  }

  if (booking.status !== 'booked') {
    // 'executing' or 'failed' - this booking was never actually
    // completed, so there is nothing to cancel.
    throw new Error(`This booking is not in a cancellable state (currently: ${booking.status}).`);
  }

  const claimed = await claimBookingForCancellation(pool, booking.id);
  if (!claimed) {
    // Lost a race between our own status check above and this claim
    // attempt - re-read and recurse into the same resolved-state logic
    // rather than duplicating it.
    const reread = await getBookingById(pool, booking.id);
    if (!reread) return booking;
    if (reread.status === 'cancelled') {
      await insertBookingEvent(pool, reread.id, 'cancellation_requested', { status: 'cancelled' });
      return reread;
    }
    await insertBookingEvent(pool, reread.id, 'cancellation_requested', { status: reread.status });
    return finalizeCancellationViaStatusCheck(pool, writeProvider, reread, idempotencyKey, 'Lost a concurrent cancellation claim.');
  }

  if (!claimed.externalBookingId) {
    // Should never happen for a 'booked' row (execution always sets
    // this before marking 'booked'), but never call the provider with
    // a null reference - revert rather than guess.
    const reverted = await revertBookingToBooked(pool, claimed.id);
    await insertBookingEvent(pool, claimed.id, 'cancellation_failed', {
      status: 'booked',
      payload: { message: 'Booking has no external reference to cancel.' },
    });
    return reverted ?? claimed;
  }

  await insertBookingEvent(pool, claimed.id, 'cancellation_requested', { status: 'cancelling' });
  await insertBookingEvent(pool, claimed.id, 'cancellation_started', { status: 'cancelling' });

  try {
    const confirmation = await writeProvider.cancel(claimed.externalBookingId, idempotencyKey);
    if (confirmation.executionState === 'confirmed' && confirmation.cancellationRef) {
      const cancelled = await markBookingCancelled(pool, claimed.id);
      if (cancelled) {
        await insertBookingEvent(pool, claimed.id, 'cancellation_succeeded', {
          status: 'cancelled',
          externalReference: confirmation.cancellationRef,
        });
        return cancelled;
      }
      const reread = await getBookingById(pool, claimed.id);
      return reread ?? claimed;
    }
    return finalizeCancellationViaStatusCheck(pool, writeProvider, claimed, idempotencyKey, 'Provider returned an ambiguous cancellation confirmation.');
  } catch (err) {
    return finalizeCancellationViaStatusCheck(pool, writeProvider, claimed, idempotencyKey, sanitizedErrorMessage(err));
  }
}
