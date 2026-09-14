import type { Pool } from 'pg';
import type { DayPlanItem } from '../ai/day-plan';

export type ItineraryJobStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface ItineraryJobRow {
  id: string;
  itineraryId: string | null;
  destination: string;
  interests: string[];
  status: ItineraryJobStatus;
  error: string | null;
  rejectedItems: DayPlanItem[];
}

export async function createJob(
  pool: Pool,
  destination: string,
  interests: string[],
): Promise<string> {
  const result = await pool.query(
    `insert into itinerary_jobs (destination, interests, status) values ($1, $2, 'pending') returning id`,
    [destination, interests],
  );
  return result.rows[0].id;
}

export async function markJobProcessing(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `update itinerary_jobs set status = 'processing', updated_at = now() where id = $1`,
    [jobId],
  );
}

export async function markJobComplete(
  pool: Pool,
  jobId: string,
  itineraryId: string,
  rejectedItems: DayPlanItem[],
): Promise<void> {
  await pool.query(
    `update itinerary_jobs
       set status = 'complete', itinerary_id = $1, rejected_items = $2, updated_at = now()
     where id = $3`,
    [itineraryId, JSON.stringify(rejectedItems), jobId],
  );
}

export async function markJobFailed(pool: Pool, jobId: string, error: string): Promise<void> {
  await pool.query(
    `update itinerary_jobs set status = 'failed', error = $1, updated_at = now() where id = $2`,
    [error, jobId],
  );
}

export async function getJob(pool: Pool, jobId: string): Promise<ItineraryJobRow | null> {
  const result = await pool.query(
    `select id, itinerary_id, destination, interests, status, error, rejected_items
     from itinerary_jobs where id = $1`,
    [jobId],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    itineraryId: row.itinerary_id,
    destination: row.destination,
    interests: row.interests,
    status: row.status,
    error: row.error,
    rejectedItems: row.rejected_items,
  };
}
