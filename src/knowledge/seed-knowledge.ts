import type { Pool } from 'pg';
import { DESTINATIONS } from '../destinations';
import { insertKnowledgeDocument } from './knowledge-documents';

// Manually curated Phase 6 seed content - same posture as
// src/advisory/seed-warnings.ts's placeholder warnings: not live-fetched
// from an official feed, deliberately generic/uncontroversial guidance
// rather than a specific time-sensitive claim this codebase has no way
// to verify live. Proves the RAG retrieval path against real content
// without inventing an authoritative-sounding document.
const SEED_DOCUMENTS: Record<string, Array<{ category: string; title: string; content: string }>> = {
  delhi: [
    {
      category: 'visa',
      title: 'Visa requirements for visiting Delhi, India',
      content:
        'Most foreign nationals require a visa or e-Visa to enter India. Requirements vary by nationality - check eligibility and apply in advance through the official Indian e-Visa portal before travelling. Carry a printed copy of your visa approval alongside your passport.',
    },
    {
      category: 'advisory',
      title: 'General safety advisory for Delhi',
      content:
        'As in any major city, stay alert in crowded areas such as markets and public transport, keep valuables secure, and keep copies of your passport and visa separate from the originals. Use officially licensed taxis or ride-hailing apps rather than unmarked vehicles.',
    },
  ],
};

const SEED_SOURCE_NAME = 'Manually curated Phase 6 seed content';

export interface SeedKnowledgeResult {
  destination: string;
  documentsSeeded: number;
}

/**
 * Manually-seeded knowledge documents (V2 architecture Phase 6 §A) -
 * proves the RAG retrieval path (src/knowledge/retrieve-knowledge.ts)
 * against real, honestly-labeled content, the same way seed-warnings.ts
 * already does for the older fact_version-based warnings path. Not
 * idempotent-by-content-hash like ingestPlaces (there is no natural
 * external id for a hand-written document) - re-running inserts a fresh
 * row only when a document with the same title doesn't already exist
 * for that destination, so repeated runs stay side-effect-free.
 */
export async function seedKnowledgeDocuments(pool: Pool, destinationSlug: string): Promise<SeedKnowledgeResult> {
  const destination = DESTINATIONS[destinationSlug];
  if (!destination) {
    throw new Error(`Unknown destination: ${destinationSlug}`);
  }

  const documents = SEED_DOCUMENTS[destinationSlug] ?? [];
  let seeded = 0;

  for (const doc of documents) {
    const existing = await pool.query(
      `select id from knowledge_documents where destination_slug = $1 and title = $2`,
      [destination.slug, doc.title],
    );
    if (existing.rows.length > 0) continue;

    await insertKnowledgeDocument(pool, {
      category: doc.category,
      destinationSlug: destination.slug,
      title: doc.title,
      content: doc.content,
      sourceName: SEED_SOURCE_NAME,
      sourceUrl: null,
    });
    seeded += 1;
  }

  return { destination: destinationSlug, documentsSeeded: seeded };
}
