import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { Domain } from '../providers/hotel-provider';
import type { BookingExecutionState } from '../providers/write-provider';
import type { ComparisonTaskResult } from '../agents/comparison-agent';
import { createTask, completeTask, getTask, getLatestTaskForConversation } from '../tasks/tasks';

const BOOKING_INTENT_TTL_MS = 15 * 60 * 1000;

export type BookingStatus = 'awaiting_confirmation' | 'confirmed';

/** A fingerprint of the exact offer (plan §I: "provider + offer id + price + cancellation policy + expiry"). */
export interface SelectedOfferSnapshot {
  offerId: string;
  provider: string;
  domain: Domain;
  price: number;
  currency: string;
  cancellationPolicy: string | null;
}

export interface BookingTaskResult {
  bookingStatus: BookingStatus;
  idempotencyKey: string;
  /** Always 'not_executed' in Phase 6 - no real provider write exists yet to change it. Exists so a future execute step has somewhere to record 'unknown'/'confirmed', and so this phase's tests can prove no write ever occurred. */
  executionState: BookingExecutionState;
  selectedOffer: SelectedOfferSnapshot;
  expiresAt: string;
}

export interface BookingIntentResult extends BookingTaskResult {
  taskId: string;
}

function isBookingTaskResult(value: unknown): value is BookingTaskResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BookingTaskResult).bookingStatus === 'string' &&
    typeof (value as BookingTaskResult).idempotencyKey === 'string'
  );
}

/**
 * Booking preparation (V2 architecture Phase 6/§I - "no real booking
 * execution" per this phase's explicit scope): creates a booking
 * *intent*, never a booking. Reuses the generic `tasks` table (a new
 * `task_type = 'booking'`, migrations/1700000009000_tasks-booking-type.js)
 * rather than a new table, exactly as instructed.
 *
 * The selected offer is looked up from the conversation's latest
 * COMPLETE comparison task - never a fresh provider call - the same
 * "trust only what was actually persisted" discipline
 * src/agents/ordinal-resolution.ts and src/tasks/get-cancellation-policy.ts
 * already established. An offerId that isn't in that task is a clear
 * error, never a guess.
 *
 * A stable idempotency key (`crypto.randomUUID()`) is generated exactly
 * once, at intent-creation time, and persisted - it is never
 * regenerated on a later read of the same task, so "stable for the same
 * booking attempt" holds structurally.
 */
export async function createBookingIntent(
  pool: Pool,
  conversationId: string,
  offerId: string,
): Promise<BookingIntentResult> {
  const comparisonTask = await getLatestTaskForConversation(pool, conversationId, 'comparison');
  if (!comparisonTask || comparisonTask.status !== 'complete' || !comparisonTask.result) {
    throw new Error("I don't have a completed comparison in this conversation to book from - try comparing first.");
  }

  const result = comparisonTask.result as unknown as ComparisonTaskResult;
  const offer = result.offers.find((o) => o.offerId === offerId);
  if (!offer) {
    throw new Error(`I can't find offer ${offerId} in your last comparison - try comparing again.`);
  }

  const selectedOffer: SelectedOfferSnapshot = {
    offerId: offer.offerId,
    provider: offer.provider,
    domain: offer.domain,
    price: offer.price,
    currency: offer.currency,
    cancellationPolicy: 'cancellationPolicy' in offer && typeof offer.cancellationPolicy === 'string' ? offer.cancellationPolicy : null,
  };

  const bookingTaskResult: BookingTaskResult = {
    bookingStatus: 'awaiting_confirmation',
    idempotencyKey: randomUUID(),
    executionState: 'not_executed',
    selectedOffer,
    expiresAt: new Date(Date.now() + BOOKING_INTENT_TTL_MS).toISOString(),
  };

  const taskId = await createTask(pool, conversationId, 'booking');
  await completeTask(pool, taskId, bookingTaskResult);

  return { taskId, ...bookingTaskResult };
}

/**
 * The confirmation boundary (V2 architecture Phase 6/§I): the ONLY way
 * `bookingStatus` can ever move from 'awaiting_confirmation' to
 * 'confirmed'. Never inferred from selecting an offer, asking its
 * price, asking about availability, or free text like "book this" -
 * the caller (Supervisor) must supply the EXACT taskId this function
 * returned, scoped to the SAME conversation, which is itself the
 * explicit confirmation mechanism (an even stricter bar than the
 * architecture's own minimum of "an affirmative reply to that specific
 * pending task").
 *
 * Guarded by a DB-level conditional UPDATE keyed on the task id (plan
 * §I's "our-side" idempotency guard) - a second concurrent confirm
 * against the same task finds zero rows updated and simply re-reads the
 * (already-confirmed) state rather than erroring or double-transitioning.
 *
 * This function never calls a provider and never sets `executionState`
 * to anything other than what was already there ('not_executed') - the
 * write step itself is explicitly unimplemented in this phase.
 */
export async function confirmBookingIntent(
  pool: Pool,
  conversationId: string,
  taskId: string,
): Promise<BookingIntentResult> {
  const task = await getTask(pool, taskId);
  if (!task || task.taskType !== 'booking' || task.conversationId !== conversationId || task.status !== 'complete' || !isBookingTaskResult(task.result)) {
    throw new Error('Unknown booking to confirm - try creating a booking intent first.');
  }

  if (new Date(task.result.expiresAt).getTime() < Date.now()) {
    throw new Error('This booking offer has expired - please compare again to get a fresh price.');
  }

  if (task.result.bookingStatus === 'confirmed') {
    return { taskId, ...task.result };
  }

  const updated = await pool.query(
    `update tasks set result = jsonb_set(result, '{bookingStatus}', '"confirmed"'), updated_at = now()
     where id = $1 and result ->> 'bookingStatus' = 'awaiting_confirmation'
     returning result`,
    [taskId],
  );

  if (updated.rows.length === 0) {
    // Lost a concurrent confirm race - the other request already
    // transitioned it; re-read rather than erroring (idempotent).
    const refreshed = await getTask(pool, taskId);
    return { taskId, ...(refreshed!.result as unknown as BookingTaskResult) };
  }

  return { taskId, ...(updated.rows[0].result as BookingTaskResult) };
}
