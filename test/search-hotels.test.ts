import { describe, expect, it } from 'vitest';
import { searchHotels } from '../src/hotels/search-hotels';
import { MockHotelProvider } from '../src/providers/mock-hotel-provider';
import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../src/providers/hotel-provider';

class FailingHotelProvider implements HotelProvider {
  readonly providerName = 'FailingHotelProvider';
  async search(_criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]> {
    throw new Error('simulated provider outage');
  }
}

class SecondFixtureProvider implements HotelProvider {
  readonly providerName = 'SecondFixtureProvider';
  async search(criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]> {
    return [
      {
        provider: 'SecondFixtureProvider',
        domain: 'hotel',
        offerId: 'second-fixture-1',
        name: 'Second Fixture Hotel',
        location: { name: criteria.location, latitude: 0, longitude: 0 },
        price: 3000,
        currency: 'INR',
        cancellationPolicy: 'Free cancellation',
        rating: 4.0,
        availability: true,
        sourceUrl: 'https://second-fixture.example/hotel-1',
        retrievedAt: new Date().toISOString(),
        raw: {},
      },
    ];
  }
}

describe('searchHotels', () => {
  it('merges offers from multiple providers', async () => {
    const result = await searchHotels([new MockHotelProvider(), new SecondFixtureProvider()], {
      location: 'Karol Bagh',
    });

    expect(result.failedProviders).toEqual([]);
    expect(result.offers.some((o) => o.provider === 'MockAgoda')).toBe(true);
    expect(result.offers.some((o) => o.provider === 'MockMakeMyTrip')).toBe(true);
    expect(result.offers.some((o) => o.provider === 'SecondFixtureProvider')).toBe(true);
  });

  it('isolates a failing provider - the other provider still returns its offers', async () => {
    const result = await searchHotels([new MockHotelProvider(), new FailingHotelProvider()], {
      location: 'Karol Bagh',
    });

    expect(result.failedProviders).toEqual(['FailingHotelProvider']);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((o) => o.provider !== 'FailingHotelProvider')).toBe(true);
  });

  it('returns empty offers and every provider name failed when all providers fail', async () => {
    const result = await searchHotels([new FailingHotelProvider(), new FailingHotelProvider()], {
      location: 'Karol Bagh',
    });

    expect(result.offers).toEqual([]);
    expect(result.failedProviders).toEqual(['FailingHotelProvider', 'FailingHotelProvider']);
  });

  it('returns empty results for an empty provider list, without throwing', async () => {
    const result = await searchHotels([], { location: 'Karol Bagh' });
    expect(result).toEqual({ offers: [], failedProviders: [] });
  });
});
