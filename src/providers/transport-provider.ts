import type { Domain } from './hotel-provider';

export type TransportDomain = Exclude<Domain, 'hotel'>;

export interface TransportSearchCriteria {
  origin: string;
  destination: string;
}

/**
 * The LLM-visible, common representation of a transport offer (V2
 * architecture Phase 5 §4), shared across flight/train/bus - the same
 * shape works for all three because a comparison only ever needs price,
 * timing, and availability, regardless of vehicle type. `raw` is kept
 * for audit/debugging only - never sent to the LLM, never read by the
 * deterministic comparison service. Deliberately has NO
 * `cancellationPolicy` field: unlike hotels, none of Phase 5's mock
 * transport providers models one, and the architecture explicitly warns
 * against inventing fields the current phase doesn't require - see
 * src/tasks/get-cancellation-policy.ts, which reports 'unavailable'
 * (never fabricated) for a transport offer accordingly.
 */
export interface NormalizedTransportOffer {
  provider: string;
  domain: TransportDomain;
  /** Stable within this provider - the identity later reference resolution and booking key off. */
  offerId: string;
  /** Flight number / train number / bus route number - the transport-specific identifying detail (plan §4). */
  vehicleNumber: string;
  /** Airline / rail operator / bus operator name. */
  operatorName: string;
  origin: string;
  destination: string;
  price: number;
  currency: string;
  availability: boolean;
  /** ISO 8601. */
  departure: string;
  /** ISO 8601. */
  arrival: string;
  durationMinutes: number;
  sourceUrl: string;
  /** ISO 8601 - when this quote was actually fetched (same lighter provenance as hotels, not a fact_version). */
  retrievedAt: string;
  /** Provider-specific detail, preserved for audit only - never sent to the LLM, never read by deterministic comparison. */
  raw: Record<string, unknown>;
}

/**
 * Shared shape every transport provider implements - search() already
 * returns normalized data, same boundary HotelProvider/PlacesProvider
 * draw. FlightProvider/TrainProvider/TrainProvider are distinct named
 * interfaces (so registration/DI stays domain-specific and a mismatched
 * provider can't be registered under the wrong domain by accident), but
 * share this one definition rather than duplicating it three times.
 */
interface TransportProvider {
  readonly providerName: string;
  search(criteria: TransportSearchCriteria): Promise<NormalizedTransportOffer[]>;
}

export interface FlightProvider extends TransportProvider {}
export interface TrainProvider extends TransportProvider {}
export interface BusProvider extends TransportProvider {}
