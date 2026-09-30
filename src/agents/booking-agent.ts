import type { Pool } from 'pg';
import type { PreparedBooking, WriteProvider } from '../providers/write-provider';
import { getTask } from '../tasks/tasks';
import type { BookingTaskResult } from '../booking/booking-intent';
import {
  getBookingByTaskId,
  insertExecutingBooking,
  insertBookingEvent,
  markBookingBooked,
  markBookingFailed,
  type BookingRow,
} from '../booking/bookings';

function isBookingTaskResult(value: unknown): value is BookingTaskResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BookingTaskResult).bookingStatus === 'string' &&
    typeof (value as BookingTaskResult).idempotencyKey === 'string'
  );
}

function sanitizedErrorMessage(err: unknown): string {
  // Errors here only ever come from SandboxWriteProvider's own thrown
  // Error objects (never raw provider request/response payloads), so
  // this can never contain a credential/API key (CLAUDE.md §20/§21) -
  // still narrowed to `.message` only, never the full error/stack, so a
  // future real WriteProvider can't accidentally leak one either.
  return err instanceof Error ? err.message : 'Unknown provider error';
}

async function finalizeViaStatusCheck(
  pool: Pool,
  provider: WriteProvider,
  booking: BookingRow,
  idempotencyKey: string,
  failureNote: string,
): Promise<BookingRow> {
  // Plan §I: never blindly retry, and never conclude "failed" without
  // first asking the provider whether the write actually went through -
  // the write call's own outcome may be genuinely ambiguous (timeout) or
  // this may be a second caller finding another attempt still
  // 'executing' (recovering from a crash between provider success and
  // our own persistence). Same rule, one code path, no separate
  // "timeout" state machine.
  let statusCheck;
  try {
    statusCheck = await provider.getStatus(idempotencyKey);
  } catch {
    statusCheck = null;
  }

  if (statusCheck?.executionState === 'confirmed' && statusCheck.providerBookingRef) {
    const booked = await markBookingBooked(pool, booking.id, statusCheck.providerBookingRef);
    if (booked) {
      await insertBookingEvent(pool, booking.id, 'booking_succeeded', {
        status: 'booked',
        externalReference: statusCheck.providerBookingRef,
        payload: { recoveredViaStatusCheck: true },
      });
      return booked;
    }
    // Lost a race to another finalizer - re-read below.
  } else {
    const failed = await markBookingFailed(pool, booking.id);
    if (failed) {
      await insertBookingEvent(pool, booking.id, 'booking_failed', {
        status: 'failed',
        payload: { message: failureNote },
      });
      return failed;
    }
    // Lost a race - re-read below.
  }

  const reread = await getBookingByTaskId(pool, booking.taskId);
  return reread ?? booking;
}

/**
 * The Booking Agent (V2 architecture Phase 7/§C/§D, the document's own
 * Phase 8): executes an already-CONFIRMED booking intent through a
 * WriteProvider. This is the boundary Phase 6 deliberately stopped
 * before - it consumes the persisted `PreparedBooking`/idempotency key
 * from the confirmed intent, never reconstructs one from free text,
 * never performs a fresh comparison/search, never asks the LLM which
 * offer to book (this module makes no LLM call at all).
 *
 * Idempotency (plan §I, two distinct guards):
 * 1. Our side: `insertExecutingBooking`'s `bookings.task_id` UNIQUE
 *    constraint means at most one caller ever proceeds to call the
 *    provider for a given booking intent - a concurrent/retried caller
 *    that loses the insert never calls `execute()` itself.
 * 2. Provider side: the persisted `idempotencyKey` (generated once, in
 *    Phase 6's createBookingIntent) is reused verbatim on every
 *    `execute()`/`getStatus()` call - never regenerated - so a retry
 *    that reaches the provider again can only ever recover the same
 *    external booking, never create a second one.
 */
export async function executeBookingIntent(
  pool: Pool,
  writeProvider: WriteProvider,
  conversationId: string,
  taskId: string,
): Promise<BookingRow> {
  const task = await getTask(pool, taskId);
  if (
    !task ||
    task.taskType !== 'booking' ||
    task.conversationId !== conversationId ||
    task.status !== 'complete' ||
    !isBookingTaskResult(task.result)
  ) {
    throw new Error('Unknown booking to execute - try creating and confirming a booking intent first.');
  }

  if (task.result.bookingStatus !== 'confirmed') {
    throw new Error('This booking has not been confirmed yet - confirm it before executing.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This booking offer has expired - please compare again to get a fresh price.');
  }

  const { selectedOffer, idempotencyKey } = task.result;

  const claimed = await insertExecutingBooking(pool, {
    taskId,
    conversationId,
    provider: selectedOffer.provider,
    domain: selectedOffer.domain,
    idempotencyKey,
    offerSnapshot: selectedOffer,
  });

  if (!claimed) {
    // Someone else already claimed this booking intent (a prior call, or
    // a concurrent one) - never call the provider ourselves.
    const existing = await getBookingByTaskId(pool, taskId);
    if (!existing) {
      throw new Error('Unknown booking to execute - try creating and confirming a booking intent first.');
    }

    await insertBookingEvent(pool, existing.id, 'execution_requested', { status: existing.status });

    if (existing.status !== 'executing') {
      // Already resolved (booked or failed) - idempotent no-op, never
      // call the provider again.
      return existing;
    }

    return finalizeViaStatusCheck(
      pool,
      writeProvider,
      existing,
      idempotencyKey,
      'Provider status check found no confirmed booking for this idempotency key.',
    );
  }

  await insertBookingEvent(pool, claimed.id, 'execution_requested', { status: 'executing' });
  await insertBookingEvent(pool, claimed.id, 'execution_started', { status: 'executing' });

  const prepared: PreparedBooking = {
    offerId: selectedOffer.offerId,
    provider: selectedOffer.provider,
    domain: selectedOffer.domain,
    price: selectedOffer.price,
    currency: selectedOffer.currency,
    cancellationPolicy: selectedOffer.cancellationPolicy,
    expiresAt: task.result.expiresAt,
  };

  try {
    const confirmation = await writeProvider.execute(prepared, idempotencyKey);
    if (confirmation.executionState === 'confirmed' && confirmation.providerBookingRef) {
      const booked = await markBookingBooked(pool, claimed.id, confirmation.providerBookingRef);
      if (booked) {
        await insertBookingEvent(pool, claimed.id, 'booking_succeeded', {
          status: 'booked',
          externalReference: confirmation.providerBookingRef,
        });
        return booked;
      }
      const reread = await getBookingByTaskId(pool, taskId);
      return reread ?? claimed;
    }
    // Ambiguous confirmation (no error thrown, but not a clean
    // 'confirmed' + ref either) - resolve via status check, never
    // fabricate success.
    return finalizeViaStatusCheck(pool, writeProvider, claimed, idempotencyKey, 'Provider returned an ambiguous confirmation.');
  } catch (err) {
    return finalizeViaStatusCheck(pool, writeProvider, claimed, idempotencyKey, sanitizedErrorMessage(err));
  }
}
