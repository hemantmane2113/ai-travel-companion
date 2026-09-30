import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { insertKnowledgeDocument, getKnowledgeDocumentById } from '../src/knowledge/knowledge-documents';
import { retrieveKnowledge } from '../src/knowledge/retrieve-knowledge';
import { deleteKnowledgeDocumentsByIds } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

// A private destination-slug bucket, not the shared real 'delhi' - full
// text search results are scoped by destination_slug, so this is enough
// isolation from other concurrently-running test files (Vitest runs
// files in parallel by default). Every inserted id is tracked and
// deleted by exact id after each test (never a broad category/
// destination_slug delete) so repeated full-suite runs never accumulate
// rows that could shift a ranking/ordering assertion in a later run.
const DESTINATION = 'test-knowledge-retrieval';
let insertedIds: string[] = [];

afterEach(async () => {
  await deleteKnowledgeDocumentsByIds(pool, insertedIds);
  insertedIds = [];
});

async function insertTrackedDocument(input: Parameters<typeof insertKnowledgeDocument>[1]) {
  const doc = await insertKnowledgeDocument(pool, input);
  insertedIds.push(doc.id);
  return doc;
}

describe('insertKnowledgeDocument / getKnowledgeDocumentById', () => {
  it('persists a document with its source/provenance metadata and returns it by id', async () => {
    const inserted = await insertTrackedDocument({
      category: 'visa',
      destinationSlug: DESTINATION,
      title: 'Test visa document',
      content: 'A visa is required for this fictional test destination.',
      sourceName: 'Test Source',
      sourceUrl: 'https://example.test/visa',
    });

    expect(inserted.id).toBeTruthy();
    expect(inserted.sourceName).toBe('Test Source');
    expect(inserted.sourceUrl).toBe('https://example.test/visa');
    expect(inserted.retrievedAt).toBeTruthy();

    const fetched = await getKnowledgeDocumentById(pool, inserted.id);
    expect(fetched).toEqual(inserted);
  });

  it('returns null for an unknown document id', async () => {
    const result = await getKnowledgeDocumentById(pool, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});

describe('retrieveKnowledge', () => {
  it('finds a relevant document by full-text match', async () => {
    const doc = await insertTrackedDocument({
      category: 'visa',
      destinationSlug: DESTINATION,
      title: 'Visa requirements',
      content: 'Travellers need a visa before arriving. Apply through the official portal.',
      sourceName: 'Test Source',
    });

    const results = await retrieveKnowledge(pool, 'visa', { destinationSlug: DESTINATION });
    expect(results.some((r) => r.id === doc.id)).toBe(true);
  });

  it('returns an empty array when nothing matches', async () => {
    const results = await retrieveKnowledge(pool, 'zzznonexistentqueryterm', { destinationSlug: DESTINATION });
    expect(results).toEqual([]);
  });

  it('ranks multiple matching documents and returns deterministic ordering across repeated calls', async () => {
    const strong = await insertTrackedDocument({
      category: 'advisory',
      destinationSlug: DESTINATION,
      title: 'Safety advisory safety safety',
      content: 'Safety safety safety - stay safe and be aware of your safety at all times.',
      sourceName: 'Test Source',
    });
    const weak = await insertTrackedDocument({
      category: 'advisory',
      destinationSlug: DESTINATION,
      title: 'General note',
      content: 'This note mentions safety exactly once in passing.',
      sourceName: 'Test Source',
    });

    const first = await retrieveKnowledge(pool, 'safety', { destinationSlug: DESTINATION });
    const second = await retrieveKnowledge(pool, 'safety', { destinationSlug: DESTINATION });

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
    const strongIndex = first.findIndex((r) => r.id === strong.id);
    const weakIndex = first.findIndex((r) => r.id === weak.id);
    expect(strongIndex).toBeGreaterThanOrEqual(0);
    expect(weakIndex).toBeGreaterThanOrEqual(0);
    expect(strongIndex).toBeLessThan(weakIndex);
  });

  it('preserves the exact document id, category and source through retrieval', async () => {
    const doc = await insertTrackedDocument({
      category: 'other',
      destinationSlug: DESTINATION,
      title: 'Provenance check document',
      content: 'This document exists to prove provenance survives retrieval.',
      sourceName: 'Provenance Test Source',
      sourceUrl: 'https://example.test/provenance',
    });

    const [match] = await retrieveKnowledge(pool, 'provenance check document', { destinationSlug: DESTINATION });
    expect(match.id).toBe(doc.id);
    expect(match.category).toBe('other');
    expect(match.sourceName).toBe('Provenance Test Source');
    expect(match.sourceUrl).toBe('https://example.test/provenance');
  });

  it('scopes results by destinationSlug when supplied', async () => {
    const otherDestination = `${DESTINATION}-other`;
    await insertTrackedDocument({
      category: 'visa',
      destinationSlug: otherDestination,
      title: 'Unrelated destination visa doc',
      content: 'This document belongs to a totally different destination scope.',
      sourceName: 'Test Source',
    });

    const results = await retrieveKnowledge(pool, 'unrelated destination visa doc', { destinationSlug: DESTINATION });
    expect(results).toEqual([]);
  });

  it('scopes results by category when supplied', async () => {
    await insertTrackedDocument({
      category: 'cancellation_policy',
      destinationSlug: DESTINATION,
      title: 'Category scoping test document',
      content: 'This should only be found when filtering by the cancellation_policy category.',
      sourceName: 'Test Source',
    });

    const wrongCategory = await retrieveKnowledge(pool, 'category scoping test', {
      destinationSlug: DESTINATION,
      category: 'visa',
    });
    const rightCategory = await retrieveKnowledge(pool, 'category scoping test', {
      destinationSlug: DESTINATION,
      category: 'cancellation_policy',
    });

    expect(wrongCategory).toEqual([]);
    expect(rightCategory.length).toBeGreaterThan(0);
  });
});
