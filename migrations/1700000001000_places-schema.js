/**
 * Places (plan §3/§9): the shared POI store that Food and Shopping ride
 * on top of. Rows here are written only by the ingestion pipeline; the
 * runtime itinerary path only ever reads this table, never an external
 * provider (plan §2).
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table places (
      id uuid primary key default gen_random_uuid(),
      -- Simple slug for V1 (e.g. 'delhi') rather than a separate
      -- destinations table - there is exactly one launch destination
      -- and no consumer yet that needs a normalized destinations table.
      destination text not null,
      name text not null,
      category text not null check (category in ('attraction', 'restaurant', 'shop')),
      location geography(Point, 4326) not null,
      -- Provider-qualified id (e.g. 'osm:node/123') so re-ingestion is
      -- idempotent (update, not duplicate) and adding a second provider
      -- later can't collide with OSM's id space.
      external_ref text,
      created_at timestamptz not null default now()
    );

    create unique index idx_places_external_ref on places(external_ref) where external_ref is not null;
    create index idx_places_location on places using gist(location);
    create index idx_places_destination_category on places(destination, category);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`drop table if exists places cascade;`);
};
