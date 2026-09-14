import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from './tokens';
import { getWarnings, type WarningWithProvenance } from '../advisory/get-warnings';

@Controller('advisories')
export class AdvisoriesController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async list(@Query('destination') destinationSlug: string): Promise<WarningWithProvenance[]> {
    if (!destinationSlug) {
      throw new BadRequestException('destination query param is required');
    }
    return getWarnings(this.pool, destinationSlug);
  }
}
