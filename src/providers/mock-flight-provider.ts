import type { FlightProvider, NormalizedTransportOffer, TransportSearchCriteria } from './transport-provider';

interface FlightFixture {
  provider: string;
  offerId: string;
  vehicleNumber: string;
  operatorName: string;
  price: number;
  currency: string;
  availability: boolean;
  departure: string;
  arrival: string;
  durationMinutes: number;
  sourceUrl: string;
  raw: Record<string, unknown>;
}

// Deterministic fixture data (Phase 5 - no real flight API integration,
// same mocked/sandbox/real distinction CLAUDE.md §25 requires be kept
// explicit). Deliberately varied price/availability/duration/operator
// so comparison tests have real differences to exercise.
const FIXTURES: FlightFixture[] = [
  {
    provider: 'MockIndiGo',
    offerId: 'mock-flight-1',
    vehicleNumber: '6E-204',
    operatorName: 'IndiGo',
    price: 4500,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T06:00:00.000Z',
    arrival: '2026-12-01T08:10:00.000Z',
    durationMinutes: 130,
    sourceUrl: 'https://mock-indigo.example/flights/mock-flight-1',
    raw: { fareClass: 'Economy', pnrPrefix: '6E' },
  },
  {
    provider: 'MockAirIndia',
    offerId: 'mock-flight-2',
    vehicleNumber: 'AI-865',
    operatorName: 'Air India',
    price: 6200,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T09:30:00.000Z',
    arrival: '2026-12-01T11:45:00.000Z',
    durationMinutes: 135,
    sourceUrl: 'https://mock-airindia.example/flights/mock-flight-2',
    raw: { fareClass: 'Economy', pnrPrefix: 'AI' },
  },
  {
    provider: 'MockAirIndia',
    offerId: 'mock-flight-3',
    vehicleNumber: 'AI-401',
    operatorName: 'Air India',
    price: 3900,
    currency: 'INR',
    availability: false,
    departure: '2026-12-01T14:00:00.000Z',
    arrival: '2026-12-01T16:05:00.000Z',
    durationMinutes: 125,
    sourceUrl: 'https://mock-airindia.example/flights/mock-flight-3',
    raw: { fareClass: 'Economy', pnrPrefix: 'AI', soldOut: true },
  },
];

/** Deterministic mock FlightProvider (Phase 5). No network call, no real booking capability. */
export class MockFlightProvider implements FlightProvider {
  readonly providerName = 'MockFlightProvider';

  async search(criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    const retrievedAt = new Date().toISOString();
    return FIXTURES.map((fixture) => ({
      provider: fixture.provider,
      domain: 'flight',
      offerId: fixture.offerId,
      vehicleNumber: fixture.vehicleNumber,
      operatorName: fixture.operatorName,
      origin: criteria.origin,
      destination: criteria.destination,
      price: fixture.price,
      currency: fixture.currency,
      availability: fixture.availability,
      departure: fixture.departure,
      arrival: fixture.arrival,
      durationMinutes: fixture.durationMinutes,
      sourceUrl: fixture.sourceUrl,
      retrievedAt,
      raw: fixture.raw,
    }));
  }
}
