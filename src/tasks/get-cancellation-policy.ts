import type { Pool } from 'pg';
import { getLatestTaskForConversation } from './tasks';
import { retrieveKnowledge } from '../knowledge/retrieve-knowledge';

export type CancellationPolicyStatus = 'known' | 'unavailable';
export type CancellationPolicySource = 'structured_offer_field' | 'knowledge_retrieval';

export interface CancellationPolicyResult {
  status: CancellationPolicyStatus;
  policy: string | null;
  provider: string | null;
  source: CancellationPolicySource | null;
  retrievedAt: string | null;
}

const UNAVAILABLE: CancellationPolicyResult = { status: 'unavailable', policy: null, provider: null, source: null, retrievedAt: null };
const CANCELLATION_POLICY_CATEGORY = 'cancellation_policy';

/**
 * The standalone `getCancellationPolicy` tool (V2 architecture Phase
 * 5/6, docs/architecture-v2-agent-companion.md §D): provider/domain-
 * agnostic at its public boundary - it takes an offerId and looks it
 * up, with no idea in advance whether that offer is a hotel or a
 * transport offer. Usable directly by Q&A and, unchanged, by a future
 * Booking Management/Cancellation Agent (not implemented yet).
 *
 * Priority, per the architecture (Phase 6 §5):
 *   1. The structured `cancellationPolicy` field already on the
 *      persisted offer (today, only hotel offers carry one) - this
 *      alone is "known", exactly as it was in Phase 5.
 *   2. RAG knowledge retrieval, queried by the offer's own provider
 *      name, scoped to the 'cancellation_policy' category - only when
 *      the structured field is absent.
 *   3. 'unavailable' - never fabricated.
 *
 * The RAG hit's own retrieved content is returned VERBATIM as `policy`
 * (no LLM synthesis step here) - this tool was already fully
 * deterministic before Phase 6, and returning the retrieved document's
 * own text is strictly more honest than paraphrasing it, so there is
 * nothing for an LLM synthesis step to add; the grounding rules for
 * LLM-narrated knowledge (src/ai/knowledge-narration.ts) apply only
 * where synthesis actually happens, which is not here.
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

  if (provider) {
    const documents = await retrieveKnowledge(pool, provider, { category: CANCELLATION_POLICY_CATEGORY });
    if (documents.length > 0) {
      const top = documents[0];
      return {
        status: 'known',
        policy: top.content,
        provider,
        source: 'knowledge_retrieval',
        retrievedAt: top.retrievedAt,
      };
    }
  }

  return { status: 'unavailable', policy: null, provider, source: null, retrievedAt: null };
}
