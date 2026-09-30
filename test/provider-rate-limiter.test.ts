import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { ProviderRateLimiter } from '../src/rate-limit/provider-rate-limiter';
import { RedisRateLimiterStore } from '../src/rate-limit/redis-rate-limiter-store';
import type { RateLimiterStore } from '../src/rate-limit/rate-limiter-store';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const store = new RedisRateLimiterStore(redis);

afterAll(async () => {
  redis.disconnect();
});

const TEST_PREFIX = `test:provider-rate-limiter:${Date.now()}`;

class AlwaysErrorStore implements RateLimiterStore {
  async increment(): Promise<number> {
    throw new Error('simulated Redis outage');
  }
}

describe('ProviderRateLimiter (against a real local Redis instance)', () => {
  it('allows calls while under the configured limit', async () => {
    const limiter = new ProviderRateLimiter(store, { maxCallsPerWindow: 3, windowSeconds: 60 });
    const key = `${TEST_PREFIX}:under-limit`;

    expect(await limiter.isAllowed(key)).toBe(true);
    expect(await limiter.isAllowed(key)).toBe(true);
    expect(await limiter.isAllowed(key)).toBe(true);
  });

  it('rejects a call once the configured limit is exceeded', async () => {
    const limiter = new ProviderRateLimiter(store, { maxCallsPerWindow: 2, windowSeconds: 60 });
    const key = `${TEST_PREFIX}:over-limit`;

    expect(await limiter.isAllowed(key)).toBe(true); // 1
    expect(await limiter.isAllowed(key)).toBe(true); // 2
    expect(await limiter.isAllowed(key)).toBe(false); // 3 - over the limit of 2
    expect(await limiter.isAllowed(key)).toBe(false); // still rejected
  });

  it('respects a configured limit of exactly 1', async () => {
    const limiter = new ProviderRateLimiter(store, { maxCallsPerWindow: 1, windowSeconds: 60 });
    const key = `${TEST_PREFIX}:limit-one`;

    expect(await limiter.isAllowed(key)).toBe(true);
    expect(await limiter.isAllowed(key)).toBe(false);
  });

  it('tracks each key independently - one provider being limited does not affect another', async () => {
    const limiter = new ProviderRateLimiter(store, { maxCallsPerWindow: 1, windowSeconds: 60 });
    const keyA = `${TEST_PREFIX}:independent-a`;
    const keyB = `${TEST_PREFIX}:independent-b`;

    expect(await limiter.isAllowed(keyA)).toBe(true);
    expect(await limiter.isAllowed(keyA)).toBe(false);
    // keyB has never been called - still allowed, unaffected by keyA's state.
    expect(await limiter.isAllowed(keyB)).toBe(true);
  });

  it('a higher configured limit allows more calls before rejecting - configuration is genuinely respected, not hard-coded', async () => {
    const generous = new ProviderRateLimiter(store, { maxCallsPerWindow: 5, windowSeconds: 60 });
    const strict = new ProviderRateLimiter(store, { maxCallsPerWindow: 1, windowSeconds: 60 });
    const keyGenerous = `${TEST_PREFIX}:config-generous`;
    const keyStrict = `${TEST_PREFIX}:config-strict`;

    for (let i = 0; i < 5; i += 1) {
      expect(await generous.isAllowed(keyGenerous)).toBe(true);
    }
    expect(await generous.isAllowed(keyGenerous)).toBe(false);

    expect(await strict.isAllowed(keyStrict)).toBe(true);
    expect(await strict.isAllowed(keyStrict)).toBe(false);
  });

  it('fails open when the underlying store errors (documented decision - see provider-rate-limiter.ts)', async () => {
    const limiter = new ProviderRateLimiter(new AlwaysErrorStore(), { maxCallsPerWindow: 1, windowSeconds: 60 });
    expect(await limiter.isAllowed('any-key')).toBe(true);
  });
});
