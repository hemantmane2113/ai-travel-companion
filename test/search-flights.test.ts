import { describe, expect, it } from 'vitest';
import { searchFlights } from '../src/transport/search-flights';
import { MockFlightProvider } from '../src/providers/mock-flight-provider';
import type { FlightProvider, NormalizedTransportOffer, TransportSearchCriteria } from '../src/providers/transport-provider';

class FailingFlightProvider implements FlightProvider {
  readonly providerName = 'FailingFlightProvider';
  async search(_criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    throw new Error('simulated outage');
  }
}

describe('searchFlights', () => {
  it('fans out across multiple flight providers', async () => {
    const result = await searchFlights([new MockFlightProvider(), new MockFlightProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.failedProviders).toEqual([]);
  });

  it('isolates a failing flight provider - the other provider still returns its offers', async () => {
    const result = await searchFlights([new MockFlightProvider(), new FailingFlightProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.failedProviders).toEqual(['FailingFlightProvider']);
    expect(result.offers.length).toBeGreaterThan(0);
  });
});
