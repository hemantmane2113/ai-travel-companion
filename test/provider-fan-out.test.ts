import { describe, expect, it } from 'vitest';
import { fanOutProviderSearch, type FanOutProvider } from '../src/providers/provider-fan-out';
import { ProviderRateLimiter } from '../src/rate-limit/provider-rate-limiter';
import type { RateLimiterStore } from '../src/rate-limit/rate-limiter-store';

interface Criteria {
  q: string;
}
interface Offer {
  id: string;
}

function makeProvider(name: string, offers: Offer[]): FanOutProvider<Criteria, Offer> {
  return { providerName: name, search: async () => offers };
}

function makeFailingProvider(name: string): FanOutProvider<Criteria, Offer> {
  return {
    providerName: name,
    search: async () => {
      throw new Error('simulated outage');
    },
  };
}

function makeSlowProvider(name: string, delayMs: number): FanOutProvider<Criteria, Offer> {
  return {
    providerName: name,
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return [{ id: `${name}-offer` }];
    },
  };
}

class AlwaysAllowStore implements RateLimiterStore {
  async increment(): Promise<number> {
    return 1;
  }
}

class AlwaysErrorStore implements RateLimiterStore {
  async increment(): Promise<number> {
    throw new Error('simulated store outage');
  }
}

class DenylistStore implements RateLimiterStore {
  constructor(private readonly deniedKeys: Set<string>) {}
  async increment(key: string): Promise<number> {
    return this.deniedKeys.has(key) ? 999 : 1;
  }
}

describe('fanOutProviderSearch', () => {
  it('merges offers from multiple providers', async () => {
    const result = await fanOutProviderSearch(
      [makeProvider('A', [{ id: 'a1' }]), makeProvider('B', [{ id: 'b1' }, { id: 'b2' }])],
      { q: 'x' },
    );
    expect(result.offers.map((o) => o.id).sort()).toEqual(['a1', 'b1', 'b2']);
    expect(result.failedProviders).toEqual([]);
  });

  it('isolates a failing provider - other providers still return their offers', async () => {
    const result = await fanOutProviderSearch(
      [makeProvider('A', [{ id: 'a1' }]), makeFailingProvider('Failing')],
      { q: 'x' },
    );
    expect(result.offers).toEqual([{ id: 'a1' }]);
    expect(result.failedProviders).toEqual(['Failing']);
  });

  it('isolates a timed-out provider without waiting past the configured timeout', async () => {
    const result = await fanOutProviderSearch(
      [makeProvider('Fast', [{ id: 'fast1' }]), makeSlowProvider('Slow', 200)],
      { q: 'x' },
      { timeoutMs: 20 },
    );
    expect(result.offers).toEqual([{ id: 'fast1' }]);
    expect(result.failedProviders).toEqual(['Slow']);
  });

  it('returns empty results and no failures for an empty provider list', async () => {
    const result = await fanOutProviderSearch([], { q: 'x' });
    expect(result).toEqual({ offers: [], failedProviders: [] });
  });

  it('isolates a rate-limited provider exactly like a failing one - other providers are unaffected', async () => {
    const limiter = new ProviderRateLimiter(new DenylistStore(new Set(['RateLimited'])), {
      maxCallsPerWindow: 1,
      windowSeconds: 60,
    });

    const result = await fanOutProviderSearch(
      [makeProvider('Allowed', [{ id: 'ok1' }]), makeProvider('RateLimited', [{ id: 'never-seen' }])],
      { q: 'x' },
      { rateLimiter: limiter },
    );

    expect(result.offers).toEqual([{ id: 'ok1' }]);
    expect(result.failedProviders).toEqual(['RateLimited']);
  });

  it('a rate-limited provider never has its search() called at all', async () => {
    let called = false;
    const trackedProvider: FanOutProvider<Criteria, Offer> = {
      providerName: 'Tracked',
      search: async () => {
        called = true;
        return [{ id: 'should-not-appear' }];
      },
    };
    const limiter = new ProviderRateLimiter(new DenylistStore(new Set(['Tracked'])), {
      maxCallsPerWindow: 1,
      windowSeconds: 60,
    });

    await fanOutProviderSearch([trackedProvider], { q: 'x' }, { rateLimiter: limiter });
    expect(called).toBe(false);
  });

  it('allows every provider through when no rate limiter is supplied', async () => {
    const result = await fanOutProviderSearch([makeProvider('A', [{ id: 'a1' }])], { q: 'x' });
    expect(result.offers).toEqual([{ id: 'a1' }]);
  });

  it('fails open (allows the call) when the rate limiter store itself errors', async () => {
    const limiter = new ProviderRateLimiter(new AlwaysErrorStore(), { maxCallsPerWindow: 1, windowSeconds: 60 });
    const result = await fanOutProviderSearch([makeProvider('A', [{ id: 'a1' }])], { q: 'x' }, { rateLimiter: limiter });
    expect(result.offers).toEqual([{ id: 'a1' }]);
    expect(result.failedProviders).toEqual([]);
  });

  it('allows every provider through when every key is under the limit', async () => {
    const limiter = new ProviderRateLimiter(new AlwaysAllowStore(), { maxCallsPerWindow: 100, windowSeconds: 60 });
    const result = await fanOutProviderSearch(
      [makeProvider('A', [{ id: 'a1' }]), makeProvider('B', [{ id: 'b1' }])],
      { q: 'x' },
      { rateLimiter: limiter },
    );
    expect(result.offers.map((o) => o.id).sort()).toEqual(['a1', 'b1']);
    expect(result.failedProviders).toEqual([]);
  });
});
