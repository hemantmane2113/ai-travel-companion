import type { Pool } from 'pg';

export interface WarningWithProvenance {
  text: string;
  confidence: number;
  source: { name: string; url: string | null; licence: string | null };
}

/**
 * Reads seeded warning facts with provenance - the same "why does the
 * system believe this" pattern as every other recommendation surface
 * (plan §5), for the one domain currently backed by manually-curated
 * rather than ingested data.
 */
export async function getWarnings(
  pool: Pool,
  destinationSlug: string,
): Promise<WarningWithProvenance[]> {
  const rows = await pool.query(
    `select fv.value ->> 'text' as text, fv.confidence,
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
    text: row.text,
    confidence: Number(row.confidence),
    source: { name: row.source_name, url: row.source_url, licence: row.source_licence },
  }));
}
