import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { answerQuestion } from '../src/companion/answer-question';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { seedWarnings } from '../src/advisory/seed-warnings';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { insertKnowledgeDocument } from '../src/knowledge/knowledge-documents';
import { DESTINATIONS } from '../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { deleteDestination, deleteKnowledgeDocumentsByIds, deletePlacesByExternalRef } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

// None of these existing (pre-Phase-6) question shapes are
// knowledge-oriented, so the LLM must never be invoked for any of them -
// this stand-in exists only to satisfy the signature, and its response
// would fail every assertion below if it were ever actually called.
function noopLlm(): FakeLlmProvider {
  return new FakeLlmProvider('THIS SHOULD NEVER BE CALLED');
}

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

describe('answerQuestion (Phase 2 Q&A capability)', () => {
  // findPlaceByName is not destination-scoped, so distance fixtures use
  // their own private bucket and never touch the shared real 'delhi'
  // destination other tests depend on.
  describe('distance questions', () => {
    const DESTINATION = 'test-qa-distance';
    const TEST_PREFIX = 'test:answer-question:distance';
    const { bbox, center } = DESTINATIONS.delhi;

    const PLACE_A: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:a`,
      name: 'Distance Test Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude,
      raw: {},
    };
    const PLACE_B: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:b`,
      name: 'Distance Test Gate',
      category: 'attraction',
      // ~0.1 deg longitude at this latitude is on the order of a few km -
      // exact value isn't asserted, only that a real positive number came back.
      latitude: center.latitude,
      longitude: center.longitude + 0.1,
      raw: {},
    };

    it('computes a real distance between two known places, grounded in their actual coordinates', async () => {
      const provider = new FixturePlacesProvider([PLACE_A, PLACE_B]);
      await ingestPlaces(pool, provider, DESTINATION, bbox);

      try {
        const result = await answerQuestion(
          pool,
          noopLlm(),
          'How far is Distance Test Fort from Distance Test Gate?',
        );

        expect(result.text).toMatch(/Distance Test Fort is about \d+(\.\d+)? km from Distance Test Gate\./);
        expect(result.matchedDestinationSlug).toBeNull();
      } finally {
        await deletePlacesByExternalRef(pool, [PLACE_A.externalRef, PLACE_B.externalRef]);
      }
    });

    it('gives an honest answer instead of a fabricated distance when a place is unknown', async () => {
      const result = await answerQuestion(
        pool,
        noopLlm(),
        'How far is Totally Unknown Place One from Totally Unknown Place Two?',
      );

      expect(result.text).toMatch(/don't have location data/);
      expect(result.text).not.toMatch(/km/);
      expect(result.matchedDestinationSlug).toBeNull();
    });
  });

  describe('destination-grounded questions (real "delhi")', () => {
    const TEST_PREFIX = 'test:answer-question:delhi';
    const { bbox, center } = DESTINATIONS.delhi;

    const KARIMS: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:restaurant`,
      name: "Karim's",
      category: 'restaurant',
      latitude: center.latitude,
      longitude: center.longitude + 0.01,
      raw: { cuisine: 'mughlai' },
    };

    it('recommends real, ingested restaurants for a food question about a known destination', async () => {
      const provider = new FixturePlacesProvider([KARIMS]);
      await ingestPlaces(pool, provider, 'delhi', bbox);

      try {
        const result = await answerQuestion(pool, noopLlm(), 'What should I eat in Delhi?');

        expect(result.matchedDestinationSlug).toBe('delhi');
        expect(result.text).toContain("Karim's");
      } finally {
        await deletePlacesByExternalRef(pool, [KARIMS.externalRef]);
      }
    });

    it('gives a grounded overview (counts only, no invented facts) for a generic destination question, including seeded warnings', async () => {
      const provider = new FixturePlacesProvider([KARIMS]);
      await ingestPlaces(pool, provider, 'delhi', bbox);
      await seedWarnings(pool, 'delhi');

      try {
        const result = await answerQuestion(pool, noopLlm(), 'Tell me about Delhi.');

        expect(result.matchedDestinationSlug).toBe('delhi');
        expect(result.text).toMatch(/Delhi has \d+ attraction\(s\), \d+ restaurant\(s\) and \d+ shop\(s\) on file/);
        expect(result.text).toMatch(/travel note\(s\)/);
      } finally {
        await deletePlacesByExternalRef(pool, [KARIMS.externalRef]);
        await deleteDestination(pool, 'delhi');
      }
    });
  });

  it('gives an honest "no information" answer for a destination this system has no data for, rather than inventing recommendations', async () => {
    const result = await answerQuestion(pool, noopLlm(), 'What should I eat at Indore Khau Galli?');

    expect(result.matchedDestinationSlug).toBeNull();
    expect(result.text).toMatch(/don't have information about that destination/);
  });

  describe('knowledge questions (Phase 6 RAG)', () => {
    it('uses knowledge retrieval and grounded narration for a visa/advisory question', async () => {
      const doc = await insertKnowledgeDocument(pool, {
        category: 'visa',
        destinationSlug: 'delhi',
        title: 'Test-inserted visa requirement for Delhi',
        content: 'A test-inserted e-Visa is required before arrival in Delhi.',
        sourceName: 'Test Q&A Source',
      });

      try {
        const llm = new FakeLlmProvider(
          JSON.stringify({
            answer: 'You need an e-Visa before arriving.',
            citations: [{ documentId: doc.id, note: 'Visa requirement.' }],
          }),
        );

        const result = await answerQuestion(pool, llm, 'What are the visa requirements for Delhi?');

        expect(result.matchedDestinationSlug).toBe('delhi');
        expect(result.text).toBe('You need an e-Visa before arriving.');
      } finally {
        await deleteKnowledgeDocumentsByIds(pool, [doc.id]);
      }
    });

    it('honestly reports no information when a knowledge question matches no retrieved document, never fabricating an answer', async () => {
      const result = await answerQuestion(
        pool,
        noopLlm(),
        'What is the xyzzyqux123nonexistent visa requirement for Delhi?',
      );

      expect(result.matchedDestinationSlug).toBe('delhi');
      expect(result.text).toMatch(/don't have any information on file/);
    });
  });
});
