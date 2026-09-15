import type { Pool } from 'pg';
import type { GeneratedItineraryItem } from '../ai/itinerary-plan';

export type ItineraryJobStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface ItineraryJobRow {
  id: string;
  itineraryId: string | null;
  destination: string;
  interests: string[];
  startDate: string;
  endDate: string;
  status: ItineraryJobStatus;
  error: string | null;
  rejectedItems: GeneratedItineraryItem[];
}

export async function createJob(
  pool: Pool,
  destination: string,
  interests: string[],
  startDate: string,
  endDate: string,
): Promise<string> {
  const result = await pool.query(
    `insert into itinerary_jobs (destination, interests, start_date, end_date, status)
     values ($1, $2, $3, $4, 'pending') returning id`,
    [destination, interests, startDate, endDate],
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
  rejectedItems: GeneratedItineraryItem[],
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
    // to_char, not the raw `date` column: node-postgres parses `date`
    // into a JS Date at UTC midnight by default, which risks a
    // timezone-dependent off-by-one when serialized - forcing a plain
    // 'YYYY-MM-DD' string here keeps it exact and unambiguous.
    `select id, itinerary_id, destination, interests,
            to_char(start_date, 'YYYY-MM-DD') as start_date,
            to_char(end_date, 'YYYY-MM-DD') as end_date,
            status, error, rejected_items
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
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    error: row.error,
    rejectedItems: row.rejected_items,
  };
}
