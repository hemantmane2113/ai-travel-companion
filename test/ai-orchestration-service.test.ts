import { describe, expect, it } from 'vitest';
import { AiOrchestrationService } from '../src/ai/ai-orchestration-service';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { CandidateSet } from '../src/travel-intelligence/candidate-set';

const RED_FORT_FACT_VERSION = 'fv-1';
const KARIMS_FACT_VERSION = 'fv-2';
const VISA_WARNING_FACT_VERSION = 'fv-warning-1';

function makeCandidateSet(): CandidateSet {
  return {
    destination: 'delhi',
    attractions: [
      {
        placeId: 'place-red-fort',
        factVersionId: RED_FORT_FACT_VERSION,
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
        factVersionId: KARIMS_FACT_VERSION,
        name: "Karim's",
        category: 'restaurant',
        latitude: 28.65,
        longitude: 77.235,
        distanceFromCenterKm: 3.9,
      },
    ],
    shops: [],
    warnings: [
      {
        factVersionId: VISA_WARNING_FACT_VERSION,
        text: 'A visa or e-Visa is required for most foreign nationals.',
        confidence: 0.5,
        source: { name: 'Manually curated Phase 1 seed content', url: null, licence: null },
      },
    ],
  };
}

function oneDayContext(overrides: Partial<{ numberOfDays: number }> = {}) {
  return { destination: 'delhi', interests: ['history', 'food'], numberOfDays: 1, ...overrides };
}

describe('AiOrchestrationService.generateItinerary', () => {
  it('returns a grounded plan when a place item cites its own fact_version', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day of history and food in central Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History and food.',
            items: [
              {
                itemType: 'place',
                placeId: 'place-red-fort',
                reason: 'Great for history buffs.',
                factReferences: [RED_FORT_FACT_VERSION],
              },
              {
                itemType: 'place',
                placeId: 'place-karims',
                reason: 'Classic Old Delhi food.',
                factReferences: [KARIMS_FACT_VERSION],
              },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days).toHaveLength(1);
    expect(result.itinerary.days[0].items).toHaveLength(2);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('accepts a warning item whose factReference is a real supplied warning fact_version', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'Before you go.',
            items: [
              {
                itemType: 'warning',
                reason: 'Check your visa requirements before travelling.',
                factReferences: [VISA_WARNING_FACT_VERSION],
              },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days[0].items).toEqual([
      {
        itemType: 'warning',
        reason: 'Check your visa requirements before travelling.',
        factReferences: [VISA_WARNING_FACT_VERSION],
      },
    ]);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('rejects a real place referencing a fabricated fact_version id (P0-3 regression)', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              {
                itemType: 'place',
                placeId: 'place-red-fort', // real placeId, real candidate
                reason: 'Invented grounding.',
                factReferences: ['fv-does-not-exist'], // fabricated fact_version
              },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days[0].items).toHaveLength(0);
    expect(result.rejectedItems).toHaveLength(1);
    expect(result.rejectedItems[0].factReferences).toEqual(['fv-does-not-exist']);
  });

  it('succeeds when a real place cites its own real supplied fact_version (P0-3 pairing test)', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              {
                itemType: 'place',
                placeId: 'place-red-fort',
                reason: 'A must-see fort.',
                factReferences: [RED_FORT_FACT_VERSION],
              },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days[0].items).toEqual([
      {
        itemType: 'place',
        placeId: 'place-red-fort',
        reason: 'A must-see fort.',
        factReferences: [RED_FORT_FACT_VERSION],
      },
    ]);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('rejects a place item that cites a real but unrelated fact_version instead of its own', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              {
                itemType: 'place',
                placeId: 'place-red-fort',
                reason: 'Cites the visa warning instead of its own fact - must be rejected.',
                factReferences: [VISA_WARNING_FACT_VERSION], // real id, but not Red Fort's own
              },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days[0].items).toHaveLength(0);
    expect(result.rejectedItems).toHaveLength(1);
  });

  it('rejects the whole response when the day count does not match the requested trip length', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [{ dayNumber: 1, summary: 'Day one.', items: [] }],
      }),
    );
    const service = new AiOrchestrationService(provider);

    await expect(
      service.generateItinerary(makeCandidateSet(), oneDayContext({ numberOfDays: 3 })),
    ).rejects.toThrow(/contained 1 day\(s\), expected 3/);
  });

  it('throws when the model response is not valid JSON', async () => {
    const provider = new FakeLlmProvider('this is not json');
    const service = new AiOrchestrationService(provider);

    await expect(service.generateItinerary(makeCandidateSet(), oneDayContext())).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('throws when the model response does not match the expected schema', async () => {
    const provider = new FakeLlmProvider(JSON.stringify({ wrong: 'shape' }));
    const service = new AiOrchestrationService(provider);

    await expect(service.generateItinerary(makeCandidateSet(), oneDayContext())).rejects.toThrow(
      /did not match the expected schema/,
    );
  });

  it('drops a structurally malformed item without treating it as a rejected fact claim', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              {
                itemType: 'place',
                placeId: 'place-red-fort',
                reason: 'Kept.',
                factReferences: [RED_FORT_FACT_VERSION],
              },
              { not: 'a valid item' },
            ],
          },
        ],
      }),
    );
    const service = new AiOrchestrationService(provider);

    const result = await service.generateItinerary(makeCandidateSet(), oneDayContext());

    expect(result.itinerary.days[0].items).toHaveLength(1);
    expect(result.rejectedItems).toHaveLength(0);
  });
});
