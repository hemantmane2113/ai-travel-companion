import { ArrayMaxSize, IsArray, IsDateString, IsString, MaxLength } from 'class-validator';

export class CreateItineraryDto {
  @IsString()
  @MaxLength(100)
  destinationSlug!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  interests!: string[];

  // Format-only check here (ISO date string); range/duration validation
  // (end >= start, reasonable length) is a business rule, not a shape
  // rule, so it lives in trip-dates.ts instead of a class-validator
  // decorator.
  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;
}
