import type { NormalizedTransportOffer, TransportDomain } from '../providers/transport-provider';

export interface ComparedTransportOffer {
  offerId: string;
  provider: string;
  domain: TransportDomain;
  vehicleNumber: string;
  operatorName: string;
  price: number;
  currency: string;
  availability: boolean;
  departure: string;
  arrival: string;
  durationMinutes: number;
  /** Same cross-currency rule as compare-hotels.ts: null when there is no available offer to compare against, or when this offer's currency differs from the cheapest offer's currency - never a fabricated exchange-rate-derived number. */
  priceDeltaFromCheapest: number | null;
}

export interface TransportComparisonResult {
  /** Ascending by price; ties preserve input order (stable sort) - the SAME order persisted to tasks.result.offers for this domain. */
  offers: ComparedTransportOffer[];
  cheapestOfferId: string | null;
  mostExpensiveOfferId: string | null;
  /** Among available offers - the fastest option a traveler can actually take. null when no offer is available. */
  shortestDurationOfferId: string | null;
  longestDurationOfferId: string | null;
  availableCount: number;
  unavailableCount: number;
  providerGroups: Record<string, string[]>;
}

/**
 * The deterministic transport comparison service (V2 architecture Phase
 * 5 §4/§D) - the transport analogue of compare-hotels.ts, sharing its
 * exact conventions (available-only cheapest/most-expensive, no
 * cross-currency exchange-rate invention, stable price ordering) and
 * additionally surfacing duration extremes, since "how long does this
 * take" is a first-class comparison fact for transport that has no
 * hotel equivalent. Pure function - no database access, no LLM, no
 * provider call.
 */
export function compareTransportOffers(offers: NormalizedTransportOffer[]): TransportComparisonResult {
  const sorted = [...offers].sort((a, b) => a.price - b.price);
  const availableOffers = sorted.filter((o) => o.availability);
  const cheapestAvailable = availableOffers[0] ?? null;

  let shortest: NormalizedTransportOffer | null = null;
  let longest: NormalizedTransportOffer | null = null;
  for (const offer of availableOffers) {
    if (!shortest || offer.durationMinutes < shortest.durationMinutes) shortest = offer;
    if (!longest || offer.durationMinutes > longest.durationMinutes) longest = offer;
  }

  const providerGroups: Record<string, string[]> = {};
  for (const offer of sorted) {
    (providerGroups[offer.provider] ??= []).push(offer.offerId);
  }

  const comparedOffers: ComparedTransportOffer[] = sorted.map((offer) => ({
    offerId: offer.offerId,
    provider: offer.provider,
    domain: offer.domain,
    vehicleNumber: offer.vehicleNumber,
    operatorName: offer.operatorName,
    price: offer.price,
    currency: offer.currency,
    availability: offer.availability,
    departure: offer.departure,
    arrival: offer.arrival,
    durationMinutes: offer.durationMinutes,
    priceDeltaFromCheapest:
      cheapestAvailable && offer.currency === cheapestAvailable.currency
        ? offer.price - cheapestAvailable.price
        : null,
  }));

  return {
    offers: comparedOffers,
    cheapestOfferId: cheapestAvailable?.offerId ?? null,
    mostExpensiveOfferId: availableOffers.length > 0 ? availableOffers[availableOffers.length - 1].offerId : null,
    shortestDurationOfferId: shortest?.offerId ?? null,
    longestDurationOfferId: longest?.offerId ?? null,
    availableCount: availableOffers.length,
    unavailableCount: sorted.length - availableOffers.length,
    providerGroups,
  };
}
