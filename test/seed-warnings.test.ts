import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { seedWarnings } from '../src/advisory/seed-warnings';
import { getWarnings } from '../src/advisory/get-warnings';
import { deleteDestination } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe('seedWarnings / getWarnings', () => {
  it('seeds warnings with provenance and is idempotent on re-run', async () => {
    try {
      const first = await seedWarnings(pool, 'delhi');
      expect(first).toEqual({ destination: 'delhi', warningsSeeded: 2 });

      const warnings = await getWarnings(pool, 'delhi');
      expect(warnings).toHaveLength(2);
      for (const warning of warnings) {
        expect(warning.text.length).toBeGreaterThan(0);
        expect(warning.confidence).toBe(0.5); // provisional, not independently verified
        expect(warning.source.name).toBe('Manually curated Phase 1 seed content');
      }
      expect(warnings.some((w) => w.text.toLowerCase().includes('visa'))).toBe(true);

      // Re-seeding must not duplicate - same content, same facts.
      const second = await seedWarnings(pool, 'delhi');
      expect(second).toEqual({ destination: 'delhi', warningsSeeded: 0 });
      const warningsAfter = await getWarnings(pool, 'delhi');
      expect(warningsAfter).toHaveLength(2);
    } finally {
      await deleteDestination(pool, 'delhi');
    }
  });

  it('throws for an unknown destination', async () => {
    await expect(seedWarnings(pool, 'atlantis')).rejects.toThrow(/Unknown destination/);
  });

  it('returns no warnings for a destination that has none seeded', async () => {
    // getWarnings doesn't validate against DESTINATIONS - it just reads
    // what's there, so an arbitrary un-seeded slug is a valid case here,
    // independent of test execution order.
    const warnings = await getWarnings(pool, 'mumbai');
    expect(warnings).toEqual([]);
  });
});
