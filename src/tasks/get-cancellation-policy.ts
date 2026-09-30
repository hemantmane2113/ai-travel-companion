import type { Pool } from 'pg';
import { getLatestTaskForConversation } from './tasks';

export type CancellationPolicyStatus = 'known' | 'unavailable';

export interface CancellationPolicyResult {
  status: CancellationPolicyStatus;
  policy: string | null;
  provider: string | null;
  /** Only ever 'structured_offer_field' today - the RAG fallback the architecture describes for genuinely unstructured policy text doesn't exist yet (no policy documents are ingested anywhere in this repository), so it is never claimed. */
  source: 'structured_offer_field' | null;
  retrievedAt: string | null;
}

const UNAVAILABLE: CancellationPolicyResult = { status: 'unavailable', policy: null, provider: null, source: null, retrievedAt: null };

/**
 * The standalone `getCancellationPolicy` tool (V2 architecture Phase 5,
 * docs/architecture-v2-agent-companion.md §D): provider/domain-agnostic
 * at its public boundary - it takes an offerId and looks it up, with no
 * idea in advance whether that offer is a hotel or a transport offer.
 * Usable directly by Q&A (this phase) and, unchanged, by a future
 * Booking Management/Cancellation Agent (not implemented this phase).
 *
 * Strategy, per the architecture: prefer a structured field when the
 * offer carries one (today, only NormalizedHotelOffer.cancellationPolicy
 * does - Phase 5's transport offers deliberately carry no such field,
 * see providers/transport-provider.ts). RAG is the architecture's
 * documented fallback for genuinely unstructured policy text, but no
 * policy-document retrieval exists anywhere in this repository yet, so
 * it is never invoked and never claimed as the source - an offer with no
 * structured field honestly reports 'unavailable', never a fabricated
 * policy.
 *
 * Reads only the conversation's persisted comparison task (never a
 * fresh provider call) - the same "trust only what was actually
 * persisted" discipline src/agents/ordinal-resolution.ts already
 * established for offer selection.
 */
export async function getCancellationPolicy(
  pool: Pool,
  conversationId: string,
  offerId: string,
): Promise<CancellationPolicyResult> {
  const task = await getLatestTaskForConversation(pool, conversationId, 'comparison');
  if (!task || task.status !== 'complete' || !task.result) {
    return UNAVAILABLE;
  }

  const offers = (task.result as { offers?: unknown[] }).offers;
  if (!Array.isArray(offers)) {
    return UNAVAILABLE;
  }

  const offer = offers.find((o) => (o as { offerId?: unknown }).offerId === offerId) as
    | { provider?: unknown; cancellationPolicy?: unknown; retrievedAt?: unknown }
    | undefined;
  if (!offer) {
    return UNAVAILABLE;
  }

  const provider = typeof offer.provider === 'string' ? offer.provider : null;

  if (typeof offer.cancellationPolicy === 'string') {
    return {
      status: 'known',
      policy: offer.cancellationPolicy,
      provider,
      source: 'structured_offer_field',
      retrievedAt: typeof offer.retrievedAt === 'string' ? offer.retrievedAt : null,
    };
  }

  return { status: 'unavailable', policy: null, provider, source: null, retrievedAt: null };
}
