import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class CreateItineraryDto {
  @IsString()
  @MaxLength(100)
  destinationSlug!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  interests!: string[];
}
