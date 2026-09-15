import type { Pool } from 'pg';
import { queryWarningCandidates } from '../travel-intelligence/warning-candidates';

export interface WarningWithProvenance {
  text: string;
  confidence: number;
  source: { name: string; url: string | null; licence: string | null };
}

/**
 * Reads seeded warning facts with provenance - the same "why does the
 * system believe this" pattern as every other recommendation surface
 * (plan §5), for the one domain currently backed by manually-curated
 * rather than ingested data. Builds on the same Travel Intelligence
 * read path (queryWarningCandidates) that itinerary generation now
 * uses, rather than duplicating the query.
 */
export async function getWarnings(
  pool: Pool,
  destinationSlug: string,
): Promise<WarningWithProvenance[]> {
  const candidates = await queryWarningCandidates(pool, destinationSlug);
  return candidates.map(({ text, confidence, source }) => ({ text, confidence, source }));
}
