export interface RateLimiterEnvConfig {
  redisUrl: string;
  maxCallsPerWindow: number;
  windowSeconds: number;
}

/**
 * Config-driven, same pattern as src/ai/config.ts's loadLlmConfigFromEnv
 * (plan §6/§19: "make the limit deterministic and configurable rather
 * than hard-coded"). Defaults are conservative placeholders, not a
 * product decision this document makes - swapping them is an env
 * change, never a code change.
 */
export function loadRateLimiterConfigFromEnv(): RateLimiterEnvConfig {
  return {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    maxCallsPerWindow: Number(process.env.PROVIDER_RATE_LIMIT_MAX_CALLS ?? '100'),
    windowSeconds: Number(process.env.PROVIDER_RATE_LIMIT_WINDOW_SECONDS ?? '60'),
  };
}
