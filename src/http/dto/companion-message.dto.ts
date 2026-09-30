import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Domain } from '../../providers/hotel-provider';

const DOMAIN_VALUES: Domain[] = ['hotel', 'flight', 'train', 'bus'];

export class CompanionMessageDto {
  @IsString()
  @MaxLength(2000)
  message!: string;

  /** Continues an existing conversation thread; omit to start a new one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  // Structured trip-planning fields, all-or-nothing: the Supervisor Agent
  // does no natural-language date/destination extraction, so a full-trip
  // request is only recognized when a client supplies these explicitly
  // (e.g. from a destination picker + date range UI) alongside the
  // free-text message - see src/agents/supervisor-agent.ts.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  destinationSlug?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  interests?: string[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  // Free-text place names the traveler explicitly wants included
  // (Phase 3). Extraction from prose into this array is NOT done by
  // this system yet - a client (or a future NLP layer) supplies it
  // directly; the Planning Agent then resolves each name deterministically
  // against known places (src/travel-intelligence/must-visit.ts). Only
  // meaningful alongside destinationSlug/startDate/endDate.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  mustVisit?: string[];

  // Structured hotel-comparison trigger (Phase 4) - presence alone
  // routes to the Comparison Agent (src/agents/supervisor-agent.ts)
  // with domains=['hotel'] when `comparisonDomains` is not supplied.
  // Deliberately flat, like every other structured field here - no
  // nested-object DTO validation is introduced for this.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hotelSearchLocation?: string;

  // Structured transport-comparison criteria (Phase 5) - both required
  // together whenever a transport domain is requested; validated by the
  // Comparison Agent itself (src/agents/comparison-agent.ts), not here,
  // so the error message stays centralized in one place.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  transportOrigin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  transportDestination?: string;

  // Explicit domain set for a comparison request (Phase 5) - the only
  // way to request more than 'hotel', or any combination of domains, in
  // one comparison. No NLP inference of which domains were meant; the
  // client states them directly. Omitting this while supplying
  // hotelSearchLocation preserves Phase 4's exact ['hotel']-only
  // behavior unchanged.
  @IsOptional()
  @IsArray()
  @IsIn(DOMAIN_VALUES, { each: true })
  @ArrayMaxSize(4)
  comparisonDomains?: Domain[];

  // Structured cancellation-policy lookup trigger (Phase 5) - the
  // offerId to look up within the conversation's latest completed
  // comparison task (src/tasks/get-cancellation-policy.ts). Deterministic
  // dispatch, same as every other structured field here - never an LLM
  // intent classifier.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cancellationPolicyOfferId?: string;
}
