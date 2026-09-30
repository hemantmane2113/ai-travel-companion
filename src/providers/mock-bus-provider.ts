import type { BusProvider, NormalizedTransportOffer, TransportSearchCriteria } from './transport-provider';

interface BusFixture {
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

const FIXTURES: BusFixture[] = [
  {
    provider: 'MockRedBus',
    offerId: 'mock-bus-1',
    vehicleNumber: 'RB-4471',
    operatorName: 'IntrCity SmartBus',
    price: 800,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T22:00:00.000Z',
    arrival: '2026-12-02T07:30:00.000Z',
    durationMinutes: 570,
    sourceUrl: 'https://mock-redbus.example/buses/mock-bus-1',
    raw: { seatType: 'AC Sleeper' },
  },
  {
    provider: 'MockRedBus',
    offerId: 'mock-bus-2',
    vehicleNumber: 'RB-2210',
    operatorName: 'VRL Travels',
    price: 650,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T21:00:00.000Z',
    arrival: '2026-12-02T06:45:00.000Z',
    durationMinutes: 585,
    sourceUrl: 'https://mock-redbus.example/buses/mock-bus-2',
    raw: { seatType: 'Non-AC Seater' },
  },
];

/** Deterministic mock BusProvider (Phase 5). No network call, no real booking capability. */
export class MockBusProvider implements BusProvider {
  readonly providerName = 'MockBusProvider';

  async search(criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    const retrievedAt = new Date().toISOString();
    return FIXTURES.map((fixture) => ({
      provider: fixture.provider,
      domain: 'bus',
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
