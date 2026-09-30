/**
 * V2 architecture Phase 8 (docs/architecture-v2-agent-companion.md §5.8/
 * §I): Booking Management / Cancellation. Purely additive - widens three
 * existing CHECK constraints rather than creating a new table. `tasks`
 * gains a 'cancellation' task_type (the cancellation intent/confirmation
 * record, mirroring Phase 6's 'booking' intent exactly); `bookings`
 * gains 'cancelling'/'cancelled' statuses; `booking_events` gains the
 * four cancellation event types. No new table: a cancellation intent is
 * a `tasks` row, and cancellation history is `booking_events` rows on
 * the existing booking - exactly as instructed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check
      check (task_type in ('comparison', 'booking', 'cancellation'));

    alter table bookings drop constraint bookings_status_check;
    alter table bookings add constraint bookings_status_check
      check (status in ('executing', 'booked', 'failed', 'cancelling', 'cancelled'));

    alter table booking_events drop constraint booking_events_event_type_check;
    alter table booking_events add constraint booking_events_event_type_check
      check (event_type in (
        'execution_requested', 'execution_started', 'booking_succeeded', 'booking_failed',
        'cancellation_requested', 'cancellation_started', 'cancellation_succeeded', 'cancellation_failed'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table booking_events drop constraint booking_events_event_type_check;
    alter table booking_events add constraint booking_events_event_type_check
      check (event_type in ('execution_requested', 'execution_started', 'booking_succeeded', 'booking_failed'));

    alter table bookings drop constraint bookings_status_check;
    alter table bookings add constraint bookings_status_check
      check (status in ('executing', 'booked', 'failed'));

    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check
      check (task_type in ('comparison', 'booking'));
  `);
};
