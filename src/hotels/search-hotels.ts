import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../providers/hotel-provider';
import { fanOutProviderSearch, type FanOutResult } from '../providers/provider-fan-out';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';

export type SearchHotelsResult = FanOutResult<NormalizedHotelOffer>;

/**
 * The "Hotel Search Tool" (plan §D) - a thin, domain-named wrapper over
 * the shared provider-fan-out primitive (src/providers/provider-fan-out.ts,
 * extracted in Phase 5). This function does no normalization itself -
 * every HotelProvider already returns normalized offers - and does no
 * comparison; it only gathers and isolates (failures, timeouts, and now
 * rate limits alike).
 */
export async function searchHotels(
  providers: HotelProvider[],
  criteria: HotelSearchCriteria,
  rateLimiter?: ProviderRateLimiter,
): Promise<SearchHotelsResult> {
  return fanOutProviderSearch(providers, criteria, { rateLimiter });
}
