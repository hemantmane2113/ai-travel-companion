import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from './hotel-provider';

interface HotelFixture {
  provider: string;
  offerId: string;
  name: string;
  price: number;
  currency: string;
  cancellationPolicy: string;
  rating: number;
  availability: boolean;
  sourceUrl: string;
  raw: Record<string, unknown>;
}

// Deterministic fixture data (Phase 4 - no real hotel API integration
// yet, per CLAUDE.md §25's mocked/sandbox/real distinction: this
// provider is explicitly MOCKED, never presented as a real booking
// source). Deliberately varied across every comparable field so
// deterministic-comparison tests have real differences to exercise -
// no randomness, so repeated runs and repeated test assertions are
// stable. One offer is quoted in a different currency (a plausible
// international-OTA-vs-domestic-OTA split) to exercise the deterministic
// comparison service's cross-currency handling (see compare-hotels.ts).
const FIXTURES: HotelFixture[] = [
  {
    provider: 'MockAgoda',
    offerId: 'mock-hotel-1',
    name: 'Hotel Clarks Karol Bagh',
    price: 5000,
    currency: 'INR',
    cancellationPolicy: 'Free cancellation until 24 hours before check-in',
    rating: 4.2,
    availability: true,
    sourceUrl: 'https://mock-agoda.example/hotels/mock-hotel-1',
    raw: { agodaInternalId: 'AG-10001', roomType: 'Deluxe Double', taxesIncluded: true },
  },
  {
    provider: 'MockAgoda',
    offerId: 'mock-hotel-2',
    name: 'The Karol Bagh Residency',
    price: 4200,
    currency: 'INR',
    cancellationPolicy: 'Non-refundable',
    rating: 3.8,
    availability: true,
    sourceUrl: 'https://mock-agoda.example/hotels/mock-hotel-2',
    raw: { agodaInternalId: 'AG-10002', roomType: 'Standard Double', taxesIncluded: false },
  },
  {
    provider: 'MockMakeMyTrip',
    offerId: 'mock-hotel-3',
    name: 'Grand Karol Palace',
    price: 6500,
    currency: 'INR',
    cancellationPolicy: 'Free cancellation until 48 hours before check-in',
    rating: 4.6,
    availability: false,
    sourceUrl: 'https://mock-makemytrip.example/hotels/mock-hotel-3',
    raw: { mmtInternalId: 'MMT-55501', roomType: 'Executive Suite', soldOut: true },
  },
  {
    provider: 'MockMakeMyTrip',
    offerId: 'mock-hotel-4',
    name: 'Karol Bagh Boutique Suites',
    price: 60,
    currency: 'USD',
    cancellationPolicy: 'Free cancellation until 72 hours before check-in',
    rating: 4.0,
    availability: true,
    sourceUrl: 'https://mock-makemytrip.example/hotels/mock-hotel-4',
    raw: { mmtInternalId: 'MMT-55502', roomType: 'Boutique Double', internationalListing: true },
  },
];

/**
 * Deterministic mock HotelProvider (Phase 4). No network call, no real
 * booking capability - proves the ComparisonAgent's pipeline without a
 * paid/live hotel API dependency (CLAUDE.md §29's ₹0-cost constraint).
 * Already returns fully normalized NormalizedHotelOffer objects, the
 * same boundary OsmOverpassAdapter draws for PlacesProvider - nothing
 * above this class ever sees the fixture shape above.
 */
export class MockHotelProvider implements HotelProvider {
  readonly providerName = 'MockHotelProvider';

  async search(_criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]> {
    const retrievedAt = new Date().toISOString();
    return FIXTURES.map((fixture) => ({
      provider: fixture.provider,
      domain: 'hotel',
      offerId: fixture.offerId,
      name: fixture.name,
      location: { name: _criteria.location, latitude: 28.6519, longitude: 77.1909 },
      price: fixture.price,
      currency: fixture.currency,
      cancellationPolicy: fixture.cancellationPolicy,
      rating: fixture.rating,
      availability: fixture.availability,
      sourceUrl: fixture.sourceUrl,
      retrievedAt,
      raw: fixture.raw,
    }));
  }
}
