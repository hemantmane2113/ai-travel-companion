import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { OpenAiCompatibleAdapter } from '../ai/openai-compatible-adapter';
import { loadLlmConfigFromEnv } from '../ai/config';
import type { LlmProvider } from '../ai/llm-provider';
import type { HotelProvider } from '../providers/hotel-provider';
import { MockHotelProvider } from '../providers/mock-hotel-provider';
import { HOTEL_PROVIDERS, LLM_PROVIDER, POOL } from './tokens';

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
    {
      // Phase 4: the only registered HotelProvider is the deterministic
      // mock (CLAUDE.md §25 - explicitly not a real/sandbox integration
      // yet). Swapping or adding a real provider later is a config
      // change here, same as LLM_PROVIDER above.
      provide: HOTEL_PROVIDERS,
      useFactory: (): HotelProvider[] => [new MockHotelProvider()],
    },
  ],
  exports: [POOL, LLM_PROVIDER, HOTEL_PROVIDERS],
})
export class CoreModule {}
