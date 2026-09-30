/**
 * V2 architecture Phase 2 (docs/architecture-v2-agent-companion.md §F):
 * the minimum conversation/message persistence needed to prove the
 * companion endpoint and its deterministic-first Supervisor router.
 *
 * Deliberately excludes a `tasks` table this phase - nothing in Phase 2
 * writes one (a full-trip request still uses the existing
 * `itinerary_jobs`/`itineraries` tables unchanged; the Q&A path is
 * explicitly required to avoid creating a task at all), so adding it
 * now would be speculative infrastructure. It arrives in the phase that
 * first needs it (Comparison Agent).
 *
 * Also deliberately excludes a `users` table / any `user_id` column -
 * auth schema is explicitly out of scope this phase, and nothing in the
 * app has an auth/user concept yet (not even `itinerary_jobs`), so
 * `conversations` has no owner column for now rather than inventing one
 * ahead of an actual auth phase.
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table conversations (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table messages (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references conversations(id) on delete cascade,
      role text not null check (role in ('user', 'assistant')),
      content text not null,
      -- Free-form per-message detail (e.g. { route: 'full_trip', jobId }
      -- or { route: 'qa', matchedDestinationSlug }) - deliberately loose
      -- rather than a rigid schema this early, same spirit as
      -- itinerary_jobs.rejected_items being jsonb.
      structured_payload jsonb,
      created_at timestamptz not null default now()
    );

    create index idx_messages_conversation on messages(conversation_id, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists messages cascade;
    drop table if exists conversations cascade;
  `);
};
