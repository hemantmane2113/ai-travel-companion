import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { OpenAiCompatibleAdapter } from '../ai/openai-compatible-adapter';
import { loadLlmConfigFromEnv } from '../ai/config';
import type { LlmProvider } from '../ai/llm-provider';
import { LLM_PROVIDER, POOL } from './tokens';

/**
 * Wires the plain, framework-free modules (Pool, AI Orchestration's
 * provider-neutral adapter) into Nest's DI container. This is the only
 * file that decides which concrete LlmProvider implementation is
 * active - swapping it is a config change (plan §6), not a controller
 * change.
 */
@Global()
@Module({
  providers: [
    {
      provide: POOL,
      useFactory: (): Pool => new Pool({ connectionString: process.env.DATABASE_URL }),
    },
    {
      provide: LLM_PROVIDER,
      useFactory: (): LlmProvider => new OpenAiCompatibleAdapter(loadLlmConfigFromEnv()),
    },
  ],
  exports: [POOL, LLM_PROVIDER],
})
export class CoreModule {}
