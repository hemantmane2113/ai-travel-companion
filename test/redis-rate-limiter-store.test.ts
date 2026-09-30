import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RedisRateLimiterStore } from '../src/rate-limit/redis-rate-limiter-store';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const store = new RedisRateLimiterStore(redis);

afterAll(async () => {
  redis.disconnect();
});

// Every key here is unique to this test file/run so parallel test files
// (Vitest runs files in parallel) can never interfere with each other's
// counters - the same isolation principle already used for Postgres
// destination buckets/external_refs elsewhere in this test suite.
const TEST_PREFIX = `test:redis-rate-limiter-store:${Date.now()}`;

describe('RedisRateLimiterStore', () => {
  it('increments a fresh key starting at 1', async () => {
    const key = `${TEST_PREFIX}:fresh`;
    const count = await store.increment(key, 60);
    expect(count).toBe(1);
  });

  it('increments an existing key monotonically', async () => {
    const key = `${TEST_PREFIX}:monotonic`;
    expect(await store.increment(key, 60)).toBe(1);
    expect(await store.increment(key, 60)).toBe(2);
    expect(await store.increment(key, 60)).toBe(3);
  });

  it('tracks distinct keys independently', async () => {
    const keyA = `${TEST_PREFIX}:independent-a`;
    const keyB = `${TEST_PREFIX}:independent-b`;
    await store.increment(keyA, 60);
    await store.increment(keyA, 60);
    await store.increment(keyB, 60);
    expect(await store.increment(keyA, 60)).toBe(3);
    expect(await store.increment(keyB, 60)).toBe(2);
  });

  it('sets a TTL on the first increment so the window self-expires', async () => {
    const key = `${TEST_PREFIX}:ttl`;
    await store.increment(key, 60);
    const ttl = await redis.ttl(`ratelimit:provider:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('respects a distinct configured window length', async () => {
    const key = `${TEST_PREFIX}:ttl-window`;
    await store.increment(key, 5);
    const ttl = await redis.ttl(`ratelimit:provider:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });
});
