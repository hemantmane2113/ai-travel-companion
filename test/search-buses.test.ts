import { describe, expect, it } from 'vitest';
import { searchBuses } from '../src/transport/search-buses';
import { MockBusProvider } from '../src/providers/mock-bus-provider';
import type { BusProvider, NormalizedTransportOffer, TransportSearchCriteria } from '../src/providers/transport-provider';

class FailingBusProvider implements BusProvider {
  readonly providerName = 'FailingBusProvider';
  async search(_criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    throw new Error('simulated outage');
  }
}

describe('searchBuses', () => {
  it('fans out across multiple bus providers', async () => {
    const result = await searchBuses([new MockBusProvider(), new MockBusProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.failedProviders).toEqual([]);
  });

  it('isolates a failing bus provider - the other provider still returns its offers', async () => {
    const result = await searchBuses([new MockBusProvider(), new FailingBusProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.failedProviders).toEqual(['FailingBusProvider']);
    expect(result.offers.length).toBeGreaterThan(0);
  });
});
