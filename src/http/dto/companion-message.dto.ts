import { ArrayMaxSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CompanionMessageDto {
  @IsString()
  @MaxLength(2000)
  message!: string;

  /** Continues an existing conversation thread; omit to start a new one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  // Structured trip-planning fields, all-or-nothing: the Phase 2
  // Supervisor does no natural-language date/destination extraction, so
  // a full-trip request is only recognized when a client supplies these
  // explicitly (e.g. from a destination picker + date range UI)
  // alongside the free-text message - see src/companion/supervisor.ts.
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
}
