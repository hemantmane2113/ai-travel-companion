import type { Pool } from 'pg';

export interface ItineraryItemProvenance {
  name: string;
  url: string | null;
  licence: string | null;
  retrievedAt: string;
}

export interface ItineraryItemWithProvenance {
  itemId: string;
  placeId: string | null;
  placeName: string | null;
  note: string;
  provenanceKind: 'verified' | 'ai_inference';
  source: ItineraryItemProvenance | null;
}

export interface ItineraryDayWithItems {
  dayNumber: number;
  summary: string;
  items: ItineraryItemWithProvenance[];
}

export interface ItineraryWithProvenance {
  id: string;
  destination: string;
  interests: string[];
  days: ItineraryDayWithItems[];
}

/**
 * Answers "why does the system believe this?" (plan §5): walks each
 * itinerary item -> its referenced fact_version -> the source it came
 * from, so every recommendation is traceable to a concrete,
 * attributable record rather than just a data-model capability.
 */
export async function getItineraryWithProvenance(
  pool: Pool,
  itineraryId: string,
): Promise<ItineraryWithProvenance | null> {
  const itineraryRow = await pool.query(
    `select id, destination, interests from itineraries where id = $1`,
    [itineraryId],
  );
  if (itineraryRow.rows.length === 0) return null;

  const days = await pool.query(
    `select id, day_number, summary from itinerary_days where itinerary_id = $1 order by day_number`,
    [itineraryId],
  );

  const resultDays: ItineraryDayWithItems[] = [];
  for (const day of days.rows) {
    const items = await pool.query(
      `select ii.id as item_id, ii.note, ii.provenance_kind,
              p.id as place_id, p.name as place_name,
              s.name as source_name, s.url as source_url, s.licence as source_licence,
              fv.retrieved_at
       from itinerary_items ii
       left join places p on p.id = ii.place_id
       left join fact_versions fv on fv.id = ii.referenced_fact_version_id
       left join sources s on s.id = fv.source_id
       where ii.itinerary_day_id = $1
       order by ii.sort_order`,
      [day.id],
    );

    resultDays.push({
      dayNumber: day.day_number,
      summary: day.summary,
      items: items.rows.map((row) => ({
        itemId: row.item_id,
        placeId: row.place_id,
        placeName: row.place_name,
        note: row.note,
        provenanceKind: row.provenance_kind,
        source: row.source_name
          ? {
              name: row.source_name,
              url: row.source_url,
              licence: row.source_licence,
              retrievedAt: row.retrieved_at,
            }
          : null,
      })),
    });
  }

  return {
    id: itineraryRow.rows[0].id,
    destination: itineraryRow.rows[0].destination,
    interests: itineraryRow.rows[0].interests,
    days: resultDays,
  };
}
