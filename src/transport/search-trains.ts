import type { NormalizedTransportOffer, TrainProvider, TransportSearchCriteria } from '../providers/transport-provider';
import { fanOutProviderSearch, type FanOutResult } from '../providers/provider-fan-out';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';

export type SearchTrainsResult = FanOutResult<NormalizedTransportOffer>;

/** The "Train Search Tool" (plan §D/§5) - thin wrapper over the shared fan-out primitive, mirroring searchHotels exactly. */
export async function searchTrains(
  providers: TrainProvider[],
  criteria: TransportSearchCriteria,
  rateLimiter?: ProviderRateLimiter,
): Promise<SearchTrainsResult> {
  return fanOutProviderSearch(providers, criteria, { rateLimiter });
}
