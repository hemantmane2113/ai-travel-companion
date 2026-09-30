import { describe, expect, it } from 'vitest';
import { MockHotelProvider } from '../src/providers/mock-hotel-provider';

describe('MockHotelProvider', () => {
  it('returns deterministic, already-normalized offers with real differences across fields', async () => {
    const provider = new MockHotelProvider();
    const offers = await provider.search({ location: 'Karol Bagh' });

    expect(offers.length).toBeGreaterThanOrEqual(3);

    const prices = new Set(offers.map((o) => o.price));
    const ratings = new Set(offers.map((o) => o.rating));
    const cancellationPolicies = new Set(offers.map((o) => o.cancellationPolicy));
    const availabilities = new Set(offers.map((o) => o.availability));
    const providers = new Set(offers.map((o) => o.provider));
    const currencies = new Set(offers.map((o) => o.currency));

    // Deliberately varied fixture data (Phase 4 spec) - every one of
    // these fields differs across at least two offers.
    expect(prices.size).toBeGreaterThan(1);
    expect(ratings.size).toBeGreaterThan(1);
    expect(cancellationPolicies.size).toBeGreaterThan(1);
    expect(availabilities.size).toBe(2); // both true and false present
    expect(providers.size).toBeGreaterThan(1);
    expect(currencies.size).toBeGreaterThan(1);

    for (const offer of offers) {
      expect(offer.domain).toBe('hotel');
      expect(offer.offerId).toBeTruthy();
      expect(offer.sourceUrl).toMatch(/^https:\/\//);
      expect(new Date(offer.retrievedAt).toString()).not.toBe('Invalid Date');
    }
  });

  it('returns the same offer set and field values on repeated calls (no randomness)', async () => {
    const provider = new MockHotelProvider();
    const first = await provider.search({ location: 'Karol Bagh' });
    const second = await provider.search({ location: 'Karol Bagh' });

    const strip = (offers: typeof first) =>
      offers.map(({ retrievedAt, ...rest }) => rest); // retrievedAt is genuinely time-of-call, everything else must be identical

    expect(strip(second)).toEqual(strip(first));
  });

  it('keeps provider-specific detail in `raw`, separate from the normalized fields', async () => {
    const provider = new MockHotelProvider();
    const offers = await provider.search({ location: 'Karol Bagh' });

    for (const offer of offers) {
      expect(offer.raw).toBeDefined();
      expect(typeof offer.raw).toBe('object');
      // The normalized shape never leaks provider-internal keys.
      expect(offer).not.toHaveProperty('agodaInternalId');
      expect(offer).not.toHaveProperty('mmtInternalId');
    }

    const withRaw = offers.find((o) => 'roomType' in o.raw);
    expect(withRaw).toBeDefined();
  });
});
