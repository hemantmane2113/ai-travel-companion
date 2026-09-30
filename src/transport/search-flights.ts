import type { FlightProvider, NormalizedTransportOffer, TransportSearchCriteria } from '../providers/transport-provider';
import { fanOutProviderSearch, type FanOutResult } from '../providers/provider-fan-out';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';

export type SearchFlightsResult = FanOutResult<NormalizedTransportOffer>;

/** The "Flight Search Tool" (plan §D/§5) - thin wrapper over the shared fan-out primitive, mirroring searchHotels exactly. */
export async function searchFlights(
  providers: FlightProvider[],
  criteria: TransportSearchCriteria,
  rateLimiter?: ProviderRateLimiter,
): Promise<SearchFlightsResult> {
  return fanOutProviderSearch(providers, criteria, { rateLimiter });
}
