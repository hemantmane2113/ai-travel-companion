import type { LlmGenerateResult, LlmProvider } from './llm-provider';

/**
 * Deterministic stand-in for a real LLM provider. Used by tests (and,
 * per plan §16, by fast CI runs of AI-evaluation-style tests) so they
 * don't depend on a live model - CPU-only Phase 1 inference is slow
 * enough (plan §6) that tests must not require it. NOT wired into any
 * production code path.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly providerName = 'fake';

  constructor(private readonly response: string) {}

  async generate(): Promise<LlmGenerateResult> {
    return { text: this.response };
  }
}
