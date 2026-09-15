/**
 * Stabilization P0-2/P0-3: itinerary_items must be able to represent a
 * warning (no place_id) alongside a place recommendation, distinguished
 * explicitly rather than inferred from place_id being null.
 */

exports.up = (pgm) => {
  pgm.sql(`
    alter table itinerary_items
      add column item_type text not null default 'place'
        check (item_type in ('place', 'warning'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`alter table itinerary_items drop column item_type;`);
};
