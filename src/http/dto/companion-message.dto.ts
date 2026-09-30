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

  // Structured booking-intent trigger (Phase 6) - the offerId to
  // prepare a booking intent for (src/booking/booking-intent.ts). Never
  // inferred from free text like "book this".
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bookingOfferId?: string;

  // Structured booking-confirmation trigger (Phase 6) - the EXACT
  // taskId a prior booking-intent response returned. This is the
  // explicit confirmation mechanism itself (plan §I) - a UUID, not a
  // free-text "yes".
  @IsOptional()
  @IsUUID()
  confirmBookingTaskId?: string;

  // Structured booking-execution trigger (Phase 7) - the EXACT taskId of
  // an already-CONFIRMED booking intent (src/agents/booking-agent.ts).
  // Never inferred from free text; the Booking Agent itself re-verifies
  // bookingStatus === 'confirmed' regardless of routing, so this field
  // alone can never execute an unconfirmed or merely-prepared booking.
  @IsOptional()
  @IsUUID()
  executeBookingTaskId?: string;

  // Structured cancellation-request trigger (Phase 8) - the EXACT id of
  // an existing `bookings` row to cancel (src/agents/cancellation-agent.ts).
  // Never inferred from hotel/provider name or free text like "cancel
  // it" - the booking must be identified by its own stable id.
  @IsOptional()
  @IsUUID()
  cancelBookingId?: string;

  // Structured cancellation-confirmation trigger (Phase 8) - the EXACT
  // taskId a prior cancellation-request response returned. This is the
  // explicit confirmation mechanism itself, mirroring
  // confirmBookingTaskId - never satisfied by "yes", "confirm", "go
  // ahead", or any other free text. Confirming also executes the
  // cancellation in the same request (see supervisor-agent.ts) - the
  // architecture's own cancellation flow goes directly from explicit
  // confirmation to the Cancellation Agent/WriteProvider, unlike
  // booking's separate confirm/execute steps.
  @IsOptional()
  @IsUUID()
  confirmCancellationTaskId?: string;

  // Structured rebooking-request trigger (Phase 9) - the EXACT id of an
  // existing hotel `bookings` row to cancel-and-rebook, paired with a
  // new search location for the fresh quote (src/agents/rebooking-agent.ts).
  // Never inferred from free text; both fields are required together,
  // mirroring the existing hotelSearchLocation/transportOrigin pairing
  // convention.
  @IsOptional()
  @IsUUID()
  rebookBookingId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rebookLocation?: string;

  // Structured rebooking-confirmation trigger (Phase 9) - the EXACT
  // taskId a prior rebooking-request response returned. Confirms AND
  // executes the whole cancel-and-rebook composite in one request -
  // never satisfied by "cancel it"/"yes"/"go ahead"/any other free
  // text, and never a second, separate confirmation for the new
  // booking half (plan §I).
  @IsOptional()
  @IsUUID()
  confirmRebookingTaskId?: string;
}
