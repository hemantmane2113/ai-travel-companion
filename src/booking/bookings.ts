import type { Pool } from 'pg';
import type { Domain } from '../providers/hotel-provider';
import type { SelectedOfferSnapshot } from './booking-intent';

export type BookingRecordStatus = 'executing' | 'booked' | 'failed';

export interface BookingRow {
  id: string;
  taskId: string;
  conversationId: string;
  provider: string;
  domain: Domain;
  idempotencyKey: string;
  externalBookingId: string | null;
  status: BookingRecordStatus;
  offerSnapshot: SelectedOfferSnapshot;
  createdAt: string;
  updatedAt: string;
}

export type BookingEventType =
  | 'execution_requested'
  | 'execution_started'
  | 'booking_succeeded'
  | 'booking_failed';

export interface BookingEventRow {
  id: string;
  bookingId: string;
  eventType: BookingEventType;
  status: BookingRecordStatus | null;
  externalReference: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

function toBookingRow(row: {
  id: string;
  task_id: string;
  conversation_id: string;
  provider: string;
  domain: Domain;
  idempotency_key: string;
  external_booking_id: string | null;
  status: BookingRecordStatus;
  offer_snapshot: SelectedOfferSnapshot;
  created_at: string;
  updated_at: string;
}): BookingRow {
  return {
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    provider: row.provider,
    domain: row.domain,
    idempotencyKey: row.idempotency_key,
    externalBookingId: row.external_booking_id,
    status: row.status,
    offerSnapshot: row.offer_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBookingEventRow(row: {
  id: string;
  booking_id: string;
  event_type: BookingEventType;
  status: BookingRecordStatus | null;
  external_reference: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}): BookingEventRow {
  return {
    id: row.id,
    bookingId: row.booking_id,
    eventType: row.event_type,
    status: row.status,
    externalReference: row.external_reference,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/**
 * The DB-level concurrency guard (V2 architecture Phase 7/§I, "our-side"
 * idempotency - never an in-memory boolean): `bookings.task_id` is
 * UNIQUE, so at most one caller's insert ever succeeds for a given
 * booking intent. Returns null on conflict rather than throwing - the
 * Booking Agent (src/agents/booking-agent.ts) treats that as "someone
 * else already claimed this booking" and reads the existing row instead
 * of ever calling the provider itself.
 */
export async function insertExecutingBooking(
  pool: Pool,
  input: {
    taskId: string;
    conversationId: string;
    provider: string;
    domain: Domain;
    idempotencyKey: string;
    offerSnapshot: SelectedOfferSnapshot;
  },
): Promise<BookingRow | null> {
  const result = await pool.query(
    `insert into bookings (task_id, conversation_id, provider, domain, idempotency_key, status, offer_snapshot)
     values ($1, $2, $3, $4, $5, 'executing', $6)
     on conflict (task_id) do nothing
     returning id, task_id, conversation_id, provider, domain, idempotency_key, external_booking_id, status, offer_snapshot, created_at, updated_at`,
    [input.taskId, input.conversationId, input.provider, input.domain, input.idempotencyKey, JSON.stringify(input.offerSnapshot)],
  );
  if (result.rows.length === 0) return null;
  return toBookingRow(result.rows[0]);
}

export async function getBookingByTaskId(pool: Pool, taskId: string): Promise<BookingRow | null> {
  const result = await pool.query(
    `select id, task_id, conversation_id, provider, domain, idempotency_key, external_booking_id, status, offer_snapshot, created_at, updated_at
     from bookings where task_id = $1`,
    [taskId],
  );
  if (result.rows.length === 0) return null;
  return toBookingRow(result.rows[0]);
}

/**
 * Guarded by `where status = 'executing'` so a booking already finalized
 * by another (or a prior) call is never clobbered - a lost race here
 * means someone else already resolved this booking, so the caller
 * should re-read rather than trust this function's return blindly (the
 * Booking Agent does exactly that - see executeBookingIntent).
 */
export async function markBookingBooked(pool: Pool, bookingId: string, externalBookingId: string): Promise<BookingRow | null> {
  const result = await pool.query(
    `update bookings set status = 'booked', external_booking_id = $1, updated_at = now()
     where id = $2 and status = 'executing'
     returning id, task_id, conversation_id, provider, domain, idempotency_key, external_booking_id, status, offer_snapshot, created_at, updated_at`,
    [externalBookingId, bookingId],
  );
  if (result.rows.length === 0) return null;
  return toBookingRow(result.rows[0]);
}

export async function markBookingFailed(pool: Pool, bookingId: string): Promise<BookingRow | null> {
  const result = await pool.query(
    `update bookings set status = 'failed', updated_at = now()
     where id = $1 and status = 'executing'
     returning id, task_id, conversation_id, provider, domain, idempotency_key, external_booking_id, status, offer_snapshot, created_at, updated_at`,
    [bookingId],
  );
  if (result.rows.length === 0) return null;
  return toBookingRow(result.rows[0]);
}

/**
 * Append-only execution history (plan §F's booking_events). `payload`
 * must never contain provider credentials/API keys/secrets (CLAUDE.md
 * §20/§21) - callers in booking-agent.ts only ever pass a sanitized
 * error message string or a small structured note, never raw
 * provider request/response data.
 */
export async function insertBookingEvent(
  pool: Pool,
  bookingId: string,
  eventType: BookingEventType,
  details: { status?: BookingRecordStatus; externalReference?: string | null; payload?: Record<string, unknown> | null } = {},
): Promise<void> {
  await pool.query(
    `insert into booking_events (booking_id, event_type, status, external_reference, payload)
     values ($1, $2, $3, $4, $5)`,
    [
      bookingId,
      eventType,
      details.status ?? null,
      details.externalReference ?? null,
      details.payload ? JSON.stringify(details.payload) : null,
    ],
  );
}

export async function listBookingEvents(pool: Pool, bookingId: string): Promise<BookingEventRow[]> {
  const result = await pool.query(
    `select id, booking_id, event_type, status, external_reference, payload, created_at
     from booking_events where booking_id = $1 order by created_at, id`,
    [bookingId],
  );
  return result.rows.map(toBookingEventRow);
}
