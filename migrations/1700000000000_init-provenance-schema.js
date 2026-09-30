/**
 * Provenance foundation schema (plan §5): sources -> facts -> fact_versions.
 * Every normalized fact the system ever stores carries a fact_version row
 * pointing at the source it came from, so any recommendation can be traced
 * back to "why does the system believe this".
 */

exports.up = (pgm) => {
  pgm.sql(`
    create extension if not exists "pgcrypto";
    create extension if not exists postgis;

    create table sources (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      type text not null check (type in (
        'official_government', 'open_data_portal', 'osm_derived',
        'wiki', 'community_dataset', 'ngo_aggregator', 'other'
      )),
      url text,
      licence text,
      attribution_text text,
      requires_attribution boolean not null default false,
      commercial_use_allowed boolean,
      -- Deterministic conflict-resolution priority (plan §5): official
      -- government > established open-data aggregator > OSM/community tag.
      -- Higher number wins.
      priority integer not null default 0,
      created_at timestamptz not null default now()
    );

    create table facts (
      id uuid primary key default gen_random_uuid(),
      fact_type text not null,
      entity_table text not null,
      entity_id uuid not null,
      -- Nullable + added via ALTER below to break the circular reference
      -- with fact_versions (a fact points at its current version, a
      -- version points back at its fact).
      current_version_id uuid,
      created_at timestamptz not null default now()
    );

    create table fact_versions (
      id uuid primary key default gen_random_uuid(),
      fact_id uuid not null references facts(id) on delete cascade,
      value jsonb not null,
      source_id uuid not null references sources(id),
      retrieved_at timestamptz not null default now(),
      valid_from timestamptz,
      valid_until timestamptz,
      confidence numeric(3,2) not null default 1.0 check (confidence >= 0 and confidence <= 1),
      version_number integer not null,
      -- Only set when a source re-ingests and supersedes its OWN prior
      -- version. Conflicting versions from DIFFERENT sources are never
      -- linked this way (plan §5) - both stay independently queryable.
      superseded_by uuid references fact_versions(id),
      created_at timestamptz not null default now()
    );

    alter table facts
      add constraint facts_current_version_fk
      foreign key (current_version_id) references fact_versions(id);

    create index idx_fact_versions_fact_id on fact_versions(fact_id);
    create index idx_facts_entity on facts(entity_table, entity_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists fact_versions cascade;
    drop table if exists facts cascade;
    drop table if exists sources cascade;
  `);
};
