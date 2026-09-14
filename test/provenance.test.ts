import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resolveCurrentVersion } from '../src/provenance';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe('provenance schema: sources / facts / fact_versions', () => {
  it('resolves facts.current_version_id by source priority on conflict, and keeps the losing version queryable', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const govSource = await client.query(
        `insert into sources (name, type, url, licence, priority, commercial_use_allowed)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          'Official Tourism Board',
          'official_government',
          'https://example.gov/tourism',
          'public_domain',
          100,
          true,
        ],
      );

      const communitySource = await client.query(
        `insert into sources (name, type, url, licence, priority, commercial_use_allowed)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          'OpenStreetMap (Overpass)',
          'osm_derived',
          'https://overpass-api.de',
          'odbl',
          10,
          true,
        ],
      );

      const fact = await client.query(
        `insert into facts (fact_type, entity_table, entity_id) values ($1, $2, $3) returning id`,
        ['opening_hours', 'places', '00000000-0000-0000-0000-000000000001'],
      );
      const factId = fact.rows[0].id as string;

      const now = new Date();
      const earlier = new Date(now.getTime() - 60_000);

      // Lower-priority source ingested first.
      const communityVersion = await client.query(
        `insert into fact_versions (fact_id, value, source_id, retrieved_at, confidence, version_number)
         values ($1, $2, $3, $4, $5, $6) returning id, retrieved_at`,
        [
          factId,
          JSON.stringify({ hours: '9am-5pm' }),
          communitySource.rows[0].id,
          earlier,
          0.6,
          1,
        ],
      );

      // Higher-priority source disagrees.
      const govVersion = await client.query(
        `insert into fact_versions (fact_id, value, source_id, retrieved_at, confidence, version_number)
         values ($1, $2, $3, $4, $5, $6) returning id, retrieved_at`,
        [
          factId,
          JSON.stringify({ hours: '10am-6pm' }),
          govSource.rows[0].id,
          now,
          0.95,
          2,
        ],
      );

      // This is the resolution logic the Ingestion/Sources module runs on
      // write (plan §5) - implemented here against the two candidates.
      const winner = resolveCurrentVersion([
        {
          id: communityVersion.rows[0].id,
          sourcePriority: 10,
          confidence: 0.6,
          retrievedAt: communityVersion.rows[0].retrieved_at,
        },
        {
          id: govVersion.rows[0].id,
          sourcePriority: 100,
          confidence: 0.95,
          retrievedAt: govVersion.rows[0].retrieved_at,
        },
      ]);

      expect(winner.id).toBe(govVersion.rows[0].id);

      await client.query(
        `update facts set current_version_id = $1 where id = $2`,
        [winner.id, factId],
      );

      const updatedFact = await client.query(
        `select current_version_id from facts where id = $1`,
        [factId],
      );
      expect(updatedFact.rows[0].current_version_id).toBe(govVersion.rows[0].id);

      // The losing (community) version must never be deleted - it stays
      // directly queryable even though it isn't "current" (plan §5: no
      // supersede relationship between conflicting cross-source versions).
      const losingVersion = await client.query(
        `select id, value, source_id from fact_versions where id = $1`,
        [communityVersion.rows[0].id],
      );
      expect(losingVersion.rows).toHaveLength(1);
      expect(losingVersion.rows[0].value).toEqual({ hours: '9am-5pm' });
      expect(losingVersion.rows[0].source_id).toBe(communitySource.rows[0].id);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
