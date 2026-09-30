import { describe, expect, it } from 'vitest';
import { compareTransportOffers } from '../src/transport/compare-transport';
import type { NormalizedTransportOffer } from '../src/providers/transport-provider';

function makeOffer(overrides: Partial<NormalizedTransportOffer> = {}): NormalizedTransportOffer {
  return {
    provider: 'TestProvider',
    domain: 'flight',
    offerId: 'offer-default',
    vehicleNumber: 'TT-1',
    operatorName: 'Test Operator',
    origin: 'Pune',
    destination: 'Delhi',
    price: 5000,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T06:00:00.000Z',
    arrival: '2026-12-01T08:00:00.000Z',
    durationMinutes: 120,
    sourceUrl: 'https://example.test/offer-default',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    raw: {},
    ...overrides,
  };
}

describe('compareTransportOffers', () => {
  it('handles an empty offer list', () => {
    const result = compareTransportOffers([]);
    expect(result).toEqual({
      offers: [],
      cheapestOfferId: null,
      mostExpensiveOfferId: null,
      shortestDurationOfferId: null,
      longestDurationOfferId: null,
      availableCount: 0,
      unavailableCount: 0,
      providerGroups: {},
    });
  });

  it('handles a single offer - it is cheapest, most expensive, shortest and longest, with a zero delta', () => {
    const result = compareTransportOffers([makeOffer({ offerId: 'solo' })]);
    expect(result.cheapestOfferId).toBe('solo');
    expect(result.mostExpensiveOfferId).toBe('solo');
    expect(result.shortestDurationOfferId).toBe('solo');
    expect(result.longestDurationOfferId).toBe('solo');
    expect(result.offers[0].priceDeltaFromCheapest).toBe(0);
  });

  it('orders multiple offers ascending by price and computes correct deltas', () => {
    const a = makeOffer({ offerId: 'a', price: 5000 });
    const b = makeOffer({ offerId: 'b', price: 4200 });
    const c = makeOffer({ offerId: 'c', price: 6500 });

    const result = compareTransportOffers([a, b, c]);
    expect(result.offers.map((o) => o.offerId)).toEqual(['b', 'a', 'c']);
    expect(result.cheapestOfferId).toBe('b');
    expect(result.mostExpensiveOfferId).toBe('c');

    const byId = new Map(result.offers.map((o) => [o.offerId, o]));
    expect(byId.get('b')!.priceDeltaFromCheapest).toBe(0);
    expect(byId.get('a')!.priceDeltaFromCheapest).toBe(800);
    expect(byId.get('c')!.priceDeltaFromCheapest).toBe(2300);
  });

  it('identifies the shortest and longest duration among available offers', () => {
    const fast = makeOffer({ offerId: 'fast', durationMinutes: 90 });
    const slow = makeOffer({ offerId: 'slow', durationMinutes: 300 });
    const medium = makeOffer({ offerId: 'medium', durationMinutes: 180 });

    const result = compareTransportOffers([slow, fast, medium]);
    expect(result.shortestDurationOfferId).toBe('fast');
    expect(result.longestDurationOfferId).toBe('slow');
  });

  it('excludes unavailable offers from cheapest/most-expensive/duration extremes, but still lists and counts them', () => {
    const cheapButSoldOut = makeOffer({ offerId: 'sold-out', price: 100, durationMinutes: 10, availability: false });
    const availableA = makeOffer({ offerId: 'available-a', price: 5000, durationMinutes: 120, availability: true });
    const availableB = makeOffer({ offerId: 'available-b', price: 6000, durationMinutes: 240, availability: true });

    const result = compareTransportOffers([cheapButSoldOut, availableA, availableB]);

    expect(result.cheapestOfferId).toBe('available-a');
    expect(result.mostExpensiveOfferId).toBe('available-b');
    expect(result.shortestDurationOfferId).toBe('available-a');
    expect(result.longestDurationOfferId).toBe('available-b');
    expect(result.availableCount).toBe(2);
    expect(result.unavailableCount).toBe(1);
    expect(result.offers.map((o) => o.offerId)).toContain('sold-out');
  });

  it('returns null extremes when every offer is unavailable', () => {
    const result = compareTransportOffers([
      makeOffer({ offerId: 'x', availability: false }),
      makeOffer({ offerId: 'y', availability: false }),
    ]);
    expect(result.cheapestOfferId).toBeNull();
    expect(result.mostExpensiveOfferId).toBeNull();
    expect(result.shortestDurationOfferId).toBeNull();
    expect(result.longestDurationOfferId).toBeNull();
    expect(result.offers.every((o) => o.priceDeltaFromCheapest === null)).toBe(true);
  });

  it('leaves the price delta null when an offer is quoted in a different currency than the cheapest', () => {
    const cheapestInr = makeOffer({ offerId: 'inr-cheap', price: 4000, currency: 'INR' });
    const usdOffer = makeOffer({ offerId: 'usd-offer', price: 50, currency: 'USD' });

    const result = compareTransportOffers([cheapestInr, usdOffer]);
    const byId = new Map(result.offers.map((o) => [o.offerId, o]));
    expect(result.cheapestOfferId).toBe('usd-offer');
    expect(byId.get('inr-cheap')!.priceDeltaFromCheapest).toBeNull();
  });

  it('breaks price ties by preserving input order (stable sort)', () => {
    const a = makeOffer({ offerId: 'first-in', price: 5000 });
    const b = makeOffer({ offerId: 'second-in', price: 5000 });
    const result = compareTransportOffers([a, b]);
    expect(result.offers.map((o) => o.offerId)).toEqual(['first-in', 'second-in']);
    expect(result.cheapestOfferId).toBe('first-in');
  });

  it('groups offers by provider, in the same relative order as the main list', () => {
    const a = makeOffer({ offerId: 'a', provider: 'ProviderX', price: 5000 });
    const b = makeOffer({ offerId: 'b', provider: 'ProviderY', price: 4000 });
    const c = makeOffer({ offerId: 'c', provider: 'ProviderX', price: 6000 });
    const result = compareTransportOffers([a, b, c]);
    expect(result.providerGroups).toEqual({ ProviderY: ['b'], ProviderX: ['a', 'c'] });
  });
});
