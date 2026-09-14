import 'dotenv/config';
import { Pool } from 'pg';
import { OsmOverpassAdapter } from '../providers/osm-overpass-adapter';
import { DESTINATIONS } from './destinations';
import { ingestPlaces } from './ingest-places';

/**
 * Phase 1 ingestion is a manually-triggered command, not a scheduler
 * (plan §8/§10) - there is exactly one launch destination and no real
 * consumer yet for automated refresh.
 *
 * Usage: npm run ingest:places -- delhi
 */
async function main(): Promise<void> {
  const destinationSlug = process.argv[2];
  const destination = destinationSlug ? DESTINATIONS[destinationSlug] : undefined;

  if (!destination) {
    console.error('Usage: npm run ingest:places -- <destination-slug>');
    console.error(`Known destinations: ${Object.keys(DESTINATIONS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const provider = new OsmOverpassAdapter();

  console.log(`Ingesting places for ${destination.name}...`);
  try {
    const result = await ingestPlaces(pool, provider, destination.slug, destination.bbox);
    console.log(`Done: ${result.placesCreated} created, ${result.placesUpdated} updated.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
