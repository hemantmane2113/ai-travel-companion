import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runComparison, searchHotelOffersOnly } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { getTask, getLatestTaskForConversation } from '../src/tasks/tasks';
import { MockHotelProvider } from '../src/providers/mock-hotel-provider';
import { MockFlightProvider } from '../src/providers/mock-flight-provider';
import { MockTrainProvider } from '../src/providers/mock-train-provider';
import { MockBusProvider } from '../src/providers/mock-bus-provider';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../src/providers/hotel-provider';
import type { FlightProvider, NormalizedTransportOffer, TransportSearchCriteria } from '../src/providers/transport-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

class FailingHotelProvider implements HotelProvider {
  readonly providerName = 'FailingHotelProvider';
  async search(_criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]> {
    throw new Error('simulated outage');
  }
}

function validNarrationResponse(offerIds: string[]): string {
  return JSON.stringify({
    narrative: 'Here is a comparison of the available hotels.',
    highlights: offerIds.map((offerId) => ({ offerId, note: 'A valid option.' })),
  });
}

describe('runComparison (Comparison Agent)', () => {
  it('runs the full pipeline: search -> deterministic comparison -> narration -> persisted task with ordered offers', async () => {
    const conversationId = await createConversation(pool);
    const provider = new MockHotelProvider();
    const offers = await provider.search({ location: 'Karol Bagh' });
    const llm = new FakeLlmProvider(validNarrationResponse(offers.map((o) => o.offerId)));

    const { taskId, result } = await runComparison(pool, llm, {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    expect(result.domains).toEqual(['hotel']);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((o) => !('raw' in o))).toBe(true);
    expect(result.fellBackToDeterministic).toBe(false);
    expect(result.narrative).toBe('Here is a comparison of the available hotels.');
    expect(result.failedProviders).toEqual([]);

    // Ordering is authoritative and load-bearing (plan §F/§J).
    const prices = result.offers.map((o) => o.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    const task = await getTask(pool, taskId);
    expect(task!.status).toBe('complete');
    expect(task!.conversationId).toBe(conversationId);
    expect((task!.result as { offers: unknown[] }).offers).toEqual(result.offers);
  });

  it('rejects an unsupported domain before any task is created', async () => {
    const conversationId = await createConversation(pool);

    await expect(
      runComparison(pool, new FakeLlmProvider('{}'), {
        // @ts-expect-error - deliberately passing a genuinely unsupported domain to prove the runtime guard, not just the type system (all four real Domain values are supported as of Phase 5)
        domains: ['boat'],
        location: 'Karol Bagh',
        conversationId,
      }),
    ).rejects.toThrow(/Unsupported comparison domain/);
  });

  it('isolates a failing provider - the task still completes with the other provider\'s offers and reports the failure', async () => {
    const conversationId = await createConversation(pool);
    const llm = new FakeLlmProvider('not valid json');

    const { result } = await runComparison(pool, llm, {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
      providers: { hotel: [new MockHotelProvider(), new FailingHotelProvider()] },
    });

    expect(result.failedProviders).toEqual(['FailingHotelProvider']);
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it('falls back to a deterministic-only narrative when the LLM returns invalid JSON - the task still completes', async () => {
    const conversationId = await createConversation(pool);
    const llm = new FakeLlmProvider('this is not json');

    const { result } = await runComparison(pool, llm, {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).toMatch(/Found \d+ hotel offer\(s\)/);
  });

  it('falls back to a deterministic-only narrative when the LLM cites a fabricated offerId - never surfaces the fabricated citation', async () => {
    const conversationId = await createConversation(pool);
    const llm = new FakeLlmProvider(
      JSON.stringify({
        narrative: 'This mentions a hotel that does not exist.',
        highlights: [{ offerId: 'totally-fabricated-offer-id', note: 'Fabricated.' }],
      }),
    );

    const { result } = await runComparison(pool, llm, {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).not.toMatch(/does not exist/);
    expect(result.narrative).toMatch(/Found \d+ hotel offer\(s\)/);
  });
});

class FailingFlightProvider implements FlightProvider {
  readonly providerName = 'FailingFlightProvider';
  async search(_criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    throw new Error('simulated outage');
  }
}

describe('runComparison - multi-domain (Phase 5)', () => {
  it('flight only', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    expect(result.domains).toEqual(['flight']);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((o) => o.domain === 'flight')).toBe(true);
    expect(result.comparison).toHaveLength(1);
    expect(result.comparison[0].domain).toBe('flight');
  });

  it('train only', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['train'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    expect(result.domains).toEqual(['train']);
    expect(result.offers.every((o) => o.domain === 'train')).toBe(true);
  });

  it('bus only', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['bus'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    expect(result.domains).toEqual(['bus']);
    expect(result.offers.every((o) => o.domain === 'bus')).toBe(true);
  });

  it('hotel + flight - both domains run independently and both appear in the merged, domain-grouped offer list', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel', 'flight'],
      location: 'Karol Bagh',
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });

    expect(result.domains).toEqual(['hotel', 'flight']);
    expect(result.comparison.map((c) => c.domain)).toEqual(['hotel', 'flight']);

    const hotelOffers = result.offers.filter((o) => o.domain === 'hotel');
    const flightOffers = result.offers.filter((o) => o.domain === 'flight');
    expect(hotelOffers.length).toBeGreaterThan(0);
    expect(flightOffers.length).toBeGreaterThan(0);

    // Domain-grouped ordering: every hotel offer appears before every flight offer (requested order).
    const firstFlightIndex = result.offers.findIndex((o) => o.domain === 'flight');
    const lastHotelIndex = result.offers.map((o) => o.domain).lastIndexOf('hotel');
    expect(lastHotelIndex).toBeLessThan(firstFlightIndex);
  });

  it('flight + train', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight', 'train'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    expect(result.domains).toEqual(['flight', 'train']);
    expect(result.offers.some((o) => o.domain === 'flight')).toBe(true);
    expect(result.offers.some((o) => o.domain === 'train')).toBe(true);
  });

  it('hotel + flight + train + bus - all four domains in one request', async () => {
    const conversationId = await createConversation(pool);
    const { taskId, result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel', 'flight', 'train', 'bus'],
      location: 'Karol Bagh',
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });

    expect(result.domains).toEqual(['hotel', 'flight', 'train', 'bus']);
    expect(result.comparison).toHaveLength(4);
    for (const domain of ['hotel', 'flight', 'train', 'bus'] as const) {
      expect(result.offers.some((o) => o.domain === domain)).toBe(true);
    }

    // Persisted exactly as returned (mixed-domain ordering survives round-trip).
    const task = await getTask(pool, taskId);
    expect((task!.result as { offers: unknown[] }).offers).toEqual(result.offers);
  });

  it('a failure in one domain\'s provider path does not discard another domain\'s successful results', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel', 'flight'],
      location: 'Karol Bagh',
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
      providers: { flight: [new MockFlightProvider(), new FailingFlightProvider()] },
    });

    expect(result.failedProviders).toEqual(['FailingFlightProvider']);
    expect(result.offers.some((o) => o.domain === 'hotel')).toBe(true);
    expect(result.offers.some((o) => o.domain === 'flight')).toBe(true);
  });

  it('rejects a hotel comparison missing its required location before any task is created', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      runComparison(pool, new FakeLlmProvider('{}'), { domains: ['hotel'], conversationId }),
    ).rejects.toThrow(/requires a location/);
  });

  it('rejects a transport comparison missing origin/destination before any task is created', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      runComparison(pool, new FakeLlmProvider('{}'), { domains: ['flight'], conversationId }),
    ).rejects.toThrow(/requires an origin and a destination/);
  });

  it('every persisted offer has a stable offerId matching the source provider\'s own id', async () => {
    const conversationId = await createConversation(pool);
    const flightProvider = new MockFlightProvider();
    const sourceOffers = await flightProvider.search({ origin: 'Pune', destination: 'Delhi' });

    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });

    const sourceIds = new Set(sourceOffers.map((o) => o.offerId));
    for (const offer of result.offers) {
      expect(sourceIds.has(offer.offerId)).toBe(true);
    }
  });

  it('deterministic transport narration fallback names the transport domain, not "hotel"', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not valid json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).toMatch(/Found \d+ flight offer\(s\)/);
  });
});

describe('searchHotelOffersOnly (Phase 9 search-only capability)', () => {
  it('returns normalized, ranked offers with a deterministic cheapest selection, never invoking an LLM', async () => {
    const provider = new MockHotelProvider();
    const rawOffers = await provider.search({ location: 'Karol Bagh' });

    const result = await searchHotelOffersOnly({ location: 'Karol Bagh' }, [provider]);

    expect(result.offers.length).toBe(rawOffers.length);
    expect(result.cheapestOfferId).toBeTruthy();
    const cheapest = result.offers.find((o) => o.offerId === result.cheapestOfferId)!;
    expect(Math.min(...result.offers.filter((o) => o.availability).map((o) => o.price))).toBe(cheapest.price);
  });

  it('never persists a comparison task - the conversation has none after calling it', async () => {
    const conversationId = await createConversation(pool);
    await searchHotelOffersOnly({ location: 'Karol Bagh' }, [new MockHotelProvider()]);

    const latest = await getLatestTaskForConversation(pool, conversationId, 'comparison');
    expect(latest).toBeNull();
  });

  it('isolates a provider failure - a failing provider never breaks the search, and its offers are simply absent', async () => {
    const result = await searchHotelOffersOnly({ location: 'Karol Bagh' }, [
      new MockHotelProvider(),
      new FailingHotelProvider(),
    ]);

    expect(result.failedProviders).toContain('FailingHotelProvider');
    expect(result.offers.every((o) => o.provider !== 'FailingHotelProvider')).toBe(true);
  });

  it('strips the raw provider payload from every returned offer', async () => {
    const result = await searchHotelOffersOnly({ location: 'Karol Bagh' }, [new MockHotelProvider()]);
    expect(result.offers.every((o) => !('raw' in o))).toBe(true);
  });
});
