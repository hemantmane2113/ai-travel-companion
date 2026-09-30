import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getCancellationPolicy } from '../src/tasks/get-cancellation-policy';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe('getCancellationPolicy', () => {
  it('returns a known, structured policy for a hotel offer already persisted by a comparison task', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });
    const hotelOffer = result.offers[0];

    const policy = await getCancellationPolicy(pool, conversationId, hotelOffer.offerId);

    expect(policy.status).toBe('known');
    expect(policy.policy).toBe((hotelOffer as { cancellationPolicy: string }).cancellationPolicy);
    expect(policy.provider).toBe(hotelOffer.provider);
    expect(policy.source).toBe('structured_offer_field');
    expect(policy.retrievedAt).toBeTruthy();
  });

  it('honestly reports unavailable for a transport offer - never fabricates a policy', async () => {
    const conversationId = await createConversation(pool);
    const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['flight'],
      origin: 'Pune',
      destination: 'Delhi',
      conversationId,
    });
    const flightOffer = result.offers[0];

    const policy = await getCancellationPolicy(pool, conversationId, flightOffer.offerId);

    expect(policy.status).toBe('unavailable');
    expect(policy.policy).toBeNull();
    expect(policy.source).toBeNull();
  });

  it('reports unavailable when the offerId does not exist in the conversation\'s comparison task', async () => {
    const conversationId = await createConversation(pool);
    await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    const policy = await getCancellationPolicy(pool, conversationId, 'totally-unknown-offer-id');
    expect(policy.status).toBe('unavailable');
    expect(policy.provider).toBeNull();
  });

  it('reports unavailable (provider/source unavailable) when the conversation has no comparison task at all', async () => {
    const conversationId = await createConversation(pool);
    const policy = await getCancellationPolicy(pool, conversationId, 'any-offer-id');
    expect(policy).toEqual({ status: 'unavailable', policy: null, provider: null, source: null, retrievedAt: null });
  });
});
