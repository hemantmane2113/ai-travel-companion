import type { Pool } from 'pg';

export interface KnowledgeDocumentInput {
  category: string;
  destinationSlug?: string | null;
  title: string;
  content: string;
  sourceName: string;
  sourceUrl?: string | null;
}

export interface KnowledgeDocumentRow {
  id: string;
  category: string;
  destinationSlug: string | null;
  title: string;
  content: string;
  sourceName: string;
  sourceUrl: string | null;
  retrievedAt: string;
  createdAt: string;
}

function toRow(row: {
  id: string;
  category: string;
  destination_slug: string | null;
  title: string;
  content: string;
  source_name: string;
  source_url: string | null;
  retrieved_at: string;
  created_at: string;
}): KnowledgeDocumentRow {
  return {
    id: row.id,
    category: row.category,
    destinationSlug: row.destination_slug,
    title: row.title,
    content: row.content,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    retrievedAt: row.retrieved_at,
    createdAt: row.created_at,
  };
}

/**
 * Writes one knowledge document (V2 architecture Phase 6 §A/§B). This is
 * the only insertion path into `knowledge_documents` - the RAG
 * ingestion boundary, mirroring how `ingestPlaces` is the only insertion
 * path into `places`. Callers (the seed script, or a future real
 * ingestion pipeline) never write SQL directly.
 */
export async function insertKnowledgeDocument(
  pool: Pool,
  input: KnowledgeDocumentInput,
): Promise<KnowledgeDocumentRow> {
  const result = await pool.query(
    `insert into knowledge_documents (category, destination_slug, title, content, source_name, source_url)
     values ($1, $2, $3, $4, $5, $6)
     returning id, category, destination_slug, title, content, source_name, source_url, retrieved_at, created_at`,
    [input.category, input.destinationSlug ?? null, input.title, input.content, input.sourceName, input.sourceUrl ?? null],
  );
  return toRow(result.rows[0]);
}

export async function getKnowledgeDocumentById(pool: Pool, id: string): Promise<KnowledgeDocumentRow | null> {
  const result = await pool.query(
    `select id, category, destination_slug, title, content, source_name, source_url, retrieved_at, created_at
     from knowledge_documents where id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return toRow(result.rows[0]);
}
