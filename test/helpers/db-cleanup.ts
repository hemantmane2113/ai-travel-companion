import type { Pool } from 'pg';

/**
 * Test-only helper: fully removes places (and their facts/fact_versions)
 * by external_ref, respecting facts_current_version_fk ordering (clear
 * current_version_id before fact_versions can be deleted).
 */
export async function deletePlacesByExternalRef(
  pool: Pool,
  externalRefs: string[],
): Promise<void> {
  if (externalRefs.length === 0) return;

  const placeIds = await pool.query('select id from places where external_ref = any($1::text[])', [
    externalRefs,
  ]);
  const ids = placeIds.rows.map((r) => r.id as string);
  if (ids.length === 0) return;

  await pool.query(
    `update facts set current_version_id = null
     where entity_table = 'places' and entity_id = any($1::uuid[])`,
    [ids],
  );
  await pool.query(
    `delete from fact_versions where fact_id in (
       select id from facts where entity_table = 'places' and entity_id = any($1::uuid[])
     )`,
    [ids],
  );
  await pool.query(
    `delete from facts where entity_table = 'places' and entity_id = any($1::uuid[])`,
    [ids],
  );
  await pool.query('delete from places where id = any($1::uuid[])', [ids]);
}

/**
 * Test-only helper: removes an itinerary job and its itinerary (days and
 * items cascade automatically). The job must be deleted first - it has
 * a non-cascading FK to itineraries.id.
 */
export async function deleteItineraryAndJob(
  pool: Pool,
  ids: { jobId?: string | null; itineraryId?: string | null },
): Promise<void> {
  if (ids.jobId) {
    await pool.query('delete from itinerary_jobs where id = $1', [ids.jobId]);
  }
  if (ids.itineraryId) {
    await pool.query('delete from itineraries where id = $1', [ids.itineraryId]);
  }
}
