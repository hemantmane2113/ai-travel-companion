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

/**
 * Test-only helper: fully removes a destination row and its warning
 * facts/fact_versions (destinations.id is referenced by facts.entity_id
 * with no cascade, so current_version_id must be cleared first).
 */
export async function deleteDestination(pool: Pool, slug: string): Promise<void> {
  const destination = await pool.query('select id from destinations where slug = $1', [slug]);
  if (destination.rows.length === 0) return;
  const destinationId = destination.rows[0].id as string;

  await pool.query(
    `update facts set current_version_id = null
     where entity_table = 'destinations' and entity_id = $1`,
    [destinationId],
  );
  await pool.query(
    `delete from fact_versions where fact_id in (
       select id from facts where entity_table = 'destinations' and entity_id = $1
     )`,
    [destinationId],
  );
  await pool.query(`delete from facts where entity_table = 'destinations' and entity_id = $1`, [
    destinationId,
  ]);
  await pool.query('delete from destinations where id = $1', [destinationId]);
}

/**
 * Test-only helper: removes knowledge_documents rows by exact id.
 * Nothing else has an FK dependency on this table, so a plain delete is
 * safe with no ordering concerns - but callers should still capture and
 * pass exact ids (never a broad category/destination_slug query) so
 * repeated test runs never accumulate rows that could shift full-text
 * search ranking/ordering assertions in later runs.
 */
export async function deleteKnowledgeDocumentsByIds(pool: Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query('delete from knowledge_documents where id = any($1::uuid[])', [ids]);
}

/**
 * Test-only helper: removes bookings rows by exact task id (booking_events
 * cascade automatically via their FK to bookings.id). Callers must pass
 * exact tracked task ids, never a broad conversation/provider query -
 * same discipline as deleteKnowledgeDocumentsByIds.
 */
export async function deleteBookingsByTaskIds(pool: Pool, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await pool.query('delete from bookings where task_id = any($1::uuid[])', [taskIds]);
}
