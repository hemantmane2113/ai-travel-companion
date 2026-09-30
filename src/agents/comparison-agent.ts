import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { narrateComparison } from '../ai/comparison-narration';
import { searchHotels } from '../hotels/search-hotels';
import { compareHotelOffers, type HotelComparisonResult } from '../hotels/compare-hotels';
import { MockHotelProvider } from '../providers/mock-hotel-provider';
import type { Domain, HotelProvider, NormalizedHotelOffer } from '../providers/hotel-provider';
import { createTask, completeTask, failTask, markTaskProcessing } from '../tasks/tasks';

export type { Domain };

export interface RunComparisonInput {
  domains: Domain[];
  location: string;
  conversationId: string;
  /**
   * Injectable for testability (provider-failure isolation at every
   * layer, including HTTP e2e via the HOTEL_PROVIDERS DI token) -
   * defaults to the single mocked provider. Not part of the DTO/wire
   * format (plan §K's flat hotelSearchLocation trigger is unaffected);
   * this is purely how the agent's own HotelProvider[] gets supplied.
   */
  providers?: HotelProvider[];
}

/** A persisted/returned offer never carries `raw` (plan §C/§K: provider-specific payloads never leave the provider adapter boundary). */
export type PersistedHotelOffer = Omit<NormalizedHotelOffer, 'raw'>;

export interface ComparisonTaskResult {
  domains: Domain[];
  location: string;
  /** Ordered exactly as used for `comparison` - this ordering is load-bearing for ordinal follow-up resolution (plan §J). */
  offers: PersistedHotelOffer[];
  comparison: Omit<HotelComparisonResult, 'offers'>;
  narrative: string;
  fellBackToDeterministic: boolean;
  failedProviders: string[];
}

export interface ComparisonAgentResult {
  taskId: string;
  conversationId: string;
  result: ComparisonTaskResult;
}

const SUPPORTED_DOMAINS: ReadonlySet<Domain> = new Set<Domain>(['hotel']);

function stripRaw(offer: NormalizedHotelOffer): PersistedHotelOffer {
  const { raw, ...rest } = offer;
  return rest;
}

/**
 * The Comparison Agent (V2 architecture Phase 4,
 * docs/architecture-v2-agent-companion.md §C/§D/§E): accepts a
 * domain SET (never a scalar - §12) even though only 'hotel' has a real
 * provider today, so a future 'flight'/'train'/'bus' addition extends
 * this same contract rather than requiring a rewrite or a second agent.
 *
 * Pipeline: validate domains -> searchHotels (tool, provider fan-out) ->
 * compareHotelOffers (deterministic service, authoritative) ->
 * narrateComparison (optional LLM, fail-soft) -> persist ordered result
 * to `tasks.result` -> return. This module touches Postgres only via
 * `tasks.ts` and never calls a provider directly - it delegates search
 * to the hotels tool and comparison to the deterministic service,
 * exactly the "agents orchestrate; deterministic services execute"
 * split CLAUDE.md §3 requires.
 */
export async function runComparison(
  pool: Pool,
  llmProvider: LlmProvider,
  input: RunComparisonInput,
): Promise<ComparisonAgentResult> {
  const unsupported = input.domains.filter((d) => !SUPPORTED_DOMAINS.has(d));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported comparison domain(s): ${unsupported.join(', ')}. Only 'hotel' is supported in this phase.`);
  }
  if (input.domains.length === 0) {
    throw new Error('At least one comparison domain must be requested.');
  }

  const taskId = await createTask(pool, input.conversationId, 'comparison');

  try {
    await markTaskProcessing(pool, taskId);

    // Only 'hotel' can reach here today (validated above) - the mock
    // provider stands in for a real/sandbox HotelProvider (CLAUDE.md
    // §25's mocked/sandbox/real distinction). searchHotels already
    // accepts HotelProvider[], so registering a second real provider
    // later needs no signature change here.
    const providers = input.providers ?? [new MockHotelProvider()];
    const { offers, failedProviders } = await searchHotels(providers, {
      location: input.location,
    });

    const comparison = compareHotelOffers(offers);
    const offersById = new Map(offers.map((o) => [o.offerId, o]));
    const orderedOffers = comparison.offers.map((co) => stripRaw(offersById.get(co.offerId)!));

    const { narrative, fellBackToDeterministic } = await narrateComparison(llmProvider, comparison);

    const { offers: _comparedOffers, ...comparisonWithoutOffers } = comparison;
    const result: ComparisonTaskResult = {
      domains: input.domains,
      location: input.location,
      offers: orderedOffers,
      comparison: comparisonWithoutOffers,
      narrative,
      fellBackToDeterministic,
      failedProviders,
    };

    await completeTask(pool, taskId, result);

    return { taskId, conversationId: input.conversationId, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(pool, taskId, message);
    throw err;
  }
}
