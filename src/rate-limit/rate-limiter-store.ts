/**
 * The storage boundary a ProviderRateLimiter counts against (V2
 * architecture Phase 5). Exactly one production implementation exists
 * (RedisRateLimiterStore) - this interface exists only so
 * ProviderRateLimiter itself has no idea it's talking to Redis
 * specifically, mirroring how LlmProvider keeps AiOrchestrationService
 * ignorant of which concrete model backend answered.
 */
export interface RateLimiterStore {
  /**
   * Atomically increments the counter for `key` and returns the new
   * count. The counter's TTL is (re)established at `windowSeconds` the
   * first time a key is created, so it self-expires into a fresh fixed
   * window - the caller never needs to reset it manually.
   */
  increment(key: string, windowSeconds: number): Promise<number>;
}
