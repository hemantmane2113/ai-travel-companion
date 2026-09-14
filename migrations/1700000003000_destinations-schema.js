/**
 * A minimal destinations table (plan §9's seeded-warning task needs a
 * real uuid entity for facts.entity_id to point at - destinations are
 * otherwise just an in-memory config, src/destinations.ts). Not a
 * general destinations-management feature; just enough to let warning
 * facts fit the same polymorphic facts/fact_versions schema as places.
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table destinations (
      id uuid primary key default gen_random_uuid(),
      slug text not null unique,
      name text not null,
      created_at timestamptz not null default now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`drop table if exists destinations cascade;`);
};
