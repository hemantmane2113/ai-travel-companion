import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { HotelProvider } from '../providers/hotel-provider';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';
import type { WriteProvider } from '../providers/write-provider';
import { createTask, completeTask, getTask } from '../tasks/tasks';
import { getBookingById, getBookingByTaskId, type BookingRow } from '../booking/bookings';
import type { BookingTaskResult, SelectedOfferSnapshot } from '../booking/booking-intent';
import {
  getCancellationPolicyForBooking,
  calculateCancellationConsequences,
  type BookingCancellationPolicy,
  type CancellationConsequences,
} from '../booking/cancellation-consequences';
import { createCancellationIntent, confirmCancellationIntent, executeCancellationIntent } from './cancellation-agent';
import { executeBookingIntent } from './booking-agent';
import { searchHotelOffersOnly } from './comparison-agent';

const REBOOKING_INTENT_TTL_MS = 15 * 60 * 1000;
const NEW_BOOKING_TTL_MS = 15 * 60 * 1000;

export type RebookingStatus = 'awaiting_confirmation' | 'confirmed';

/**
 * `'cancelling'` is both a terminal-looking observable value AND the
 * atomic claim state (see executeRebookingIntent) - only 'pending' and
 * 'cancellation_failed' are ever claimable, so a caller that observes
 * 'cancelling' knows a claim is (or very recently was) in flight and
 * never proceeds itself; this is the DB-level "our-side" idempotency
 * guard for the composite as a whole, the same discipline Phase 7/8
 * established, applied one level up.
 */
export type RebookingOutcome =
  | 'pending'
  | 'cancelling'
  | 'cancellation_failed'
  | 'new_booking_failed_after_cancellation'
  | 'completed';

export interface RebookingTaskResult {
  rebookingStatus: RebookingStatus;
  outcome: RebookingOutcome;
  originalBookingId: string;
  cancellationTaskId: string;
  cancellationPolicy: BookingCancellationPolicy;
  cancellationConsequences: CancellationConsequences;
  newOffer: SelectedOfferSnapshot;
  newBookingTaskId: string | null;
  expiresAt: string;
}

export interface RebookingIntentResult extends RebookingTaskResult {
  taskId: string;
}

export interface RebookingExecutionResult {
  taskId: string;
  outcome: RebookingOutcome;
  originalBooking: BookingRow;
  newBooking: BookingRow | null;
  message: string;
}

function isRebookingTaskResult(value: unknown): value is RebookingTaskResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RebookingTaskResult).rebookingStatus === 'string' &&
    typeof (value as RebookingTaskResult).originalBookingId === 'string' &&
    typeof (value as RebookingTaskResult).cancellationTaskId === 'string'
  );
}

/**
 * The hotel cancel-and-rebook intent (V2 architecture Phase 9/§I, the
 * document's own Phase 9 "modify composite workflow" - hotel-only, per
 * approved scope). Identifies the exact booking by its own id (never by
 * hotel/provider name), requires it to be an existing, currently-'booked'
 * HOTEL booking, and eagerly:
 * - creates a Phase 8 cancellation intent for it (reusing
 *   createCancellationIntent unchanged - its own policy/consequence
 *   calculation is reused verbatim, never duplicated),
 * - fetches a fresh, deterministic, LLM-free quote for `location` via
 *   the Comparison Agent's search-only capability (searchHotelOffersOnly),
 *   selecting the cheapest available offer.
 *
 * Never fabricates a fee/refund/net cost - `cancellationConsequences`
 * is Phase 8's own unmodified, honestly-`unavailable` calculation. The
 * new offer's real provider-quoted price is included as-is.
 */
export async function createRebookingIntent(
  pool: Pool,
  conversationId: string,
  bookingId: string,
  location: string,
  hotelProviders?: HotelProvider[],
  rateLimiter?: ProviderRateLimiter,
): Promise<RebookingIntentResult> {
  const booking = await getBookingById(pool, bookingId);
  if (!booking || booking.conversationId !== conversationId) {
    throw new Error(`I can't find booking ${bookingId} in this conversation - check the booking id.`);
  }
  if (booking.domain !== 'hotel') {
    throw new Error('Rebooking is only supported for hotel bookings right now.');
  }

  // Reuses Phase 8's own validation (booked-only, already-cancelled,
  // etc.) and its own policy/consequence calculation - never duplicated.
  const cancellationIntent = await createCancellationIntent(pool, conversationId, bookingId);

  const searchResult = await searchHotelOffersOnly({ location }, hotelProviders, rateLimiter);
  if (searchResult.offers.length === 0 || !searchResult.cheapestOfferId) {
    throw new Error(`I couldn't find any hotel offers for "${location}" to rebook into.`);
  }
  const cheapest = searchResult.offers.find((o) => o.offerId === searchResult.cheapestOfferId)!;

  const newOffer: SelectedOfferSnapshot = {
    offerId: cheapest.offerId,
    provider: cheapest.provider,
    domain: 'hotel',
    price: cheapest.price,
    currency: cheapest.currency,
    cancellationPolicy: cheapest.cancellationPolicy ?? null,
  };

  const rebookingTaskResult: RebookingTaskResult = {
    rebookingStatus: 'awaiting_confirmation',
    outcome: 'pending',
    originalBookingId: bookingId,
    cancellationTaskId: cancellationIntent.taskId,
    cancellationPolicy: cancellationIntent.policy,
    cancellationConsequences: cancellationIntent.consequences,
    newOffer,
    newBookingTaskId: null,
    expiresAt: new Date(Date.now() + REBOOKING_INTENT_TTL_MS).toISOString(),
  };

  const taskId = await createTask(pool, conversationId, 'rebooking');
  await completeTask(pool, taskId, rebookingTaskResult);

  return { taskId, ...rebookingTaskResult };
}

/**
 * The confirmation boundary (mirrors confirmBookingIntent/
 * confirmCancellationIntent exactly): the ONLY way `rebookingStatus` can
 * move to 'confirmed'. This single confirmation covers BOTH the
 * cancellation and the new booking - the architecture explicitly
 * prohibits "two independent confirmations for one user-requested
 * modification."
 */
export async function confirmRebookingIntent(
  pool: Pool,
  conversationId: string,
  taskId: string,
): Promise<RebookingIntentResult> {
  const task = await getTask(pool, taskId);
  if (
    !task ||
    task.taskType !== 'rebooking' ||
    task.conversationId !== conversationId ||
    task.status !== 'complete' ||
    !isRebookingTaskResult(task.result)
  ) {
    throw new Error('Unknown rebooking to confirm - try requesting a rebooking first.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This rebooking request has expired - please request rebooking again.');
  }

  if (task.result.rebookingStatus === 'confirmed') {
    return { taskId, ...task.result };
  }

  const updated = await pool.query(
    `update tasks set result = jsonb_set(result, '{rebookingStatus}', '"confirmed"'), updated_at = now()
     where id = $1 and result ->> 'rebookingStatus' = 'awaiting_confirmation'
     returning result`,
    [taskId],
  );

  if (updated.rows.length === 0) {
    const refreshed = await getTask(pool, taskId);
    return { taskId, ...(refreshed!.result as unknown as RebookingTaskResult) };
  }

  return { taskId, ...(updated.rows[0].result as RebookingTaskResult) };
}

async function setRebookingOutcome(pool: Pool, taskId: string, outcome: RebookingOutcome): Promise<void> {
  await pool.query(`update tasks set result = jsonb_set(result, '{outcome}', $1), updated_at = now() where id = $2`, [
    JSON.stringify(outcome),
    taskId,
  ]);
}

async function buildTerminalResult(pool: Pool, taskId: string, result: RebookingTaskResult): Promise<RebookingExecutionResult> {
  const originalBooking = await getBookingById(pool, result.originalBookingId);
  const newBooking = result.newBookingTaskId ? await getBookingByTaskId(pool, result.newBookingTaskId) : null;
  const message =
    result.outcome === 'completed'
      ? `Your ${originalBooking!.provider} booking has been cancelled, and your new booking with ${newBooking!.provider} is confirmed (reference ${newBooking!.externalBookingId}).`
      : `Your original booking was cancelled, but the new booking could not be completed. You currently have no active booking for this - please compare and book again.`;
  return { taskId, outcome: result.outcome, originalBooking: originalBooking!, newBooking, message };
}

/**
 * Executes an already-confirmed rebooking intent (V2 architecture Phase
 * 9/§I): cancellation first, and ONLY on the provider actually
 * confirming the cancellation does it proceed to the new booking -
 * never the reverse, never both unconditionally. Delegates entirely to
 * Phase 8's confirmCancellationIntent/executeCancellationIntent and
 * Phase 7's executeBookingIntent, unmodified - this function adds no
 * new provider-facing idempotency mechanism of its own, only the outer
 * claim below (a genuine concurrency-safety requirement discovered
 * during implementation: without it, two concurrent calls could each
 * pass a same-looking check and both create a separate real booking).
 *
 * The claim is a guarded conditional UPDATE keyed on the rebooking
 * task's own `outcome` field ('pending'/'cancellation_failed' ->
 * 'cancelling', only once) - the exact same DB-level idempotency
 * discipline Phase 7 (INSERT-based) and Phase 8 (UPDATE-based) already
 * established, applied one level up at the orchestration layer. A
 * caller that loses the claim never calls either inner function itself.
 */
export async function executeRebookingIntent(
  pool: Pool,
  writeProvider: WriteProvider,
  conversationId: string,
  taskId: string,
): Promise<RebookingExecutionResult> {
  const task = await getTask(pool, taskId);
  if (
    !task ||
    task.taskType !== 'rebooking' ||
    task.conversationId !== conversationId ||
    task.status !== 'complete' ||
    !isRebookingTaskResult(task.result)
  ) {
    throw new Error('Unknown rebooking to execute - try requesting and confirming a rebooking first.');
  }

  if (task.result.rebookingStatus !== 'confirmed') {
    throw new Error('This rebooking has not been confirmed yet - confirm it before executing.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This rebooking request has expired - please request rebooking again.');
  }

  if (task.result.outcome === 'completed' || task.result.outcome === 'new_booking_failed_after_cancellation') {
    return buildTerminalResult(pool, taskId, task.result);
  }

  const claim = await pool.query(
    `update tasks set result = jsonb_set(result, '{outcome}', '"cancelling"'), updated_at = now()
     where id = $1 and result ->> 'outcome' in ('pending', 'cancellation_failed')
     returning result`,
    [taskId],
  );

  if (claim.rows.length === 0) {
    const refreshed = await getTask(pool, taskId);
    const result = refreshed!.result as unknown as RebookingTaskResult;
    if (result.outcome === 'completed' || result.outcome === 'new_booking_failed_after_cancellation') {
      return buildTerminalResult(pool, taskId, result);
    }
    const originalBooking = await getBookingById(pool, result.originalBookingId);
    return {
      taskId,
      outcome: 'cancelling',
      originalBooking: originalBooking!,
      newBooking: null,
      message: 'Your rebooking request is already being processed.',
    };
  }

  const { cancellationTaskId, newOffer } = task.result;

  await confirmCancellationIntent(pool, conversationId, cancellationTaskId);
  const cancelledBooking = await executeCancellationIntent(pool, writeProvider, conversationId, cancellationTaskId);

  if (cancelledBooking.status !== 'cancelled') {
    await setRebookingOutcome(pool, taskId, 'cancellation_failed');
    return {
      taskId,
      outcome: 'cancellation_failed',
      originalBooking: cancelledBooking,
      newBooking: null,
      message: `I wasn't able to cancel your ${cancelledBooking.provider} booking, so no rebooking was attempted - your original booking remains active.`,
    };
  }

  // Cancellation succeeded - the outer confirmation already covers this
  // half too (plan §I: never two independent confirmations for one
  // user-requested modification), so the new booking's own task is
  // constructed already 'confirmed', not 'awaiting_confirmation'.
  const newBookingTaskResult: BookingTaskResult = {
    bookingStatus: 'confirmed',
    idempotencyKey: randomUUID(),
    executionState: 'not_executed',
    selectedOffer: newOffer,
    expiresAt: new Date(Date.now() + NEW_BOOKING_TTL_MS).toISOString(),
  };
  const newBookingTaskId = await createTask(pool, conversationId, 'booking');
  await completeTask(pool, newBookingTaskId, newBookingTaskResult);
  await pool.query(
    `update tasks set result = jsonb_set(result, '{newBookingTaskId}', to_jsonb($1::text)), updated_at = now() where id = $2`,
    [newBookingTaskId, taskId],
  );

  const newBooking = await executeBookingIntent(pool, writeProvider, conversationId, newBookingTaskId);

  if (newBooking.status === 'booked') {
    await setRebookingOutcome(pool, taskId, 'completed');
    return {
      taskId,
      outcome: 'completed',
      originalBooking: cancelledBooking,
      newBooking,
      message: `Your ${cancelledBooking.provider} booking has been cancelled, and your new booking with ${newBooking.provider} is confirmed (reference ${newBooking.externalBookingId}).`,
    };
  }

  await setRebookingOutcome(pool, taskId, 'new_booking_failed_after_cancellation');
  return {
    taskId,
    outcome: 'new_booking_failed_after_cancellation',
    originalBooking: cancelledBooking,
    newBooking,
    message: `Your original booking was cancelled, but I wasn't able to complete the new booking with ${newBooking.provider}. You currently have no active booking for this - please compare and book again.`,
  };
}
