import type { LlmGenerateResult, LlmProvider } from './llm-provider';

export interface OpenAiCompatibleConfig {
  /** e.g. http://localhost:11434/v1 for a local Ollama server. */
  baseUrl: string;
  model: string;
  /** Optional - local model servers usually don't require one. */
  apiKey?: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Default/reference adapter (plan §6): speaks the OpenAI Chat
 * Completions HTTP format, which a self-hosted open-weight model server
 * (Ollama, vLLM, LM Studio) speaks too - so "local model" (V1's actual
 * dependency) and "a future hosted provider" are the SAME adapter,
 * differing only by which baseUrl/model/apiKey is configured. No paid
 * provider is required for this class to work.
 */
export class OpenAiCompatibleAdapter implements LlmProvider {
  readonly providerName: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.providerName = `openai-compatible:${config.model}`;
  }

  async generate(systemPrompt: string, userPrompt: string): Promise<LlmGenerateResult> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices[0]?.message?.content;
    if (!text) {
      throw new Error('LLM response had no content');
    }

    return {
      text,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
