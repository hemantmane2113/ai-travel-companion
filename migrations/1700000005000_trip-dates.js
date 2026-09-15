/**
 * Stabilization P0-4: multi-day trip support. itineraries and
 * itinerary_jobs both need the requested date range - itineraries so a
 * fetched itinerary can show its own dates, itinerary_jobs so a job's
 * status response can show what was requested even before the
 * itinerary row exists.
 */

exports.up = (pgm) => {
  pgm.sql(`
    alter table itineraries
      add column start_date date not null default current_date,
      add column end_date date not null default current_date;
    alter table itineraries alter column start_date drop default;
    alter table itineraries alter column end_date drop default;

    alter table itinerary_jobs
      add column start_date date not null default current_date,
      add column end_date date not null default current_date;
    alter table itinerary_jobs alter column start_date drop default;
    alter table itinerary_jobs alter column end_date drop default;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table itineraries drop column start_date, drop column end_date;
    alter table itinerary_jobs drop column start_date, drop column end_date;
  `);
};
