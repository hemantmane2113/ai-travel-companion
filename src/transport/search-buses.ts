import type { BusProvider, NormalizedTransportOffer, TransportSearchCriteria } from '../providers/transport-provider';
import { fanOutProviderSearch, type FanOutResult } from '../providers/provider-fan-out';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';

export type SearchBusesResult = FanOutResult<NormalizedTransportOffer>;

/** The "Bus Search Tool" (plan §D/§5) - thin wrapper over the shared fan-out primitive, mirroring searchHotels exactly. */
export async function searchBuses(
  providers: BusProvider[],
  criteria: TransportSearchCriteria,
  rateLimiter?: ProviderRateLimiter,
): Promise<SearchBusesResult> {
  return fanOutProviderSearch(providers, criteria, { rateLimiter });
}
