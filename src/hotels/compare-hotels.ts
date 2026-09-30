import type { NormalizedHotelOffer } from '../providers/hotel-provider';

export interface ComparedOffer {
  offerId: string;
  provider: string;
  name: string;
  price: number;
  currency: string;
  rating: number;
  availability: boolean;
  cancellationPolicy: string;
  /**
   * offer.price - cheapestAvailableOffer.price, in the cheapest offer's
   * own currency. null when there is no available offer to compare
   * against, or when this offer's currency differs from the cheapest
   * offer's currency - a numeric delta across currencies would require
   * a live exchange rate (an external, volatile input this deterministic
   * service deliberately has no dependency on), so it is left null
   * rather than computing a misleading number.
   */
  priceDeltaFromCheapest: number | null;
}

export interface HotelComparisonResult {
  /** Ascending by price; ties preserve input order (stable sort) - this is the SAME order persisted to tasks.result.offers. */
  offers: ComparedOffer[];
  /** Cheapest AMONG AVAILABLE offers - an unavailable offer's quoted price isn't something a traveler can actually act on. null when no offer is available. */
  cheapestOfferId: string | null;
  /** Most expensive among available offers, same rationale. null when no offer is available. */
  mostExpensiveOfferId: string | null;
  availableCount: number;
  unavailableCount: number;
  /** provider -> offerIds in that provider's group, in the same relative order as `offers`. */
  providerGroups: Record<string, string[]>;
}

/**
 * The deterministic comparison service (plan §D): the sole authority for
 * ordering, cheapest/most-expensive, price deltas, and availability
 * breakdown. Pure function - no database access, no LLM, no provider
 * call - so it is exhaustively unit-testable and can never hallucinate a
 * number. The Comparison Agent's optional LLM narration step (§G) may
 * only narrate over this result; it can never recompute or override it.
 */
export function compareHotelOffers(offers: NormalizedHotelOffer[]): HotelComparisonResult {
  const sorted = [...offers].sort((a, b) => a.price - b.price);

  const availableOffers = sorted.filter((o) => o.availability);
  const cheapestAvailable = availableOffers[0] ?? null;

  const providerGroups: Record<string, string[]> = {};
  for (const offer of sorted) {
    (providerGroups[offer.provider] ??= []).push(offer.offerId);
  }

  const comparedOffers: ComparedOffer[] = sorted.map((offer) => ({
    offerId: offer.offerId,
    provider: offer.provider,
    name: offer.name,
    price: offer.price,
    currency: offer.currency,
    rating: offer.rating,
    availability: offer.availability,
    cancellationPolicy: offer.cancellationPolicy,
    priceDeltaFromCheapest:
      cheapestAvailable && offer.currency === cheapestAvailable.currency
        ? offer.price - cheapestAvailable.price
        : null,
  }));

  return {
    offers: comparedOffers,
    cheapestOfferId: cheapestAvailable?.offerId ?? null,
    mostExpensiveOfferId: availableOffers.length > 0 ? availableOffers[availableOffers.length - 1].offerId : null,
    availableCount: availableOffers.length,
    unavailableCount: sorted.length - availableOffers.length,
    providerGroups,
  };
}
