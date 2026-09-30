import type { RateLimiterStore } from './rate-limiter-store';

export interface RateLimiterConfig {
  /** Max calls allowed per provider per window. Configurable (env-driven, see src/http/core.module.ts), never hard-coded into business logic. */
  maxCallsPerWindow: number;
  windowSeconds: number;
}

/**
 * Provider-call rate limiting (V2 architecture Phase 5, CLAUDE.md §L):
 * sits AROUND a provider call, not inside any provider implementation -
 * src/providers/provider-fan-out.ts is the only caller. Keyed by
 * provider name today (the stated purpose is protecting a provider from
 * being overwhelmed by repeated calls across all requests, not
 * per-user/per-conversation fairness); a caller wanting finer scoping
 * can still pass a composite key like `${providerName}:${conversationId}`
 * without any change here.
 *
 * FAIL-OPEN DECISION (documented per the explicit instruction that
 * neither CLAUDE.md nor the architecture doc specifies Redis-unavailable
 * behavior for this limiter): if the store itself errors (Redis down,
 * network partition, etc.), isAllowed() returns true - the call is
 * allowed through rather than blocked. Rationale: this limiter protects
 * upstream providers from overload, an efficiency/availability concern,
 * not a safety-of-action or correctness boundary (CLAUDE.md §30's
 * priority order ranks "safety of actions" above "efficiency" - a
 * booking confirmation gate must fail closed, but a rate limiter
 * failing shut would take down comparison entirely over a Redis hiccup,
 * which is a worse outcome than occasionally under-limiting a provider
 * call for the brief time Redis is unreachable). If a future phase
 * needs fail-closed behavior for a different limiter, that is a new,
 * explicit policy decision - not implied by this one.
 */
export class ProviderRateLimiter {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig,
  ) {}

  async isAllowed(key: string): Promise<boolean> {
    try {
      const count = await this.store.increment(key, this.config.windowSeconds);
      return count <= this.config.maxCallsPerWindow;
    } catch {
      return true;
    }
  }
}
