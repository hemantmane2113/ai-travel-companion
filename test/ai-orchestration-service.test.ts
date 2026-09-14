import { describe, expect, it } from 'vitest';
import { AiOrchestrationService } from '../src/ai/ai-orchestration-service';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { CandidateSet } from '../src/travel-intelligence/candidate-set';

function makeCandidateSet(): CandidateSet {
  return {
    destination: 'delhi',
    attractions: [
      {
        placeId: 'place-red-fort',
        factVersionId: 'fv-1',
        name: 'Red Fort',
        category: 'attraction',
        latitude: 28.6562,
        longitude: 77.241,
        distanceFromCenterKm: 4.2,
      },
    ],
    restaurants: [
      {
        placeId: 'place-karims',
        factVersionId: 'fv-2',
        name: "Karim's",
        category: 'restaurant',
        latitude: 28.65,
        longitude: 77.235,
        distanceFromCenterKm: 3.9,
      },
    ],
    shops: [],
  };
}

describe('AiOrchestrationService.generateDayPlan', () => {
  it('returns a grounded plan when every referenced placeId is in the candidate set', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day of history and food in central Delhi.',
        items: [
          { placeId: 'place-red-fort', note: 'Great for history buffs.' },
          { placeId: 'place-karims', note: 'Classic Old Delhi food.' },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateDayPlan(makeCandidateSet(), {
      destination: 'delhi',
      interests: ['history', 'food'],
    });

    expect(result.plan.items).toHaveLength(2);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('strips a fabricated placeId instead of trusting the model - the trust boundary\'s only hallucination guard (plan §7)', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        items: [
          { placeId: 'place-red-fort', note: 'Real place, kept.' },
          { placeId: 'place-does-not-exist', note: 'Invented by the model - must be rejected.' },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateDayPlan(makeCandidateSet(), {
      destination: 'delhi',
      interests: [],
    });

    expect(result.plan.items).toEqual([{ placeId: 'place-red-fort', note: 'Real place, kept.' }]);
    expect(result.rejectedItems).toEqual([
      { placeId: 'place-does-not-exist', note: 'Invented by the model - must be rejected.' },
    ]);
  });

  it('throws when the model response is not valid JSON', async () => {
    const provider = new FakeLlmProvider('this is not json');
    const service = new AiOrchestrationService(provider);

    await expect(
      service.generateDayPlan(makeCandidateSet(), { destination: 'delhi', interests: [] }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the model response does not match the expected schema', async () => {
    const provider = new FakeLlmProvider(JSON.stringify({ wrong: 'shape' }));
    const service = new AiOrchestrationService(provider);

    await expect(
      service.generateDayPlan(makeCandidateSet(), { destination: 'delhi', interests: [] }),
    ).rejects.toThrow(/did not match the expected schema/);
  });

  it('drops a structurally malformed item without treating it as a rejected fact claim', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        items: [{ placeId: 'place-red-fort', note: 'Kept.' }, { not: 'a valid item' }],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateDayPlan(makeCandidateSet(), {
      destination: 'delhi',
      interests: [],
    });

    expect(result.plan.items).toEqual([{ placeId: 'place-red-fort', note: 'Kept.' }]);
    expect(result.rejectedItems).toHaveLength(0);
  });
});
