import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { getTask } from '../src/tasks/tasks';
import { MockHotelProvider } from '../src/providers/mock-hotel-provider';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../src/providers/hotel-provider';

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
        // @ts-expect-error - deliberately passing an unsupported domain to prove the runtime guard, not just the type system
        domains: ['flight'],
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
      providers: [new MockHotelProvider(), new FailingHotelProvider()],
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
