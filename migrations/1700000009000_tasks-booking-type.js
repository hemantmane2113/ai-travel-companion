/**
 * V2 architecture Phase 6 (docs/architecture-v2-agent-companion.md §F/§I):
 * booking preparation reuses the existing generic `tasks` table (per the
 * architecture's own instruction to reuse `tasks` rather than add a new
 * table) - but `tasks.task_type` carries a hard
 * `check (task_type in ('comparison'))` constraint from Phase 4
 * (migrations/1700000007000_tasks-schema.js), which would reject any
 * 'booking' row outright. This is the smallest possible change: widen
 * the existing constraint, no new column, no new table.
 */

exports.up = (pgm) => {
  pgm.sql(`
    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check check (task_type in ('comparison', 'booking'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table tasks drop constraint tasks_task_type_check;
    alter table tasks add constraint tasks_task_type_check check (task_type in ('comparison'));
  `);
};
