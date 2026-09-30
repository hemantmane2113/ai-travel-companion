import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import type { HotelProvider } from '../providers/hotel-provider';
import type { BusProvider, FlightProvider, TrainProvider } from '../providers/transport-provider';
import type { WriteProvider } from '../providers/write-provider';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';
import type { ComparisonProviders } from '../agents/comparison-agent';
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
import { CompanionMessageDto } from './dto/companion-message.dto';
import { validateDto } from './validate-dto';
import { routeMessage, type CompanionResult } from '../agents/supervisor-agent';

/**
 * The Phase 2 companion entry point (docs/architecture-v2-agent-companion.md
 * §N Phase 2): one conversational endpoint, routed by the deterministic
 * Supervisor to the existing itinerary pipeline, the Comparison Agent
 * (Phase 4/5), the cancellation-policy tool, or the Q&A capability. Does
 * not replace or modify ItinerariesController - the existing /itineraries
 * API is untouched and still behaves exactly as before; this is a new,
 * additional entry point.
 */
@Controller('companion')
export class CompanionController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
    @Inject(HOTEL_PROVIDERS) private readonly hotelProviders: HotelProvider[],
    @Inject(FLIGHT_PROVIDERS) private readonly flightProviders: FlightProvider[],
    @Inject(TRAIN_PROVIDERS) private readonly trainProviders: TrainProvider[],
    @Inject(BUS_PROVIDERS) private readonly busProviders: BusProvider[],
    @Inject(PROVIDER_RATE_LIMITER) private readonly rateLimiter: ProviderRateLimiter,
    @Inject(WRITE_PROVIDER) private readonly writeProvider: WriteProvider,
  ) {}

  @Post('messages')
  @HttpCode(200)
  async postMessage(@Body() body: unknown): Promise<CompanionResult> {
    const dto = await validateDto(CompanionMessageDto, body);
    const comparisonProviders: ComparisonProviders = {
      hotel: this.hotelProviders,
      flight: this.flightProviders,
      train: this.trainProviders,
      bus: this.busProviders,
    };
    try {
      return await routeMessage(this.pool, this.llmProvider, dto, comparisonProviders, this.rateLimiter, this.writeProvider);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid request');
    }
  }
}
