import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createBookingIntent, confirmBookingIntent } from '../src/booking/booking-intent';
import { runComparison } from '../src/agents/comparison-agent';
import { createConversation } from '../src/companion/conversations';
import { getTask } from '../src/tasks/tasks';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function setupComparisonWithOffer(conversationId: string) {
  const { result } = await runComparison(pool, new FakeLlmProvider('not json'), {
    domains: ['hotel'],
    location: 'Karol Bagh',
    conversationId,
  });
  return result.offers[0];
}

describe('createBookingIntent', () => {
  it('represents the selected offer as a stable fingerprint (offerId, provider, domain, price, currency, cancellation policy)', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);

    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    expect(intent.selectedOffer).toEqual({
      offerId: offer.offerId,
      provider: offer.provider,
      domain: offer.domain,
      price: offer.price,
      currency: offer.currency,
      cancellationPolicy: (offer as { cancellationPolicy?: string }).cancellationPolicy ?? null,
    });
  });

  it('represents the booking intent itself as awaiting_confirmation, never confirmed by mere creation', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);

    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    expect(intent.bookingStatus).toBe('awaiting_confirmation');
    expect(intent.executionState).toBe('not_executed');
    expect(intent.taskId).toBeTruthy();
    expect(intent.idempotencyKey).toBeTruthy();
    expect(intent.expiresAt).toBeTruthy();

    // Persisted, not just returned in-memory.
    const task = await getTask(pool, intent.taskId);
    expect(task!.taskType).toBe('booking');
    expect(task!.status).toBe('complete'); // preparation succeeded - bookingStatus (domain state) is tracked separately inside result
  });

  it('generates a stable idempotency key that never changes across reads of the same booking attempt', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);

    const intent = await createBookingIntent(pool, conversationId, offer.offerId);
    const reread = await getTask(pool, intent.taskId);

    expect((reread!.result as { idempotencyKey: string }).idempotencyKey).toBe(intent.idempotencyKey);
  });

  it('rejects an offerId that is not in the conversation\'s latest comparison result, rather than guessing', async () => {
    const conversationId = await createConversation(pool);
    await setupComparisonWithOffer(conversationId);

    await expect(createBookingIntent(pool, conversationId, 'totally-unknown-offer-id')).rejects.toThrow(
      /can't find offer/,
    );
  });

  it('rejects booking-intent creation when the conversation has no completed comparison at all', async () => {
    const conversationId = await createConversation(pool);
    await expect(createBookingIntent(pool, conversationId, 'any-offer-id')).rejects.toThrow(
      /don't have a completed comparison/,
    );
  });
});

describe('confirmBookingIntent (the confirmation boundary)', () => {
  it('transitions bookingStatus to confirmed only when given the exact taskId, and never touches executionState', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);
    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    const confirmed = await confirmBookingIntent(pool, conversationId, intent.taskId);

    expect(confirmed.bookingStatus).toBe('confirmed');
    expect(confirmed.executionState).toBe('not_executed'); // no real provider write exists in this phase
    expect(confirmed.idempotencyKey).toBe(intent.idempotencyKey); // unchanged by confirmation
  });

  it('is idempotent - confirming an already-confirmed intent again returns the same state rather than erroring or re-transitioning', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);
    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    const first = await confirmBookingIntent(pool, conversationId, intent.taskId);
    const second = await confirmBookingIntent(pool, conversationId, intent.taskId);

    expect(second).toEqual(first);
  });

  it('rejects confirmation against a conversation that does not own this booking task - never inferred, never guessed', async () => {
    const conversationId = await createConversation(pool);
    const otherConversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);
    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    await expect(confirmBookingIntent(pool, otherConversationId, intent.taskId)).rejects.toThrow(
      /Unknown booking to confirm/,
    );
  });

  it('rejects confirmation of an unknown/non-existent taskId', async () => {
    const conversationId = await createConversation(pool);
    await expect(
      confirmBookingIntent(pool, conversationId, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/Unknown booking to confirm/);
  });

  it('rejects confirmation of a comparison task id passed as if it were a booking task - task_type is checked', async () => {
    const conversationId = await createConversation(pool);
    const { taskId: comparisonTaskId } = await runComparison(pool, new FakeLlmProvider('not json'), {
      domains: ['hotel'],
      location: 'Karol Bagh',
      conversationId,
    });

    await expect(confirmBookingIntent(pool, conversationId, comparisonTaskId)).rejects.toThrow(
      /Unknown booking to confirm/,
    );
  });

  it('rejects confirmation of an expired booking intent, forcing a fresh comparison rather than confirming a stale price', async () => {
    const conversationId = await createConversation(pool);
    const offer = await setupComparisonWithOffer(conversationId);
    const intent = await createBookingIntent(pool, conversationId, offer.offerId);

    // Simulate expiry directly - no need to wait out the real TTL.
    await pool.query(
      `update tasks set result = jsonb_set(result, '{expiresAt}', '"2000-01-01T00:00:00.000Z"') where id = $1`,
      [intent.taskId],
    );

    await expect(confirmBookingIntent(pool, conversationId, intent.taskId)).rejects.toThrow(/expired/);
  });
});
