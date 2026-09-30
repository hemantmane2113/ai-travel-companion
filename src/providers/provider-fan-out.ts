import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';

export interface FanOutProvider<TCriteria, TOffer> {
  readonly providerName: string;
  search(criteria: TCriteria): Promise<TOffer[]>;
}

export interface FanOutResult<TOffer> {
  offers: TOffer[];
  /** Provider names whose search call failed, timed out, OR was rate-limited - all three are isolated identically (plan §1/§E/§L: one provider being unavailable, for whatever reason, must never fail the whole comparison, and must never fail an unrelated provider in the same fan-out). */
  failedProviders: string[];
}

export interface FanOutOptions {
  timeoutMs?: number;
  /** Omit to skip rate limiting entirely (e.g. in a unit test that doesn't care about it). */
  rateLimiter?: ProviderRateLimiter;
}

const DEFAULT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, providerName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${providerName} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * The genuinely reusable provider-fan-out primitive (V2 architecture
 * Phase 5): extracted from Phase 4's searchHotels, which duplicated this
 * exact Promise.allSettled + timeout + isolate shape. Every domain
 * search tool (searchHotels, searchFlights, searchTrains, searchBuses)
 * is now a thin wrapper over this one function - no domain-specific
 * fan-out logic exists anywhere else, so a future fifth domain needs no
 * new fan-out code, only a new thin wrapper + provider set.
 *
 * The rate limiter, when supplied, is checked per provider BEFORE that
 * provider's search() is ever called - a rate-limited provider never
 * gets a chance to time out or error; it's simply isolated the same way
 * a failing provider already is, landing in `failedProviders`.
 */
export async function fanOutProviderSearch<TCriteria, TOffer>(
  providers: Array<FanOutProvider<TCriteria, TOffer>>,
  criteria: TCriteria,
  options: FanOutOptions = {},
): Promise<FanOutResult<TOffer>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { rateLimiter } = options;

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      if (rateLimiter) {
        const allowed = await rateLimiter.isAllowed(provider.providerName);
        if (!allowed) {
          throw new Error(`${provider.providerName} is rate-limited`);
        }
      }
      return withTimeout(provider.search(criteria), timeoutMs, provider.providerName);
    }),
  );

  const offers: TOffer[] = [];
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
