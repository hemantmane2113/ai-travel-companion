import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { HealthController } from './health.controller';
import { ItinerariesController } from './itineraries.controller';
import { FoodController } from './food.controller';
import { ShoppingController } from './shopping.controller';
import { AdvisoriesController } from './advisories.controller';
import { CompanionController } from './companion.controller';

/**
 * Thin HTTP layer over the plain, framework-free modules built so far
 * (Places, Travel Intelligence, AI Orchestration, Itinerary, Food,
 * Shopping, Advisory, Companion) - every controller here is wiring, not
 * logic. CompanionController is the new V2 conversational entry point
 * (Phase 2); it sits alongside the existing controllers rather than
 * replacing any of them.
 */
@Module({
  imports: [CoreModule],
  controllers: [
    HealthController,
    ItinerariesController,
    FoodController,
    ShoppingController,
    AdvisoriesController,
    CompanionController,
  ],
})
export class AppModule {}
