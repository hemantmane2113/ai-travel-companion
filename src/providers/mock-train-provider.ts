import type { NormalizedTransportOffer, TrainProvider, TransportSearchCriteria } from './transport-provider';

interface TrainFixture {
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

const FIXTURES: TrainFixture[] = [
  {
    provider: 'MockIRCTC',
    offerId: 'mock-train-1',
    vehicleNumber: '12002',
    operatorName: 'Shatabdi Express',
    price: 1200,
    currency: 'INR',
    availability: true,
    departure: '2026-12-01T06:15:00.000Z',
    arrival: '2026-12-01T14:30:00.000Z',
    durationMinutes: 495,
    sourceUrl: 'https://mock-irctc.example/trains/mock-train-1',
    raw: { trainClass: 'CC', quota: 'GENERAL' },
  },
  {
    provider: 'MockIRCTC',
    offerId: 'mock-train-2',
    vehicleNumber: '12952',
    operatorName: 'Rajdhani Express',
    price: 2100,
    currency: 'INR',
    availability: false,
    departure: '2026-12-01T16:00:00.000Z',
    arrival: '2026-12-02T01:20:00.000Z',
    durationMinutes: 560,
    sourceUrl: 'https://mock-irctc.example/trains/mock-train-2',
    raw: { trainClass: '3A', quota: 'GENERAL', waitlisted: true },
  },
];

/** Deterministic mock TrainProvider (Phase 5). No network call, no real booking capability. */
export class MockTrainProvider implements TrainProvider {
  readonly providerName = 'MockTrainProvider';

  async search(criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    const retrievedAt = new Date().toISOString();
    return FIXTURES.map((fixture) => ({
      provider: fixture.provider,
      domain: 'train',
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
