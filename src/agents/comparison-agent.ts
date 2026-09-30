import type { Pool } from 'pg';
import type { LlmProvider } from '../ai/llm-provider';
import { narrateComparison, type NarrationDomainSummary, type NarrationOfferSummary } from '../ai/comparison-narration';
import { searchHotels } from '../hotels/search-hotels';
import { compareHotelOffers } from '../hotels/compare-hotels';
import { searchFlights } from '../transport/search-flights';
import { searchTrains } from '../transport/search-trains';
import { searchBuses } from '../transport/search-buses';
import { compareTransportOffers } from '../transport/compare-transport';
import { MockHotelProvider } from '../providers/mock-hotel-provider';
import { MockFlightProvider } from '../providers/mock-flight-provider';
import { MockTrainProvider } from '../providers/mock-train-provider';
import { MockBusProvider } from '../providers/mock-bus-provider';
import type { Domain, HotelProvider, HotelSearchCriteria, NormalizedHotelOffer } from '../providers/hotel-provider';
import type {
  BusProvider,
  FlightProvider,
  NormalizedTransportOffer,
  TrainProvider,
  TransportDomain,
} from '../providers/transport-provider';
import type { ProviderRateLimiter } from '../rate-limit/provider-rate-limiter';
import { createTask, completeTask, failTask, markTaskProcessing } from '../tasks/tasks';

export type { Domain };

export interface ComparisonProviders {
  hotel?: HotelProvider[];
  flight?: FlightProvider[];
  train?: TrainProvider[];
  bus?: BusProvider[];
}

export interface RunComparisonInput {
  domains: Domain[];
  conversationId: string;
  /** Required when 'hotel' is among `domains`. */
  location?: string;
  /** Required when any transport domain is among `domains`. */
  origin?: string;
  destination?: string;
  /** Injectable for testability - defaults to each domain's single mocked provider. Not part of the DTO/wire format. */
  providers?: ComparisonProviders;
  /** Injectable - omit to skip rate limiting entirely (e.g. in a unit test that doesn't care about it). */
  rateLimiter?: ProviderRateLimiter;
}

/** A persisted/returned offer never carries `raw` (plan §C/§K: provider-specific payloads never leave the provider adapter boundary). */
export type PersistedHotelOffer = Omit<NormalizedHotelOffer, 'raw'>;
export type PersistedTransportOffer = Omit<NormalizedTransportOffer, 'raw'>;
export type PersistedOffer = PersistedHotelOffer | PersistedTransportOffer;

export interface ComparisonCriteria {
  location?: string;
  origin?: string;
  destination?: string;
}

export interface DomainComparisonSummary {
  domain: Domain;
  cheapestOfferId: string | null;
  mostExpensiveOfferId: string | null;
  availableCount: number;
  unavailableCount: number;
  providerGroups: Record<string, string[]>;
  /** Only meaningful for a transport domain - undefined for 'hotel'. */
  shortestDurationOfferId?: string | null;
  longestDurationOfferId?: string | null;
}

export interface ComparisonTaskResult {
  domains: Domain[];
  criteria: ComparisonCriteria;
  /** Merged across every requested domain, domain-grouped in the order `domains` was requested, each domain's own offers internally price-ordered. This ordering is load-bearing for ordinal follow-up resolution (plan §J) and distinguishes "hotel offer #1" from "flight offer #2" purely by position + each offer's own `domain` field. */
  offers: PersistedOffer[];
  /** One entry per requested domain, same order as `domains`. */
  comparison: DomainComparisonSummary[];
  narrative: string;
  fellBackToDeterministic: boolean;
  /** Merged across every domain's own provider fan-out (deduplicated) - a provider failing in one domain never removes another domain's results from this list or from `offers`. */
  failedProviders: string[];
}

export interface ComparisonAgentResult {
  taskId: string;
  conversationId: string;
  result: ComparisonTaskResult;
}

const SUPPORTED_DOMAINS: ReadonlySet<Domain> = new Set<Domain>(['hotel', 'flight', 'train', 'bus']);

function stripRaw<T extends { raw: unknown }>(offer: T): Omit<T, 'raw'> {
  const { raw, ...rest } = offer;
  return rest;
}

interface DomainRunResult {
  offers: PersistedOffer[];
  summary: DomainComparisonSummary;
  failedProviders: string[];
}

async function runHotelDomain(input: RunComparisonInput): Promise<DomainRunResult> {
  const providers = input.providers?.hotel ?? [new MockHotelProvider()];
  const { offers, failedProviders } = await searchHotels(providers, { location: input.location! }, input.rateLimiter);

  const comparison = compareHotelOffers(offers);
  const offersById = new Map(offers.map((o) => [o.offerId, o]));
  const orderedOffers = comparison.offers.map((co) => stripRaw(offersById.get(co.offerId)!));

  return {
    offers: orderedOffers,
    summary: {
      domain: 'hotel',
      cheapestOfferId: comparison.cheapestOfferId,
      mostExpensiveOfferId: comparison.mostExpensiveOfferId,
      availableCount: comparison.availableCount,
      unavailableCount: comparison.unavailableCount,
      providerGroups: comparison.providerGroups,
    },
    failedProviders,
  };
}

export interface SearchHotelOffersOnlyResult {
  offers: PersistedHotelOffer[];
  cheapestOfferId: string | null;
  failedProviders: string[];
}

/**
 * The search-only capability (V2 architecture Phase 9/§I): the Comparison
 * Agent's own fresh-quote step for the rebooking composite
 * (src/agents/rebooking-agent.ts) - the same two deterministic services
 * `runHotelDomain` already calls (`searchHotels` for provider fan-out,
 * `compareHotelOffers` for deterministic ranking), but WITHOUT the LLM
 * narration call or `tasks` persistence that wraps a full comparison
 * turn. Deliberately not a refactor of `runHotelDomain` - a few
 * duplicated lines here are safer than touching the already-tested
 * normal comparison flow, which remains completely unchanged.
 *
 * No LLM call. No `comparison`-type task is ever created by this
 * function - callers that need one still go through `runComparison`.
 */
export async function searchHotelOffersOnly(
  criteria: HotelSearchCriteria,
  providers?: HotelProvider[],
  rateLimiter?: ProviderRateLimiter,
): Promise<SearchHotelOffersOnlyResult> {
  const activeProviders = providers ?? [new MockHotelProvider()];
  const { offers, failedProviders } = await searchHotels(activeProviders, criteria, rateLimiter);

  const comparison = compareHotelOffers(offers);
  const offersById = new Map(offers.map((o) => [o.offerId, o]));
  const orderedOffers = comparison.offers.map((co) => stripRaw(offersById.get(co.offerId)!));

  return { offers: orderedOffers, cheapestOfferId: comparison.cheapestOfferId, failedProviders };
}

async function runTransportDomain(domain: TransportDomain, input: RunComparisonInput): Promise<DomainRunResult> {
  const criteria = { origin: input.origin!, destination: input.destination! };

  const { offers, failedProviders } = await (domain === 'flight'
    ? searchFlights(input.providers?.flight ?? [new MockFlightProvider()], criteria, input.rateLimiter)
    : domain === 'train'
      ? searchTrains(input.providers?.train ?? [new MockTrainProvider()], criteria, input.rateLimiter)
      : searchBuses(input.providers?.bus ?? [new MockBusProvider()], criteria, input.rateLimiter));

  const comparison = compareTransportOffers(offers);
  const offersById = new Map(offers.map((o) => [o.offerId, o]));
  const orderedOffers = comparison.offers.map((co) => stripRaw(offersById.get(co.offerId)!));

  return {
    offers: orderedOffers,
    summary: {
      domain,
      cheapestOfferId: comparison.cheapestOfferId,
      mostExpensiveOfferId: comparison.mostExpensiveOfferId,
      availableCount: comparison.availableCount,
      unavailableCount: comparison.unavailableCount,
      providerGroups: comparison.providerGroups,
      shortestDurationOfferId: comparison.shortestDurationOfferId,
      longestDurationOfferId: comparison.longestDurationOfferId,
    },
    failedProviders,
  };
}

function toNarrationOffers(domain: Domain, offers: PersistedOffer[]): NarrationOfferSummary[] {
  return offers.map((offer) => {
    const label =
      domain === 'hotel'
        ? (offer as PersistedHotelOffer).name
        : `${(offer as PersistedTransportOffer).operatorName} ${(offer as PersistedTransportOffer).vehicleNumber}`;
    const priceDeltaFromCheapest =
      'priceDeltaFromCheapest' in offer && typeof (offer as { priceDeltaFromCheapest?: unknown }).priceDeltaFromCheapest === 'number'
        ? (offer as { priceDeltaFromCheapest: number }).priceDeltaFromCheapest
        : null;
    return {
      offerId: offer.offerId,
      domain,
      provider: offer.provider,
      label,
      price: offer.price,
      currency: offer.currency,
      availability: offer.availability,
      priceDeltaFromCheapest,
    };
  });
}

/**
 * The Comparison Agent (V2 architecture Phase 4/5,
 * docs/architecture-v2-agent-companion.md §C/§D/§E): accepts a domain
 * SET (never a scalar - §12), now genuinely multi-domain in Phase 5
 * ('hotel' | 'flight' | 'train' | 'bus'). Every requested domain runs
 * independently (Promise.all - no domain's outcome depends on
 * another's) and is searched/compared/persisted through its own
 * dedicated tool + deterministic service; a provider failing within one
 * domain's own fan-out never discards another domain's results, because
 * each domain's search tool already isolates provider failures itself
 * (never throwing for that reason).
 *
 * Pipeline per domain: search tool (provider fan-out, rate-limited) ->
 * deterministic comparison service (authoritative) -> merge across
 * domains -> ONE narration call over the merged offer set (never one
 * call per domain) -> persist ordered result to `tasks.result` ->
 * return. This module touches Postgres only via `tasks.ts` and never
 * calls a provider directly - it delegates search to the domain's tool
 * and comparison to that domain's deterministic service, exactly the
 * "agents orchestrate; deterministic services execute" split CLAUDE.md
 * §3 requires. No domain-specific logic lives in the Supervisor - it is
 * entirely inside this agent and the domain tools it calls.
 */
export async function runComparison(
  pool: Pool,
  llmProvider: LlmProvider,
  input: RunComparisonInput,
): Promise<ComparisonAgentResult> {
  const unsupported = input.domains.filter((d) => !SUPPORTED_DOMAINS.has(d));
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported comparison domain(s): ${unsupported.join(', ')}. Supported domains are: ${[...SUPPORTED_DOMAINS].join(', ')}.`,
    );
  }

  const domains = [...new Set(input.domains)];
  if (domains.length === 0) {
    throw new Error('At least one comparison domain must be requested.');
  }

  // Validate required criteria per requested domain BEFORE creating any
  // task or calling any provider - a client input mistake (missing
  // location/origin/destination) is never confused with a provider
  // outage, and never silently degrades one domain while running others.
  for (const domain of domains) {
    if (domain === 'hotel' && !input.location) {
      throw new Error("Hotel comparison requires a location (e.g. hotelSearchLocation).");
    }
    if (domain !== 'hotel' && (!input.origin || !input.destination)) {
      throw new Error(`${domain} comparison requires an origin and a destination (e.g. transportOrigin/transportDestination).`);
    }
  }

  const taskId = await createTask(pool, input.conversationId, 'comparison');

  try {
    await markTaskProcessing(pool, taskId);

    const domainResults = await Promise.all(
      domains.map((domain) => (domain === 'hotel' ? runHotelDomain(input) : runTransportDomain(domain, input))),
    );

    const offers = domainResults.flatMap((r) => r.offers);
    const comparison = domainResults.map((r) => r.summary);
    const failedProviders = [...new Set(domainResults.flatMap((r) => r.failedProviders))];

    const narrationOffers = domainResults.flatMap((r, i) => toNarrationOffers(domains[i], r.offers));
    const narrationDomainSummaries: NarrationDomainSummary[] = domainResults.map((r) => ({
      domain: r.summary.domain,
      cheapestOfferId: r.summary.cheapestOfferId,
      mostExpensiveOfferId: r.summary.mostExpensiveOfferId,
      availableCount: r.summary.availableCount,
      unavailableCount: r.summary.unavailableCount,
    }));

    const { narrative, fellBackToDeterministic } = await narrateComparison(llmProvider, {
      offers: narrationOffers,
      domainSummaries: narrationDomainSummaries,
    });

    const result: ComparisonTaskResult = {
      domains,
      criteria: { location: input.location, origin: input.origin, destination: input.destination },
      offers,
      comparison,
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
