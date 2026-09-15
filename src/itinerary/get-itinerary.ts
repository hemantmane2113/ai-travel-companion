import type { Pool } from 'pg';
import type { ItineraryItemType } from '../ai/itinerary-plan';

export interface ItineraryItemProvenance {
  name: string;
  url: string | null;
  licence: string | null;
  retrievedAt: string;
}

export interface ItineraryItemWithProvenance {
  itemId: string;
  itemType: ItineraryItemType;
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
  startDate: string;
  endDate: string;
  days: ItineraryDayWithItems[];
}

const ITEM_SELECT = `
  select ii.id as item_id, ii.item_type, ii.note, ii.provenance_kind,
         p.id as place_id, p.name as place_name,
         s.name as source_name, s.url as source_url, s.licence as source_licence,
         fv.retrieved_at
  from itinerary_items ii
  left join places p on p.id = ii.place_id
  left join fact_versions fv on fv.id = ii.referenced_fact_version_id
  left join sources s on s.id = fv.source_id
`;

function toItemWithProvenance(row: {
  item_id: string;
  item_type: ItineraryItemType;
  place_id: string | null;
  place_name: string | null;
  note: string;
  provenance_kind: 'verified' | 'ai_inference';
  source_name: string | null;
  source_url: string | null;
  source_licence: string | null;
  retrieved_at: string;
}): ItineraryItemWithProvenance {
  return {
    itemId: row.item_id,
    itemType: row.item_type,
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
  };
}

/**
 * Answers "why does the system believe this?" (plan §5): walks each
 * itinerary item -> its referenced fact_version -> the source it came
 * from, so every recommendation is traceable to a concrete,
 * attributable record rather than just a data-model capability. Works
 * identically for a 'place' item and a 'warning' item (stabilization
 * P0-2) - both reference a real fact_version, so the same chain applies.
 */
export async function getItineraryWithProvenance(
  pool: Pool,
  itineraryId: string,
): Promise<ItineraryWithProvenance | null> {
  const itineraryRow = await pool.query(
    // to_char, not the raw `date` column - see jobs.ts for why.
    `select id, destination, interests,
            to_char(start_date, 'YYYY-MM-DD') as start_date,
            to_char(end_date, 'YYYY-MM-DD') as end_date
     from itineraries where id = $1`,
    [itineraryId],
  );
  if (itineraryRow.rows.length === 0) return null;

  const days = await pool.query(
    `select id, day_number, summary from itinerary_days where itinerary_id = $1 order by day_number`,
    [itineraryId],
  );

  const resultDays: ItineraryDayWithItems[] = [];
  for (const day of days.rows) {
    const items = await pool.query(`${ITEM_SELECT} where ii.itinerary_day_id = $1 order by ii.sort_order`, [
      day.id,
    ]);

    resultDays.push({
      dayNumber: day.day_number,
      summary: day.summary,
      items: items.rows.map(toItemWithProvenance),
    });
  }

  return {
    id: itineraryRow.rows[0].id,
    destination: itineraryRow.rows[0].destination,
    interests: itineraryRow.rows[0].interests,
    startDate: itineraryRow.rows[0].start_date,
    endDate: itineraryRow.rows[0].end_date,
    days: resultDays,
  };
}

/**
 * The single-item form of the same provenance chain - the literal
 * `GET /itineraries/:id/items/:itemId/provenance` endpoint plan §5
 * calls for, rather than requiring a client to fetch and search the
 * whole itinerary just to answer "why does the system believe this
 * one thing?"
 */
export async function getItemProvenance(
  pool: Pool,
  itineraryId: string,
  itemId: string,
): Promise<ItineraryItemWithProvenance | null> {
  const result = await pool.query(
    `${ITEM_SELECT}
     join itinerary_days d on d.id = ii.itinerary_day_id
     where d.itinerary_id = $1 and ii.id = $2`,
    [itineraryId, itemId],
  );
  if (result.rows.length === 0) return null;

  return toItemWithProvenance(result.rows[0]);
}
