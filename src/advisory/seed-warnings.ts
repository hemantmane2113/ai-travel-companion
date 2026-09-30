import type { Pool, PoolClient } from 'pg';
import { DESTINATIONS } from '../destinations';

// Placeholder Phase 1 seed content (plan §9): manually curated, not
// live-fetched from an official advisory feed - that integration is a
// deliberate Phase 2 concern (see the plan's reasoning for deferring
// the full Advisory module). Kept deliberately generic, uncontroversial
// travel guidance rather than asserting a specific, time-sensitive
// official advisory level this codebase has no way to verify live.
const SEED_WARNINGS: Record<string, string[]> = {
  delhi: [
    'Most foreign nationals require a visa or e-Visa to enter India. Requirements vary by nationality - check eligibility and apply in advance through the official Indian e-Visa portal before travelling.',
    'As in any major city, stay alert in crowded areas such as markets and public transport, keep valuables secure, and keep copies of your passport and visa separate from the originals.',
  ],
};

const SEED_SOURCE = {
  name: 'Manually curated Phase 1 seed content',
  type: 'other' as const,
  url: null as string | null,
  licence: null as string | null,
  attributionText: null as string | null,
  requiresAttribution: false,
  commercialUseAllowed: true,
  // Deliberately low priority (plan §5's conflict-resolution order):
  // this is provisional placeholder content, not an authoritative
  // source, and must lose to any real official/aggregator source added
  // later for the same fact.
  priority: 1,
};

async function getOrCreateDestination(
  client: PoolClient,
  slug: string,
  name: string,
): Promise<string> {
  const existing = await client.query('select id from destinations where slug = $1', [slug]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await client.query(
    'insert into destinations (slug, name) values ($1, $2) returning id',
    [slug, name],
  );
  return inserted.rows[0].id;
}

async function getOrCreateSeedSource(client: PoolClient): Promise<string> {
  const existing = await client.query('select id from sources where name = $1', [
    SEED_SOURCE.name,
  ]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `insert into sources
       (name, type, url, licence, attribution_text, requires_attribution, commercial_use_allowed, priority)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      SEED_SOURCE.name,
      SEED_SOURCE.type,
      SEED_SOURCE.url,
      SEED_SOURCE.licence,
      SEED_SOURCE.attributionText,
      SEED_SOURCE.requiresAttribution,
      SEED_SOURCE.commercialUseAllowed,
      SEED_SOURCE.priority,
    ],
  );
  return inserted.rows[0].id;
}

async function upsertWarningFact(
  client: PoolClient,
  destinationId: string,
  sourceId: string,
  text: string,
): Promise<boolean> {
  const existing = await client.query(
    `select f.id from facts f
     join fact_versions fv on fv.id = f.current_version_id
     where f.entity_table = 'destinations' and f.entity_id = $1
       and f.fact_type = 'travel_warning' and fv.value ->> 'text' = $2`,
    [destinationId, text],
  );
  if (existing.rows.length > 0) return false; // already seeded, no-op

  const fact = await client.query(
    `insert into facts (fact_type, entity_table, entity_id)
     values ('travel_warning', 'destinations', $1) returning id`,
    [destinationId],
  );
  const factId = fact.rows[0].id;

  const version = await client.query(
    `insert into fact_versions (fact_id, value, source_id, confidence, version_number)
     values ($1, $2, $3, 0.5, 1) returning id`,
    [factId, JSON.stringify({ text }), sourceId],
  );

  await client.query('update facts set current_version_id = $1 where id = $2', [
    version.rows[0].id,
    factId,
  ]);

  return true;
}

export interface SeedWarningsResult {
  destination: string;
  warningsSeeded: number;
}

/**
 * Manually-seeded warning facts (plan §9): proves the Travel
 * Intelligence "warnings" output type and the verified/ai_inference UI
 * distinction through the SAME facts/fact_versions/sources schema as
 * everything else, without building a live Advisory polling service.
 * Idempotent - re-running only inserts fact_versions for text that
 * isn't already recorded, same as ingestPlaces' upsert pattern.
 */
export async function seedWarnings(
  pool: Pool,
  destinationSlug: string,
): Promise<SeedWarningsResult> {
  const destination = DESTINATIONS[destinationSlug];
  if (!destination) {
    throw new Error(`Unknown destination: ${destinationSlug}`);
  }
  const texts = SEED_WARNINGS[destinationSlug] ?? [];

  const client = await pool.connect();
  let seeded = 0;
  try {
    await client.query('BEGIN');
    const destinationId = await getOrCreateDestination(client, destination.slug, destination.name);
    const sourceId = await getOrCreateSeedSource(client);

    for (const text of texts) {
      const wasNew = await upsertWarningFact(client, destinationId, sourceId, text);
      if (wasNew) seeded += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { destination: destinationSlug, warningsSeeded: seeded };
}
