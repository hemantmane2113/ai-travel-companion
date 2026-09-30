import { describe, expect, it } from 'vitest';
import { MockTrainProvider } from '../src/providers/mock-train-provider';

describe('MockTrainProvider', () => {
  it('returns deterministic, already-normalized train offers with real differences across fields', async () => {
    const provider = new MockTrainProvider();
    const offers = await provider.search({ origin: 'Pune', destination: 'Delhi' });

    expect(offers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(offers.map((o) => o.price)).size).toBeGreaterThan(1);
    expect(new Set(offers.map((o) => o.availability)).size).toBe(2);

    for (const offer of offers) {
      expect(offer.domain).toBe('train');
      expect(offer.offerId).toBeTruthy();
      expect(offer.origin).toBe('Pune');
      expect(offer.destination).toBe('Delhi');
      expect(offer.vehicleNumber).toBeTruthy();
      expect(offer.operatorName).toBeTruthy();
      expect(offer.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('keeps provider-specific detail in `raw`, separate from the normalized fields', async () => {
    const provider = new MockTrainProvider();
    const offers = await provider.search({ origin: 'Pune', destination: 'Delhi' });
    for (const offer of offers) {
      expect(typeof offer.raw).toBe('object');
      expect(offer).not.toHaveProperty('trainClass');
    }
  });

  it('returns the same offer set and field values on repeated calls (no randomness)', async () => {
    const provider = new MockTrainProvider();
    const strip = (offers: Awaited<ReturnType<typeof provider.search>>) =>
      offers.map(({ retrievedAt, ...rest }) => rest);
    const first = await provider.search({ origin: 'Pune', destination: 'Delhi' });
    const second = await provider.search({ origin: 'Pune', destination: 'Delhi' });
    expect(strip(second)).toEqual(strip(first));
  });
});
