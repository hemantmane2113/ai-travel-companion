/**
 * V2 architecture Phase 7 (docs/architecture-v2-agent-companion.md §F/§I,
 * the document's own Phase 8): real external booking state, now that a
 * Booking Agent actually executes a confirmed booking intent through a
 * WriteProvider. `tasks` (Phase 6) remains the preparation/confirmation
 * workflow record - it is NOT replaced. `bookings` is the actual external
 * booking state; `booking_events` is its append-only execution history.
 *
 * `task_id`/`idempotency_key` are both UNIQUE - this is the DB-level
 * concurrency guard (plan §I "our-side" idempotency): two concurrent
 * execution attempts for the same booking intent can never both insert a
 * row, so at most one caller ever proceeds to call the provider (see
 * src/agents/booking-agent.ts).
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table bookings (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null unique references tasks(id) on delete cascade,
      conversation_id uuid not null references conversations(id) on delete cascade,
      provider text not null,
      domain text not null check (domain in ('hotel', 'flight', 'train', 'bus')),
      idempotency_key text not null unique,
      external_booking_id text,
      status text not null check (status in ('executing', 'booked', 'failed')),
      offer_snapshot jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index idx_bookings_conversation on bookings(conversation_id);

    create table booking_events (
      id uuid primary key default gen_random_uuid(),
      booking_id uuid not null references bookings(id) on delete cascade,
      event_type text not null check (
        event_type in ('execution_requested', 'execution_started', 'booking_succeeded', 'booking_failed')
      ),
      status text,
      external_reference text,
      payload jsonb,
      created_at timestamptz not null default now()
    );

    create index idx_booking_events_booking on booking_events(booking_id, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists booking_events cascade;
    drop table if exists bookings cascade;
  `);
};
