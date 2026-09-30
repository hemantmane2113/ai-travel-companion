import { describe, expect, it } from 'vitest';
import { searchTrains } from '../src/transport/search-trains';
import { MockTrainProvider } from '../src/providers/mock-train-provider';
import type { NormalizedTransportOffer, TrainProvider, TransportSearchCriteria } from '../src/providers/transport-provider';

class FailingTrainProvider implements TrainProvider {
  readonly providerName = 'FailingTrainProvider';
  async search(_criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]> {
    throw new Error('simulated outage');
  }
}

describe('searchTrains', () => {
  it('fans out across multiple train providers', async () => {
    const result = await searchTrains([new MockTrainProvider(), new MockTrainProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.failedProviders).toEqual([]);
  });

  it('isolates a failing train provider - the other provider still returns its offers', async () => {
    const result = await searchTrains([new MockTrainProvider(), new FailingTrainProvider()], {
      origin: 'Pune',
      destination: 'Delhi',
    });
    expect(result.failedProviders).toEqual(['FailingTrainProvider']);
    expect(result.offers.length).toBeGreaterThan(0);
  });
});
