export type ItineraryItemType = 'place' | 'warning';

export interface GeneratedItineraryItem {
  itemType: ItineraryItemType;
  /** Required for 'place', absent for 'warning'. */
  placeId?: string;
  reason: string;
  /**
   * fact_version ids this item is grounded in (plan stabilization P0-3).
   * Every claim the model presents as verified must cite at least one
   * of the fact_version ids actually supplied in its context - the
   * deterministic validator rejects any id it didn't hand out itself.
   */
  factReferences: string[];
}

export interface GeneratedItineraryDay {
  dayNumber: number;
  summary: string;
  items: GeneratedItineraryItem[];
}

export interface GeneratedItinerary {
  summary: string;
  days: GeneratedItineraryDay[];
}
