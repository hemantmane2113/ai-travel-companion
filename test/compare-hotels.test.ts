import { describe, expect, it } from 'vitest';
import { compareHotelOffers } from '../src/hotels/compare-hotels';
import type { NormalizedHotelOffer } from '../src/providers/hotel-provider';

function makeOffer(overrides: Partial<NormalizedHotelOffer> = {}): NormalizedHotelOffer {
  return {
    provider: 'TestProvider',
    domain: 'hotel',
    offerId: 'offer-default',
    name: 'Default Hotel',
    location: { name: 'Somewhere', latitude: 0, longitude: 0 },
    price: 5000,
    currency: 'INR',
    cancellationPolicy: 'Free cancellation',
    rating: 4.0,
    availability: true,
    sourceUrl: 'https://example.test/offer-default',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    raw: {},
    ...overrides,
  };
}

describe('compareHotelOffers', () => {
  it('handles an empty offer list', () => {
    const result = compareHotelOffers([]);
    expect(result).toEqual({
      offers: [],
      cheapestOfferId: null,
      mostExpensiveOfferId: null,
      availableCount: 0,
      unavailableCount: 0,
      providerGroups: {},
    });
  });

  it('handles a single offer - it is both cheapest and most expensive, with a zero delta', () => {
    const offer = makeOffer({ offerId: 'solo', price: 4500 });
    const result = compareHotelOffers([offer]);

    expect(result.cheapestOfferId).toBe('solo');
    expect(result.mostExpensiveOfferId).toBe('solo');
    expect(result.offers[0].priceDeltaFromCheapest).toBe(0);
    expect(result.availableCount).toBe(1);
    expect(result.unavailableCount).toBe(0);
  });

  it('orders multiple offers ascending by price and computes correct deltas', () => {
    const a = makeOffer({ offerId: 'a', price: 5000 });
    const b = makeOffer({ offerId: 'b', price: 4200 });
    const c = makeOffer({ offerId: 'c', price: 6500 });

    const result = compareHotelOffers([a, b, c]);

    expect(result.offers.map((o) => o.offerId)).toEqual(['b', 'a', 'c']);
    expect(result.cheapestOfferId).toBe('b');
    expect(result.mostExpensiveOfferId).toBe('c');

    const byId = new Map(result.offers.map((o) => [o.offerId, o]));
    expect(byId.get('b')!.priceDeltaFromCheapest).toBe(0);
    expect(byId.get('a')!.priceDeltaFromCheapest).toBe(800); // 5000 - 4200
    expect(byId.get('c')!.priceDeltaFromCheapest).toBe(2300); // 6500 - 4200
  });

  it('breaks ties on equal prices by preserving input order (stable sort)', () => {
    const a = makeOffer({ offerId: 'first-in', price: 5000 });
    const b = makeOffer({ offerId: 'second-in', price: 5000 });

    const result = compareHotelOffers([a, b]);

    expect(result.offers.map((o) => o.offerId)).toEqual(['first-in', 'second-in']);
    expect(result.offers[0].priceDeltaFromCheapest).toBe(0);
    expect(result.offers[1].priceDeltaFromCheapest).toBe(0);
    // Ties for cheapest resolve to whichever comes first after the stable sort.
    expect(result.cheapestOfferId).toBe('first-in');
  });

  it('excludes unavailable offers from cheapest/most-expensive, but still lists and counts them', () => {
    const cheapButSoldOut = makeOffer({ offerId: 'sold-out', price: 1000, availability: false });
    const availableA = makeOffer({ offerId: 'available-a', price: 5000, availability: true });
    const availableB = makeOffer({ offerId: 'available-b', price: 6000, availability: true });

    const result = compareHotelOffers([cheapButSoldOut, availableA, availableB]);

    expect(result.cheapestOfferId).toBe('available-a');
    expect(result.mostExpensiveOfferId).toBe('available-b');
    expect(result.availableCount).toBe(2);
    expect(result.unavailableCount).toBe(1);
    // The sold-out offer is still present in the ordered list.
    expect(result.offers.map((o) => o.offerId)).toContain('sold-out');
  });

  it('returns null cheapest/most-expensive when every offer is unavailable', () => {
    const result = compareHotelOffers([
      makeOffer({ offerId: 'x', availability: false }),
      makeOffer({ offerId: 'y', availability: false }),
    ]);

    expect(result.cheapestOfferId).toBeNull();
    expect(result.mostExpensiveOfferId).toBeNull();
    expect(result.availableCount).toBe(0);
    expect(result.unavailableCount).toBe(2);
    expect(result.offers.every((o) => o.priceDeltaFromCheapest === null)).toBe(true);
  });

  it('leaves the price delta null when an offer is quoted in a different currency than the cheapest', () => {
    const cheapestInr = makeOffer({ offerId: 'inr-cheap', price: 4000, currency: 'INR' });
    const usdOffer = makeOffer({ offerId: 'usd-offer', price: 50, currency: 'USD' });

    const result = compareHotelOffers([cheapestInr, usdOffer]);
    const byId = new Map(result.offers.map((o) => [o.offerId, o]));

    expect(result.cheapestOfferId).toBe('usd-offer'); // 50 < 4000 numerically - ordering is purely numeric, not currency-aware
    expect(byId.get('inr-cheap')!.priceDeltaFromCheapest).toBeNull();
  });

  it('groups offers by provider, in the same relative order as the main list', () => {
    const a = makeOffer({ offerId: 'a', provider: 'ProviderX', price: 5000 });
    const b = makeOffer({ offerId: 'b', provider: 'ProviderY', price: 4000 });
    const c = makeOffer({ offerId: 'c', provider: 'ProviderX', price: 6000 });

    const result = compareHotelOffers([a, b, c]);

    expect(result.providerGroups).toEqual({
      ProviderY: ['b'],
      ProviderX: ['a', 'c'],
    });
  });
});
