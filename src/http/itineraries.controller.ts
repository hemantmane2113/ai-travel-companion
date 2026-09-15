import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { LLM_PROVIDER, POOL } from './tokens';
import { CreateItineraryDto } from './dto/create-itinerary.dto';
import { validateDto } from './validate-dto';
import { createItineraryJob, runItineraryJob } from '../itinerary/generate-itinerary';
import { getJob, type ItineraryJobRow } from '../itinerary/jobs';
import {
  getItemProvenance,
  getItineraryWithProvenance,
  type ItineraryItemWithProvenance,
  type ItineraryWithProvenance,
} from '../itinerary/get-itinerary';

@Controller('itineraries')
export class ItinerariesController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
  ) {}

  /**
   * Returns 202 as soon as the job row exists (plan §9 step 3) - the
   * actual generation runs in the background. Its failure is always
   * recorded on the job row by runItineraryJob before it rethrows, so
   * the .catch() here only stops that rethrow from becoming an
   * unhandled promise rejection; it does nothing else. createItineraryJob
   * itself only throws for bad client input (an unknown destination or
   * an invalid trip date range - stabilization P0-4), validated before
   * any DB write, so that failure is translated to a 400 here rather
   * than surfacing as an unhandled 500.
   */
  @Post()
  @HttpCode(202)
  async create(@Body() body: unknown): Promise<{ jobId: string }> {
    const dto = await validateDto(CreateItineraryDto, body);

    let jobId: string;
    try {
      jobId = await createItineraryJob(this.pool, dto);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid request');
    }

    void runItineraryJob(this.pool, this.llmProvider, jobId, dto).catch(() => {});
    return { jobId };
  }

  /**
   * ParseUUIDPipe validates the param before any handler code runs, so a
   * malformed id never reaches Postgres as a raw '22P02 invalid input
   * syntax for type uuid' error surfacing as an unhandled 500 (audit
   * P0-1) - it's an explicit pipe instance here, not inferred via
   * emitDecoratorMetadata, so it isn't affected by the same esbuild
   * metadata gap that broke the automatic body ValidationPipe.
   */
  @Get('jobs/:jobId')
  async getJobStatus(
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ItineraryJobRow> {
    const job = await getJob(this.pool, jobId);
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  @Get(':id')
  async getItinerary(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ItineraryWithProvenance> {
    const itinerary = await getItineraryWithProvenance(this.pool, id);
    if (!itinerary) throw new NotFoundException('Itinerary not found');
    return itinerary;
  }

  /** "Why does the system believe this?" (plan §5) for one item. */
  @Get(':id/items/:itemId/provenance')
  async getProvenance(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<ItineraryItemWithProvenance> {
    const provenance = await getItemProvenance(this.pool, id, itemId);
    if (!provenance) throw new NotFoundException('Itinerary item not found');
    return provenance;
  }
}
