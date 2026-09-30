import type { Pool } from 'pg';

export interface KnowledgeDocumentMatch {
  id: string;
  category: string;
  destinationSlug: string | null;
  title: string;
  content: string;
  sourceName: string;
  sourceUrl: string | null;
  retrievedAt: string;
}

export interface RetrieveKnowledgeOptions {
  /** Scope results to one destination when the question is destination-specific. Omit to search across all documents. */
  destinationSlug?: string;
  category?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;

function toMatch(row: {
  id: string;
  category: string;
  destination_slug: string | null;
  title: string;
  content: string;
  source_name: string;
  source_url: string | null;
  retrieved_at: string;
}): KnowledgeDocumentMatch {
  return {
    id: row.id,
    category: row.category,
    destinationSlug: row.destination_slug,
    title: row.title,
    content: row.content,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    retrievedAt: row.retrieved_at,
  };
}

/**
 * The knowledge retrieval boundary (V2 architecture Phase 6 §A/§B):
 * the ONLY place that queries `knowledge_documents`. Deterministic -
 * PostgreSQL full-text search (`plainto_tsquery` against the generated
 * `search_vector` column), no LLM reasoning at all. Returns structured
 * matches carrying their own id/source, so a caller can cite/identify
 * exactly what was retrieved (never re-derive or paraphrase it into a
 * new "fact"). Ranked by `ts_rank`, with a stable deterministic
 * tie-break (`retrieved_at desc, id`) so repeated calls against
 * unchanged data return the same order.
 *
 * Agents/Q&A never write SQL against this table directly (plan §3) -
 * they call this function.
 */
export async function retrieveKnowledge(
  pool: Pool,
  query: string,
  options: RetrieveKnowledgeOptions = {},
): Promise<KnowledgeDocumentMatch[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const conditions: string[] = [`search_vector @@ plainto_tsquery('english', $1)`];
  const params: unknown[] = [query];

  if (options.destinationSlug) {
    params.push(options.destinationSlug);
    conditions.push(`destination_slug = $${params.length}`);
  }
  if (options.category) {
    params.push(options.category);
    conditions.push(`category = $${params.length}`);
  }

  params.push(limit);
  const limitParamIndex = params.length;

  const result = await pool.query(
    `select id, category, destination_slug, title, content, source_name, source_url, retrieved_at,
            ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
     from knowledge_documents
     where ${conditions.join(' and ')}
     order by rank desc, retrieved_at desc, id
     limit $${limitParamIndex}`,
    params,
  );

  return result.rows.map(toMatch);
}
