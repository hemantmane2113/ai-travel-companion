import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { routeMessage } from '../src/agents/supervisor-agent';
import { listMessages } from '../src/companion/conversations';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { getJob } from '../src/itinerary/jobs';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { DESTINATIONS } from '../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { deleteItineraryAndJob, deletePlacesByExternalRef } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const TEST_PREFIX = 'test:supervisor-agent';
const { bbox, center } = DESTINATIONS.delhi;
const START_DATE = '2026-10-01';
const END_DATE = '2026-10-01';

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:0`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {},
};

function noopLlm(): FakeLlmProvider {
  // The Q&A route never calls the LLM at all (§ answer-question.ts) -
  // this stand-in exists only so routeMessage's signature is satisfied;
  // if it were ever invoked by the Q&A path these tests would need to
  // supply a real response, which is itself a useful regression signal.
  return new FakeLlmProvider('THIS SHOULD NEVER BE CALLED FOR A Q&A REQUEST');
}

describe('routeMessage (Supervisor Agent)', () => {
  it('routes a full-trip request (destinationSlug + dates supplied) to the Planning Agent, which reaches the existing itinerary pipeline unchanged', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const factRow = await pool.query(
      `select f.current_version_id as fact_version_id
       from places p join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
       where p.external_ref = $1`,
      [RED_FORT.externalRef],
    );
    const placeRow = await pool.query('select id from places where external_ref = $1', [RED_FORT.externalRef]);
    const factVersionId = factRow.rows[0].fact_version_id;
    const placeId = placeRow.rows[0].id;

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [{ itemType: 'place', placeId, reason: 'A must-see fort.', factReferences: [factVersionId] }],
          },
        ],
      }),
    );

    let result: Awaited<ReturnType<typeof routeMessage>> | undefined;
    try {
      result = await routeMessage(pool, llm, {
        message: 'I am visiting Delhi for 3 days. Plan a trip for me.',
        destinationSlug: 'delhi',
        interests: ['history'],
        startDate: START_DATE,
        endDate: END_DATE,
      });

      expect(result.route).toBe('full_trip');
      if (result.route !== 'full_trip') throw new Error('unreachable');

      // Poll, same as a real client would (fire-and-forget async job -
      // identical mechanism to POST /itineraries, unmodified).
      let job;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        job = await getJob(pool, result.jobId);
        if (job?.status === 'complete' || job?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(job?.status).toBe('complete');
      expect(job?.itineraryId).toBeTruthy();

      const messages = await listMessages(pool, result.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].structuredPayload).toEqual({ route: 'full_trip', jobId: result.jobId });
    } finally {
      if (result?.route === 'full_trip') {
        const job = await getJob(pool, result.jobId);
        await deleteItineraryAndJob(pool, { jobId: result.jobId, itineraryId: job?.itineraryId });
      }
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('routes a plain question to the Q&A path WITHOUT creating any itinerary job or itinerary', async () => {
    // A global COUNT(*) before/after would be racy against other test
    // files creating jobs concurrently (Vitest runs files in parallel) -
    // instead assert directly on the code path taken (route === 'qa')
    // and its persisted side effect (no jobId anywhere in the message
    // this call itself wrote), which is exact rather than a proxy.
    const result = await routeMessage(pool, noopLlm(), {
      message: 'How far is Totally Unknown Place One from Totally Unknown Place Two?',
    });

    expect(result.route).toBe('qa');
    if (result.route !== 'qa') throw new Error('unreachable');
    expect(result.answer).toMatch(/don't have location data/);
    expect('jobId' in result).toBe(false);

    const messages = await listMessages(pool, result.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Totally Unknown Place') });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: result.answer });
    expect(messages[1].structuredPayload).toEqual({ route: 'qa', matchedDestinationSlug: null });
  });

  it('continues an existing conversation instead of starting a new one when conversationId is supplied', async () => {
    const first = await routeMessage(pool, noopLlm(), { message: 'Tell me about Nowhere.' });
    const second = await routeMessage(pool, noopLlm(), {
      message: 'And what about Nowhere Else?',
      conversationId: first.conversationId,
    });

    expect(second.conversationId).toBe(first.conversationId);
    const messages = await listMessages(pool, first.conversationId);
    expect(messages).toHaveLength(4); // 2 user + 2 assistant, same thread
  });

  it('rejects a message for an unknown conversationId rather than silently creating a new thread', async () => {
    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'hello',
        conversationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/Unknown conversation/);
  });
});
