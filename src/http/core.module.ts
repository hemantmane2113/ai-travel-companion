import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { OpenAiCompatibleAdapter } from '../ai/openai-compatible-adapter';
import { loadLlmConfigFromEnv } from '../ai/config';
import type { LlmProvider } from '../ai/llm-provider';
import type { HotelProvider } from '../providers/hotel-provider';
import { MockHotelProvider } from '../providers/mock-hotel-provider';
import type { FlightProvider, TrainProvider, BusProvider } from '../providers/transport-provider';
import { MockFlightProvider } from '../providers/mock-flight-provider';
import { MockTrainProvider } from '../providers/mock-train-provider';
import { MockBusProvider } from '../providers/mock-bus-provider';
import { RedisRateLimiterStore } from '../rate-limit/redis-rate-limiter-store';
import { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';
import { loadRateLimiterConfigFromEnv } from '../rate-limit/config';
import type { WriteProvider } from '../providers/write-provider';
import { SandboxWriteProvider } from '../providers/sandbox-write-provider';
import {
  BUS_PROVIDERS,
  FLIGHT_PROVIDERS,
  HOTEL_PROVIDERS,
  LLM_PROVIDER,
  POOL,
  PROVIDER_RATE_LIMITER,
  TRAIN_PROVIDERS,
  WRITE_PROVIDER,
} from './tokens';

/**
 * Wires the plain, framework-free modules (Pool, AI Orchestration's
 * provider-neutral adapter, the Comparison Agent's provider
 * registrations and rate limiter) into Nest's DI container. This is the
 * only file that decides which concrete implementation is active -
 * swapping any of them is a config change (plan §6), not a controller
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
    {
      // Phase 5: same posture - mocked, not a real/sandbox integration.
      provide: FLIGHT_PROVIDERS,
      useFactory: (): FlightProvider[] => [new MockFlightProvider()],
    },
    {
      provide: TRAIN_PROVIDERS,
      useFactory: (): TrainProvider[] => [new MockTrainProvider()],
    },
    {
      provide: BUS_PROVIDERS,
      useFactory: (): BusProvider[] => [new MockBusProvider()],
    },
    {
      // Phase 5: the one Redis client abstraction this codebase
      // introduces - Redis was provisioned since Phase 1 (docker-compose.yml)
      // but deliberately left unused until a phase actually needed it
      // (docs/architecture-v2-agent-companion.md §L/§N). `lazyConnect`
      // avoids a hard startup dependency on Redis being reachable before
      // the app can even boot - the rate limiter itself fails OPEN if a
      // call errors (see ProviderRateLimiter's documented decision), so
      // a slow/late Redis connection degrades to "not rate limited yet",
      // never to a boot failure.
      provide: PROVIDER_RATE_LIMITER,
      useFactory: (): ProviderRateLimiter => {
        const config = loadRateLimiterConfigFromEnv();
        const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
        redis.connect().catch(() => {});
        const store = new RedisRateLimiterStore(redis);
        return new ProviderRateLimiter(store, {
          maxCallsPerWindow: config.maxCallsPerWindow,
          windowSeconds: config.windowSeconds,
        });
      },
    },
    {
      // Phase 7: the Booking Agent's write-side provider. Explicitly the
      // deterministic sandbox (CLAUDE.md §25) - no real/commercial
      // booking API exists in this phase. A NestJS provider with a
      // plain useFactory (no transient scope) is a singleton per module
      // instance, so this one SandboxWriteProvider's in-memory
      // idempotency-key cache correctly persists across HTTP requests,
      // matching what a real provider's own idempotency store would do.
      provide: WRITE_PROVIDER,
      useFactory: (): WriteProvider => new SandboxWriteProvider(),
    },
  ],
  exports: [
    POOL,
    LLM_PROVIDER,
    HOTEL_PROVIDERS,
    FLIGHT_PROVIDERS,
    TRAIN_PROVIDERS,
    BUS_PROVIDERS,
    PROVIDER_RATE_LIMITER,
    WRITE_PROVIDER,
  ],
})
export class CoreModule {}
