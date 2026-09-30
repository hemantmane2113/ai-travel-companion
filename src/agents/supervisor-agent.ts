import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import type { Domain } from '../providers/hotel-provider';
import type { WriteProvider } from '../providers/write-provider';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';
import { planTrip } from './planning-agent';
import { runComparison, type ComparisonProviders, type ComparisonTaskResult } from './comparison-agent';
import { parseOrdinal } from './ordinal-resolution';
import { answerQuestion } from '../companion/answer-question';
import { appendMessage, createConversation, requireConversation } from '../companion/conversations';
import { getLatestTaskForConversation } from '../tasks/tasks';
import { getCancellationPolicy, type CancellationPolicyResult } from '../tasks/get-cancellation-policy';
import { createBookingIntent, confirmBookingIntent, type BookingIntentResult } from '../booking/booking-intent';
import { executeBookingIntent } from './booking-agent';
import { createCancellationIntent, confirmCancellationIntent, executeCancellationIntent, type CancellationIntentResult } from './cancellation-agent';
import type { BookingRow } from '../booking/bookings';

export interface CompanionInput {
  message: string;
  conversationId?: string;
  destinationSlug?: string;
  interests?: string[];
  startDate?: string;
  endDate?: string;
  /** Free-text must-visit place names (Phase 3) - resolved deterministically by the Planning Agent, never guessed here. */
  mustVisit?: string[];
  /** Structured hotel-comparison criteria (Phase 4). Presence alone routes to the Comparison Agent when `comparisonDomains` is not supplied - implies domains=['hotel'], preserving Phase 4's exact behavior. */
  hotelSearchLocation?: string;
  /** Structured transport-comparison criteria (Phase 5) - required together when any transport domain is requested. */
  transportOrigin?: string;
  transportDestination?: string;
  /**
   * Explicit domain set for a comparison request (Phase 5) - the ONLY
   * way to request more than 'hotel', or a combination of domains, in
   * one comparison. No NLP inference of "which domains were meant" -
   * the client states them directly, mirroring how `mustVisit` is
   * client-supplied rather than extracted from prose. When omitted,
   * falls back to `hotelSearchLocation` alone implying ['hotel'].
   */
  comparisonDomains?: Domain[];
  /** Structured cancellation-policy lookup trigger (Phase 5) - the offerId to look up within the conversation's latest completed comparison task. */
  cancellationPolicyOfferId?: string;
  /** Structured booking-intent trigger (Phase 6) - the offerId (from the conversation's latest completed comparison task) to prepare a booking intent for. Never inferred from free text like "book this". */
  bookingOfferId?: string;
  /** Structured booking-confirmation trigger (Phase 6) - the EXACT taskId a prior booking-intent response returned. This exact-id requirement IS the explicit confirmation mechanism (plan §I) - never inferred from sentiment, and never satisfied by anything else. */
  confirmBookingTaskId?: string;
  /** Structured booking-execution trigger (Phase 7) - the EXACT taskId of an already-CONFIRMED booking intent. Dispatches to the Booking Agent (src/agents/booking-agent.ts), which re-verifies confirmation itself regardless of this route being reached. Never inferred from free text. */
  executeBookingTaskId?: string;
  /** Structured cancellation-request trigger (Phase 8) - the EXACT id of an existing `bookings` row to cancel. Never inferred from hotel/provider name or free text. */
  cancelBookingId?: string;
  /** Structured cancellation-confirmation trigger (Phase 8) - the EXACT taskId a prior cancellation-request response returned. Confirms AND executes the cancellation in one route (src/agents/cancellation-agent.ts) - never inferred from "cancel it"/"yes"/"go ahead". */
  confirmCancellationTaskId?: string;
}

export type CompanionResult =
  | { route: 'full_trip'; conversationId: string; jobId: string }
  | { route: 'qa'; conversationId: string; answer: string }
  | { route: 'comparison'; conversationId: string; taskId: string; result: ComparisonTaskResult }
  | { route: 'cancellation_policy'; conversationId: string; result: CancellationPolicyResult }
  | { route: 'booking_intent'; conversationId: string; result: BookingIntentResult }
  | { route: 'booking_confirmed'; conversationId: string; result: BookingIntentResult }
  | { route: 'booking_executed'; conversationId: string; result: BookingRow }
  | { route: 'cancellation_intent'; conversationId: string; result: CancellationIntentResult }
  | { route: 'cancellation_executed'; conversationId: string; result: BookingRow }
  | {
      route: 'ordinal_selection';
      conversationId: string;
      selectedOfferId: string;
      provider: string;
      domain: Domain;
    };

/**
 * Resolves "the second one" (V2 architecture Phase 4 §J) against the
 * conversation's most recent COMPLETE comparison task - never a fresh
 * provider search, never LLM memory. Intentionally the smallest
 * possible mechanism: exact ordinal parse (src/agents/ordinal-resolution.ts)
 * -> exact array-index lookup into the persisted `tasks.result.offers`,
 * which (Phase 5) may now be a domain-mixed list - the offer's own
 * `domain` field (present on every persisted offer regardless of
 * domain) is what lets a caller distinguish "hotel offer #1" from
 * "flight offer #2" purely from the returned identity, unchanged from
 * how this function already worked in Phase 4.
 * Ambiguity, an out-of-range ordinal, or no open comparison task all
 * throw a plain Error rather than guessing - same clarify-don't-guess
 * posture Phase 3's must-visit resolution already established, and the
 * same "throw, let the HTTP layer translate to 400" pattern.
 */
async function resolveOrdinalSelection(
  pool: Pool,
  conversationId: string,
  ordinalIndex: number,
): Promise<Extract<CompanionResult, { route: 'ordinal_selection' }>> {
  const task = await getLatestTaskForConversation(pool, conversationId, 'comparison');
  if (!task || task.status !== 'complete' || !task.result) {
    throw new Error(
      "I don't have a completed comparison in this conversation to select from - try comparing hotels or transport first.",
    );
  }

  const result = task.result as unknown as ComparisonTaskResult;
  if (ordinalIndex >= result.offers.length) {
    throw new Error(
      `There is no option #${ordinalIndex + 1} in the last comparison - it only had ${result.offers.length} offer(s).`,
    );
  }

  const offer = result.offers[ordinalIndex];
  return {
    route: 'ordinal_selection',
    conversationId,
    selectedOfferId: offer.offerId,
    provider: offer.provider,
    domain: offer.domain,
  };
}

/**
 * The Supervisor Agent (docs/architecture-v2-agent-companion.md §C):
 * a deterministic-first router. Routing is decided purely by structured
 * signals - field presence for full-trip/comparison/cancellation-policy/
 * booking, an exact ordinal pattern for a follow-up selection - never
 * fuzzy keyword or LLM classification of the message text (still out of
 * scope, per plan §G's hybrid router: deterministic first, LLM fallback
 * only for genuine ambiguity, not yet needed while every route has an
 * unambiguous structured signal).
 *
 * This module intentionally does no travel/comparison/booking reasoning
 * of its own, contains no domain-specific (hotel/flight/train/bus)
 * logic, and never calls a provider directly - it selects a capability
 * (Planning Agent, Comparison Agent, cancellation-policy tool, booking
 * intent/confirmation, ordinal resolution, or the Q&A tool) and
 * dispatches to it, nothing more. Booking CONFIRMATION (Phase 6) is
 * deliberately the only route requiring an exact, previously-issued
 * identifier (`confirmBookingTaskId`) rather than any free-text signal -
 * this is the explicit confirmation boundary itself, not a convenience.
 *
 * Route priority: full trip > comparison > cancellation policy (offer
 * lookup) > confirm booking > execute booking > confirm+execute
 * cancellation > create cancellation intent > create booking intent >
 * ordinal follow-up > Q&A. All but Q&A are structured/pattern signals
 * checked in that fixed order; Q&A is the default when none matches.
 *
 * Note the two distinctly-named, unrelated "cancellation" routes:
 * `cancellationPolicyOfferId` (Phase 5/6) looks up a policy for a
 * COMPARISON offer, before any booking exists; `cancelBookingId`/
 * `confirmCancellationTaskId` (Phase 8) cancel an existing, already-
 * executed `bookings` row. They operate on different objects and never
 * overlap.
 */
export async function routeMessage(
  pool: Pool,
  llmProvider: LlmProvider,
  input: CompanionInput,
  /** Injectable for testability - see comparison-agent.ts's RunComparisonInput.providers. Omit to use each domain's own default (mocked) provider. */
  comparisonProviders?: ComparisonProviders,
  /** Injectable - omit to skip rate limiting entirely. */
  rateLimiter?: ProviderRateLimiter,
  /** The Booking Agent's WriteProvider (Phase 7). Required only when `executeBookingTaskId` is actually supplied - omitted in every test/route that never reaches that branch. Deliberately NOT defaulted to a freshly-constructed provider here: a fresh instance would have an empty idempotency cache, silently weakening the provider-side idempotency guarantee (plan §I) that only holds if the SAME provider instance is reused across requests (src/http/core.module.ts registers it as a singleton for exactly this reason). */
  writeProvider?: WriteProvider,
): Promise<CompanionResult> {
  const conversationId = input.conversationId
    ? await requireConversation(pool, input.conversationId)
    : await createConversation(pool);

  await appendMessage(pool, conversationId, 'user', input.message);

  const isFullTripRequest = Boolean(input.destinationSlug && input.startDate && input.endDate);

  if (isFullTripRequest) {
    const { jobId } = await planTrip(pool, llmProvider, {
      destinationSlug: input.destinationSlug!,
      interests: input.interests ?? [],
      startDate: input.startDate!,
      endDate: input.endDate!,
      mustVisit: input.mustVisit,
    });

    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `I'm planning your trip now - check job ${jobId} for progress.`,
      { route: 'full_trip', jobId },
    );

    return { route: 'full_trip', conversationId, jobId };
  }

  // The explicit domain set (when supplied) is authoritative; omitting
  // it while supplying hotelSearchLocation preserves Phase 4's exact
  // behavior (domains=['hotel']) unchanged.
  const requestedDomains: Domain[] =
    input.comparisonDomains && input.comparisonDomains.length > 0
      ? input.comparisonDomains
      : input.hotelSearchLocation
        ? ['hotel']
        : [];

  if (requestedDomains.length > 0) {
    const { taskId, result } = await runComparison(pool, llmProvider, {
      domains: requestedDomains,
      conversationId,
      location: input.hotelSearchLocation,
      origin: input.transportOrigin,
      destination: input.transportDestination,
      providers: comparisonProviders,
      rateLimiter,
    });

    await appendMessage(pool, conversationId, 'assistant', result.narrative, { route: 'comparison', taskId });

    return { route: 'comparison', conversationId, taskId, result };
  }

  if (input.cancellationPolicyOfferId) {
    const result = await getCancellationPolicy(pool, conversationId, input.cancellationPolicyOfferId);
    const text =
      result.status === 'known'
        ? `Cancellation policy (via ${result.provider}): ${result.policy}`
        : "I don't have a cancellation policy on file for that offer.";

    await appendMessage(pool, conversationId, 'assistant', text, {
      route: 'cancellation_policy',
      status: result.status,
    });

    return { route: 'cancellation_policy', conversationId, result };
  }

  if (input.confirmBookingTaskId) {
    const result = await confirmBookingIntent(pool, conversationId, input.confirmBookingTaskId);
    await appendMessage(pool, conversationId, 'assistant', `Confirmed - booking ${result.taskId} for ${result.selectedOffer.provider}.`, {
      route: 'booking_confirmed',
      taskId: result.taskId,
    });
    return { route: 'booking_confirmed', conversationId, result };
  }

  if (input.executeBookingTaskId) {
    if (!writeProvider) {
      throw new Error('No booking write provider is configured - cannot execute a booking.');
    }
    const result = await executeBookingIntent(pool, writeProvider, conversationId, input.executeBookingTaskId);
    const text =
      result.status === 'booked'
        ? `Booked! Your ${result.provider} booking reference is ${result.externalBookingId}.`
        : result.status === 'failed'
          ? `I wasn't able to complete this booking with ${result.provider} - it has not been booked.`
          : `Your booking with ${result.provider} is still being processed.`;
    await appendMessage(pool, conversationId, 'assistant', text, {
      route: 'booking_executed',
      bookingId: result.id,
      status: result.status,
    });
    return { route: 'booking_executed', conversationId, result };
  }

  if (input.confirmCancellationTaskId) {
    if (!writeProvider) {
      throw new Error('No booking write provider is configured - cannot execute a cancellation.');
    }
    await confirmCancellationIntent(pool, conversationId, input.confirmCancellationTaskId);
    const result = await executeCancellationIntent(pool, writeProvider, conversationId, input.confirmCancellationTaskId);
    const text =
      result.status === 'cancelled'
        ? `Your ${result.provider} booking has been cancelled.`
        : `I wasn't able to complete this cancellation with ${result.provider} - your booking remains active.`;
    await appendMessage(pool, conversationId, 'assistant', text, {
      route: 'cancellation_executed',
      bookingId: result.id,
      status: result.status,
    });
    return { route: 'cancellation_executed', conversationId, result };
  }

  if (input.cancelBookingId) {
    const result = await createCancellationIntent(pool, conversationId, input.cancelBookingId);
    const consequenceText =
      result.consequences.refundStatus === 'unavailable'
        ? "I don't have enough information to calculate a refund amount, but here is the cancellation policy."
        : '';
    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `Cancellation policy (via ${result.provider}): ${result.policy.policy ?? 'unavailable'}. ${consequenceText} Reply with confirmCancellationTaskId "${result.taskId}" to confirm.`,
      { route: 'cancellation_intent', taskId: result.taskId },
    );
    return { route: 'cancellation_intent', conversationId, result };
  }

  if (input.bookingOfferId) {
    const result = await createBookingIntent(pool, conversationId, input.bookingOfferId);
    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `I've prepared this booking (${result.selectedOffer.provider}, ${result.selectedOffer.price} ${result.selectedOffer.currency}) - reply with confirmBookingTaskId "${result.taskId}" to confirm.`,
      { route: 'booking_intent', taskId: result.taskId },
    );
    return { route: 'booking_intent', conversationId, result };
  }

  const ordinalParse = parseOrdinal(input.message);

  if (ordinalParse.kind === 'ambiguous') {
    throw new Error('I\'m not sure which option you mean - please refer to just one, like "the second one".');
  }

  if (ordinalParse.kind === 'resolved') {
    const selection = await resolveOrdinalSelection(pool, conversationId, ordinalParse.index);
    await appendMessage(
      pool,
      conversationId,
      'assistant',
      `Got it - you selected ${selection.provider}'s offer (${selection.selectedOfferId}).`,
      { route: 'ordinal_selection', selectedOfferId: selection.selectedOfferId },
    );
    return selection;
  }

  const { text, matchedDestinationSlug } = await answerQuestion(pool, llmProvider, input.message);
  await appendMessage(pool, conversationId, 'assistant', text, { route: 'qa', matchedDestinationSlug });

  return { route: 'qa', conversationId, answer: text };
}
