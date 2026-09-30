/**
 * V2 architecture Phase 9 (docs/architecture-v2-agent-companion.md §I
 * "Modification (new - the composite workflow)", the document's own
 * Phase 9): the hotel cancel-and-rebook composite. Purely additive -
 * widens `tasks.task_type` to add 'rebooking' (the composite intent/
 * confirmation record). No new table: the composite coordinates the
 * existing Phase 8 cancellation intent and a synthetic Phase 6/7 booking
 * intent, both already persisted as `tasks` rows of their own existing
 * types; only the outer orchestration record is new, and it reuses the
 * exact same generic `tasks` table.
 */

exports.up = (pgm) => {
  pgm.sql(`
    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check
      check (task_type in ('comparison', 'booking', 'cancellation', 'rebooking'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check
      check (task_type in ('comparison', 'booking', 'cancellation'));
  `);
};
