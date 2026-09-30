import { ArrayMaxSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
  // routes to the Comparison Agent (src/agents/supervisor-agent.ts).
  // Deliberately flat, like every other structured field here - no
  // nested-object DTO validation is introduced for this.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hotelSearchLocation?: string;
}
