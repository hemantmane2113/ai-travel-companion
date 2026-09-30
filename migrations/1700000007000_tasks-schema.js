/**
 * V2 architecture Phase 4 (docs/architecture-v2-agent-companion.md §F):
 * the generic `tasks` table - the generalization of `itinerary_jobs` for
 * workflows beyond planning. Comparison is the first consumer; Booking
 * is expected to reuse the same table later (task_type gains a new
 * allowed value then, not a new table).
 *
 * Deliberately excludes any comparison/booking-specific columns
 * (offer ids, provider names, etc.) - those live inside `result` jsonb,
 * scoped per task_type, same spirit as `itinerary_jobs.rejected_items`
 * being jsonb rather than a normalized side table.
 *
 * `itinerary_jobs` is NOT migrated onto this table - it stays exactly as
 * it is (plan §M: "unifying itinerary_jobs into tasks is a later,
 * separate refactor once the pattern is proven").
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table tasks (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references conversations(id) on delete cascade,
      task_type text not null check (task_type in ('comparison')),
      status text not null default 'pending'
        check (status in ('pending', 'processing', 'complete', 'failed')),
      result jsonb,
      error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index idx_tasks_conversation on tasks(conversation_id, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists tasks cascade;
  `);
};
