import 'dotenv/config';
import { Pool } from 'pg';
import { seedWarnings } from './seed-warnings';

/**
 * Manual seed command (plan §9) - there is no live Advisory ingestion
 * service yet; this writes the placeholder warning content for one
 * destination through the same provenance schema as everything else.
 *
 * Usage: npm run seed:warnings -- delhi
 */
async function main(): Promise<void> {
  const destinationSlug = process.argv[2];
  if (!destinationSlug) {
    console.error('Usage: npm run seed:warnings -- <destination-slug>');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await seedWarnings(pool, destinationSlug);
    console.log(`Seeded ${result.warningsSeeded} new warning(s) for ${result.destination}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
