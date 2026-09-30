export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmGenerateResult {
  text: string;
  usage?: LlmUsage;
}

/**
 * The provider-neutral AI boundary (plan §6). AiOrchestrationService is
 * the only caller of this interface, and callers of AiOrchestrationService
 * never know which concrete provider/model answered.
 */
export interface LlmProvider {
  readonly providerName: string;
  generate(systemPrompt: string, userPrompt: string): Promise<LlmGenerateResult>;
}
