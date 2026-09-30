import { describe, expect, it } from 'vitest';
import { narrateComparison, type ComparisonNarrationInput } from '../src/ai/comparison-narration';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';

const HOTEL_INPUT: ComparisonNarrationInput = {
  offers: [
    { offerId: 'h1', domain: 'hotel', provider: 'MockAgoda', label: 'Hotel Clarks', price: 5000, currency: 'INR', availability: true, priceDeltaFromCheapest: 0 },
    { offerId: 'h2', domain: 'hotel', provider: 'MockMakeMyTrip', label: 'Grand Palace', price: 6500, currency: 'INR', availability: true, priceDeltaFromCheapest: 1500 },
  ],
  domainSummaries: [{ domain: 'hotel', cheapestOfferId: 'h1', mostExpensiveOfferId: 'h2', availableCount: 2, unavailableCount: 0 }],
};

describe('narrateComparison', () => {
  it('accepts valid cited offer IDs and returns the LLM narrative as-is', async () => {
    const llm = new FakeLlmProvider(
      JSON.stringify({
        narrative: 'Hotel Clarks is the cheaper of the two options.',
        highlights: [{ offerId: 'h1', note: 'Cheapest.' }, { offerId: 'h2', note: 'More expensive.' }],
      }),
    );

    const result = await narrateComparison(llm, HOTEL_INPUT);
    expect(result.fellBackToDeterministic).toBe(false);
    expect(result.narrative).toBe('Hotel Clarks is the cheaper of the two options.');
  });

  it('falls back to deterministic output when a highlight cites a fabricated offer ID', async () => {
    const llm = new FakeLlmProvider(
      JSON.stringify({
        narrative: 'This narrative mentions a hotel that does not exist.',
        highlights: [{ offerId: 'fabricated-id', note: 'Does not exist.' }],
      }),
    );

    const result = await narrateComparison(llm, HOTEL_INPUT);
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).not.toMatch(/does not exist/);
    expect(result.narrative).toMatch(/Found 2 hotel offer\(s\)/);
  });

  it('falls back to deterministic output when the LLM returns invalid JSON', async () => {
    const llm = new FakeLlmProvider('this is not json at all');
    const result = await narrateComparison(llm, HOTEL_INPUT);
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).toMatch(/Found 2 hotel offer\(s\)/);
  });

  it('falls back to deterministic output when the LLM response does not match the expected schema', async () => {
    const llm = new FakeLlmProvider(JSON.stringify({ somethingElse: true }));
    const result = await narrateComparison(llm, HOTEL_INPUT);
    expect(result.fellBackToDeterministic).toBe(true);
  });

  it('returns a deterministic "no offers" summary without calling the LLM at all when there are no offers', async () => {
    const llm = new FakeLlmProvider('THIS MUST NEVER BE CALLED');
    const result = await narrateComparison(llm, { offers: [], domainSummaries: [] });
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).toBe('No offers were found for this search.');
  });

  it('summarizes multiple domains in one deterministic fallback, naming each domain', async () => {
    const mixedInput: ComparisonNarrationInput = {
      offers: [
        ...HOTEL_INPUT.offers,
        { offerId: 'f1', domain: 'flight', provider: 'MockIndiGo', label: 'IndiGo 6E-204', price: 4500, currency: 'INR', availability: true, priceDeltaFromCheapest: 0 },
      ],
      domainSummaries: [
        ...HOTEL_INPUT.domainSummaries,
        { domain: 'flight', cheapestOfferId: 'f1', mostExpensiveOfferId: 'f1', availableCount: 1, unavailableCount: 0 },
      ],
    };
    const llm = new FakeLlmProvider('invalid json triggers fallback');
    const result = await narrateComparison(llm, mixedInput);
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.narrative).toMatch(/Found 2 hotel offer\(s\)/);
    expect(result.narrative).toMatch(/Found 1 flight offer\(s\)/);
  });
});
