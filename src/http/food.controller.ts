import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from './tokens';
import { recommendFood, type FoodRecommendation } from '../food/recommend-food';
import { DESTINATIONS } from '../destinations';

@Controller('food')
export class FoodController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async recommend(
    @Query('destination') destinationSlug: string,
    @Query('cuisine') cuisine?: string,
  ): Promise<FoodRecommendation[]> {
    const destination = destinationSlug ? DESTINATIONS[destinationSlug] : undefined;
    if (!destination) {
      throw new BadRequestException(`Unknown or missing destination: ${destinationSlug}`);
    }
    return recommendFood(this.pool, destination.slug, destination.center, { cuisine });
  }
}
