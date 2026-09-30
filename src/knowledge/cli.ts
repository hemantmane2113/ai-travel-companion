import 'dotenv/config';
import { Pool } from 'pg';
import { seedKnowledgeDocuments } from './seed-knowledge';

/**
 * Manual seed command (V2 architecture Phase 6) - there is no live
 * knowledge-document ingestion pipeline yet; this writes placeholder
 * visa/advisory content for one destination, mirroring
 * src/advisory/cli.ts exactly.
 *
 * Usage: npm run seed:knowledge -- delhi
 */
async function main(): Promise<void> {
  const destinationSlug = process.argv[2];
  if (!destinationSlug) {
    console.error('Usage: npm run seed:knowledge -- <destination-slug>');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await seedKnowledgeDocuments(pool, destinationSlug);
    console.log(`Seeded ${result.documentsSeeded} new knowledge document(s) for ${result.destination}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
