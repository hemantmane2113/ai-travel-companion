import type { Pool } from 'pg';
import { retrieveKnowledge } from '../knowledge/retrieve-knowledge';
import type { BookingRow } from './bookings';

export type CancellationPolicyStatus = 'known' | 'unavailable';
export type CancellationPolicySource = 'structured_offer_field' | 'knowledge_retrieval';

export interface BookingCancellationPolicy {
  status: CancellationPolicyStatus;
  policy: string | null;
  source: CancellationPolicySource | null;
}

const CANCELLATION_POLICY_CATEGORY = 'cancellation_policy';

/**
 * The booking-scoped cancellation-policy lookup (V2 architecture Phase
 * 8/§6). Deliberately NOT a reuse of src/tasks/get-cancellation-policy.ts
 * unchanged - that tool resolves an offerId against the CONVERSATION's
 * latest comparison task, which may no longer exist or may no longer be
 * "latest" by the time a booking is cancelled. This applies the exact
 * SAME two-tier priority (structured field on the booking's own
 * persisted offer snapshot -> RAG knowledge retrieval by provider name,
 * scoped to the same 'cancellation_policy' category -> 'unavailable'),
 * just sourced from the `bookings` row instead - never a second
 * grounding/retrieval mechanism, the same `retrieveKnowledge` primitive.
 *
 * `offerSnapshot.cancellationPolicy` was itself copied verbatim from the
 * comparison offer at booking-intent-creation time (Phase 6) and carried
 * unchanged through execution (Phase 7), so this is still "trust only
 * what was actually persisted" - never a fresh provider call.
 */
export async function getCancellationPolicyForBooking(pool: Pool, booking: BookingRow): Promise<BookingCancellationPolicy> {
  if (booking.offerSnapshot.cancellationPolicy) {
    return { status: 'known', policy: booking.offerSnapshot.cancellationPolicy, source: 'structured_offer_field' };
  }

  const documents = await retrieveKnowledge(pool, booking.provider, { category: CANCELLATION_POLICY_CATEGORY });
  if (documents.length > 0) {
    return { status: 'known', policy: documents[0].content, source: 'knowledge_retrieval' };
  }

  return { status: 'unavailable', policy: null, source: null };
}

export interface CancellationConsequences {
  policy: string | null;
  policyKnown: boolean;
  /** Always null in this phase - no structured fee field exists anywhere in this codebase's data model (only a free-text cancellationPolicy string). Never estimated/parsed from prose. */
  fee: number | null;
  /** Always null for the same reason as `fee`. */
  refund: number | null;
  currency: string;
  /** Always 'unavailable' in this phase - see `fee`/`refund`. Kept as its own explicit field (rather than just implying it from fee/refund being null) so this honestly-reported limitation is visible and directly testable, not just an accidental absence. */
  refundStatus: 'unavailable';
  /** Always null - no structured deadline field exists (the policy is a free-text string that may mention a deadline in prose, but this system never parses it out). */
  deadline: string | null;
}

/**
 * Deterministic cancellation-consequence calculation (V2 architecture
 * Phase 8/§7). Never asks the LLM to compute a refund/fee (CLAUDE.md
 * §19/§21) - and, just as importantly, never estimates one itself: this
 * codebase's data model has no structured fee/refund/deadline field
 * anywhere (confirmed by audit - hotel offers carry only a free-text
 * `cancellationPolicy` string; transport offers carry none at all), so
 * honestly reporting `refundStatus: 'unavailable'` is not a shortcut -
 * it is the only correct behavior available, matching the instruction
 * "if the available data is insufficient to calculate a refund, return
 * refund: unavailable rather than estimating."
 */
export function calculateCancellationConsequences(
  policy: BookingCancellationPolicy,
  booking: Pick<BookingRow, 'offerSnapshot'>,
): CancellationConsequences {
  return {
    policy: policy.policy,
    policyKnown: policy.status === 'known',
    fee: null,
    refund: null,
    currency: booking.offerSnapshot.currency,
    refundStatus: 'unavailable',
    deadline: null,
  };
}
