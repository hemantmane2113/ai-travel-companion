import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { LLM_PROVIDER, POOL } from './tokens';
import { CompanionMessageDto } from './dto/companion-message.dto';
import { validateDto } from './validate-dto';
import { routeMessage, type CompanionResult } from '../agents/supervisor-agent';

/**
 * The Phase 2 companion entry point (docs/architecture-v2-agent-companion.md
 * §N Phase 2): one conversational endpoint, routed by the deterministic
 * Supervisor to either the existing itinerary pipeline or the new Q&A
 * capability. Does not replace or modify ItinerariesController - the
 * existing /itineraries API is untouched and still behaves exactly as
 * before; this is a new, additional entry point.
 */
@Controller('companion')
export class CompanionController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
  ) {}

  @Post('messages')
  @HttpCode(200)
  async postMessage(@Body() body: unknown): Promise<CompanionResult> {
    const dto = await validateDto(CompanionMessageDto, body);
    try {
      return await routeMessage(this.pool, this.llmProvider, dto);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid request');
    }
  }
}
