import type { OpenAiCompatibleConfig } from './openai-compatible-adapter';

/**
 * Provider selection is config-driven (plan §6) - swapping the target
 * (a different local model, or later a hosted OpenAI-compatible
 * endpoint) is an env change, never a code change.
 *
 * Defaults assume a local Ollama server. Phase 1 hardware is resolved
 * as CPU-only (plan §11), so the default model is a small 3-4B instruct
 * model rather than the 7-8B target - see plan §6 for the trade-off.
 */
export function loadLlmConfigFromEnv(): OpenAiCompatibleConfig {
  return {
    baseUrl: process.env.AI_BASE_URL ?? 'http://localhost:11434/v1',
    model: process.env.AI_MODEL ?? 'qwen2.5:3b-instruct',
    apiKey: process.env.AI_API_KEY,
  };
}
