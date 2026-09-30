/**
 * Itinerary persistence + job lifecycle (plan §3/§9). itinerary_jobs
 * tracks PENDING -> PROCESSING -> COMPLETE/FAILED; itinerary_items
 * carries the provenance chain from plan §5 (recommendation ->
 * fact_version -> source) so every recommendation is traceable.
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table itineraries (
      id uuid primary key default gen_random_uuid(),
      destination text not null,
      interests text[] not null default '{}',
      created_at timestamptz not null default now()
    );

    create table itinerary_days (
      id uuid primary key default gen_random_uuid(),
      itinerary_id uuid not null references itineraries(id) on delete cascade,
      day_number integer not null,
      summary text not null,
      created_at timestamptz not null default now(),
      unique (itinerary_id, day_number)
    );

    create table itinerary_items (
      id uuid primary key default gen_random_uuid(),
      itinerary_day_id uuid not null references itinerary_days(id) on delete cascade,
      place_id uuid references places(id),
      note text not null,
      -- Provenance chain (plan §5): recommendation -> fact_version -> source.
      referenced_fact_version_id uuid references fact_versions(id),
      provenance_kind text not null check (provenance_kind in ('verified', 'ai_inference')),
      sort_order integer not null,
      created_at timestamptz not null default now()
    );

    create index idx_itinerary_items_day on itinerary_items(itinerary_day_id);

    create table itinerary_jobs (
      id uuid primary key default gen_random_uuid(),
      itinerary_id uuid references itineraries(id),
      destination text not null,
      interests text[] not null default '{}',
      status text not null default 'pending'
        check (status in ('pending', 'processing', 'complete', 'failed')),
      error text,
      -- Audit trail of the AI Orchestration grounding check (plan §7):
      -- items the model referenced that were not in the supplied
      -- candidate set, stripped before persistence rather than kept.
      rejected_items jsonb not null default '[]',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists itinerary_jobs cascade;
    drop table if exists itinerary_items cascade;
    drop table if exists itinerary_days cascade;
    drop table if exists itineraries cascade;
  `);
};
