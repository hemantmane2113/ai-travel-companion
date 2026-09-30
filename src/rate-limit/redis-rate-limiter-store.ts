import type { Redis } from 'ioredis';
import type { RateLimiterStore } from './rate-limiter-store';

const KEY_PREFIX = 'ratelimit:provider:';

/**
 * The one Redis client abstraction this codebase introduces (V2
 * architecture Phase 5 - CLAUDE.md §9's Redis was provisioned since
 * Phase 1 but deliberately left unused until a phase actually needed
 * it; this is that phase). Fixed-window counter: INCR the key, and on
 * the very first increment of a fresh window also set its TTL so the
 * window self-expires - the standard minimal Redis rate-limiting
 * pattern, with no separate reset/cleanup job required.
 */
export class RedisRateLimiterStore implements RateLimiterStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const fullKey = `${KEY_PREFIX}${key}`;
    const count = await this.redis.incr(fullKey);
    if (count === 1) {
      await this.redis.expire(fullKey, windowSeconds);
    }
    return count;
  }
}
