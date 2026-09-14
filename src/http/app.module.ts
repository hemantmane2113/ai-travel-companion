import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { HealthController } from './health.controller';
import { ItinerariesController } from './itineraries.controller';
import { FoodController } from './food.controller';
import { ShoppingController } from './shopping.controller';
import { AdvisoriesController } from './advisories.controller';

/**
 * Thin HTTP layer over the plain, framework-free modules built so far
 * (Places, Travel Intelligence, AI Orchestration, Itinerary, Food,
 * Shopping, Advisory) - every controller here is wiring, not logic.
 */
@Module({
  imports: [CoreModule],
  controllers: [
    HealthController,
    ItinerariesController,
    FoodController,
    ShoppingController,
    AdvisoriesController,
  ],
})
export class AppModule {}
