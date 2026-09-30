// DI tokens for providers with no natural class to inject by (plan §6's
// AI Orchestration and the shared pg Pool are plain values/interfaces,
// not NestJS-flavored classes).
export const POOL = Symbol('POOL');
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
/** The Comparison Agent's per-domain provider registrations (Phase 4/5) - a DI seam exactly like LLM_PROVIDER, so a test can override any of them (e.g. to prove provider-failure isolation over real HTTP) without touching the agent's own defaults. */
export const HOTEL_PROVIDERS = Symbol('HOTEL_PROVIDERS');
export const FLIGHT_PROVIDERS = Symbol('FLIGHT_PROVIDERS');
export const TRAIN_PROVIDERS = Symbol('TRAIN_PROVIDERS');
export const BUS_PROVIDERS = Symbol('BUS_PROVIDERS');
/** The Comparison Agent's ProviderRateLimiter (Phase 5) - same DI seam pattern. */
export const PROVIDER_RATE_LIMITER = Symbol('PROVIDER_RATE_LIMITER');
