import type { HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../providers/hotel-provider';

export interface SearchHotelsResult {
  offers: NormalizedHotelOffer[];
  /** Provider names whose search call failed or timed out - the caller still gets every other provider's offers (plan §E/§L: one provider failure must never fail the whole comparison). */
  failedProviders: string[];
}

const PROVIDER_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, providerName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${providerName} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * The "Hotel Search Tool" (plan §D): fans a search out across every
 * registered HotelProvider in parallel via Promise.allSettled, so one
 * slow/failed provider never blocks or fails the others (plan §E/§L,
 * same isolation principle the architecture requires for multi-domain
 * transport search later). Only one provider exists today
 * (MockHotelProvider), but the fan-out shape already supports
 * `HotelProvider[]` with no interface change needed when a second
 * provider is added.
 *
 * This function does no normalization itself - every HotelProvider
 * already returns normalized offers (same boundary PlacesProvider
 * draws) - and does no comparison; it only gathers and isolates.
 */
export async function searchHotels(
  providers: HotelProvider[],
  criteria: HotelSearchCriteria,
): Promise<SearchHotelsResult> {
  const results = await Promise.allSettled(
    providers.map((provider) => withTimeout(provider.search(criteria), PROVIDER_TIMEOUT_MS, provider.providerName)),
  );

  const offers: NormalizedHotelOffer[] = [];
  const failedProviders: string[] = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      offers.push(...result.value);
    } else {
      failedProviders.push(providers[index].providerName);
    }
  });

  return { offers, failedProviders };
}
