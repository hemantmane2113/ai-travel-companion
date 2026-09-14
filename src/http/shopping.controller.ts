import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from './tokens';
import { recommendShopping, type ShoppingRecommendation } from '../shopping/recommend-shopping';
import { DESTINATIONS } from '../destinations';

@Controller('shopping')
export class ShoppingController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async recommend(
    @Query('destination') destinationSlug: string,
    @Query('shopType') shopType?: string,
  ): Promise<ShoppingRecommendation[]> {
    const destination = destinationSlug ? DESTINATIONS[destinationSlug] : undefined;
    if (!destination) {
      throw new BadRequestException(`Unknown or missing destination: ${destinationSlug}`);
    }
    return recommendShopping(this.pool, destination.slug, destination.center, { shopType });
  }
}
