// DI tokens for providers with no natural class to inject by (plan §6's
// AI Orchestration and the shared pg Pool are plain values/interfaces,
// not NestJS-flavored classes).
export const POOL = Symbol('POOL');
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
