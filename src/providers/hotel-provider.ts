/**
 * V2 architecture Phase 5: widened from 'hotel'-only to every domain the
 * Comparison Agent's contract (`domains: Domain[]`) was always designed
 * to support (§C/§12) - no interface change was needed anywhere that
 * already depended on `Domain[]`, only here and in SUPPORTED_DOMAINS
 * (src/agents/comparison-agent.ts).
 */
export type Domain = 'hotel' | 'flight' | 'train' | 'bus';

export interface HotelSearchCriteria {
  location: string;
}

export interface HotelLocation {
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * The LLM-visible, common representation of a hotel offer (plan §12,
 * generalized per the V2 architecture's Comparison Agent §E). `raw` is
 * kept for audit/debugging only - it is never sent to the LLM (see
 * src/ai/comparison-narration.ts) and never used by the deterministic
 * comparison service, which reads only the fields above it.
 */
export interface NormalizedHotelOffer {
  provider: string;
  domain: 'hotel';
  /** Stable within this provider - the identity later reference resolution and booking key off. */
  offerId: string;
  name: string;
  location: HotelLocation;
  price: number;
  currency: string;
  cancellationPolicy: string;
  rating: number;
  availability: boolean;
  sourceUrl: string;
  /** ISO 8601 - when this quote was actually fetched (plan §H's lighter provenance for volatile commercial data, not a fact_version). */
  retrievedAt: string;
  /** Provider-specific detail, preserved for audit only - never sent to the LLM, never read by deterministic comparison. */
  raw: Record<string, unknown>;
}

/**
 * Provider Abstraction (plan §8/§E), extended to the first commercial
 * domain. Read-only for Phase 4 - no write/booking capability yet (plan
 * §E's ReadProvider/WriteProvider split; this is ReadProvider<HotelOffer>
 * only). Mirrors PlacesProvider exactly: search() already returns
 * normalized data, so nothing above this interface ever needs to know a
 * concrete provider's response shape.
 */
export interface HotelProvider {
  readonly providerName: string;
  search(criteria: HotelSearchCriteria): Promise<NormalizedHotelOffer[]>;
}
