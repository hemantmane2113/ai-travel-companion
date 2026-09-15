import type { Pool } from 'pg';

export interface WarningCandidate {
  /** The exact fact_version this warning was read from - the id the AI
   * layer must cite in factReferences to include this warning (plan
   * stabilization P0-2/P0-3). */
  factVersionId: string;
  text: string;
  confidence: number;
  source: { name: string; url: string | null; licence: string | null };
}

/**
 * Reads seeded warning facts as Travel Intelligence candidates (plan
 * stabilization P0-2): "stored warning facts -> Travel Intelligence ->
 * constrained AI context". Mirrors queryPlacesByCategory's shape and
 * read-only-Postgres discipline - no external API, no live polling.
 */
export async function queryWarningCandidates(
  pool: Pool,
  destinationSlug: string,
): Promise<WarningCandidate[]> {
  const rows = await pool.query(
    `select fv.id as fact_version_id, fv.value ->> 'text' as text, fv.confidence,
            s.name as source_name, s.url as source_url, s.licence as source_licence
     from destinations d
     join facts f
       on f.entity_table = 'destinations' and f.entity_id = d.id and f.fact_type = 'travel_warning'
     join fact_versions fv on fv.id = f.current_version_id
     join sources s on s.id = fv.source_id
     where d.slug = $1
     order by fv.created_at`,
    [destinationSlug],
  );

  return rows.rows.map((row) => ({
    factVersionId: row.fact_version_id,
    text: row.text,
    confidence: Number(row.confidence),
    source: { name: row.source_name, url: row.source_url, licence: row.source_licence },
  }));
}
