// DI tokens for providers with no natural class to inject by (plan §6's
// AI Orchestration and the shared pg Pool are plain values/interfaces,
// not NestJS-flavored classes).
export const POOL = Symbol('POOL');
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
/** The Comparison Agent's HotelProvider[] (Phase 4) - a DI seam exactly like LLM_PROVIDER, so a test can override it (e.g. to prove provider-failure isolation over real HTTP) without touching the agent's own default. */
export const HOTEL_PROVIDERS = Symbol('HOTEL_PROVIDERS');
