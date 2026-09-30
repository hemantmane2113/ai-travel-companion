import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { generateItinerary } from '../src/itinerary/generate-itinerary';
import { getItineraryWithProvenance } from '../src/itinerary/get-itinerary';
import { getJob } from '../src/itinerary/jobs';
import { seedWarnings } from '../src/advisory/seed-warnings';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { DESTINATIONS } from '../src/destinations';
import {
  deleteDestination,
  deleteItineraryAndJob,
  deletePlacesByExternalRef,
} from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const TEST_PREFIX = 'test:generate-itinerary';
const { bbox, center } = DESTINATIONS.delhi;

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:0`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {
    'addr:housenumber': '1',
    'addr:street': 'Netaji Subhash Marg',
    'addr:city': 'New Delhi',
    opening_hours: 'Tu-Su 09:30-16:30',
    phone: '+91 11 2327 7705',
    website: 'https://asi.nic.in',
  },
};

const KARIMS: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:restaurant:0`,
  name: "Karim's",
  category: 'restaurant',
  latitude: center.latitude,
  longitude: center.longitude + 0.02,
  raw: {},
};

const START_DATE = '2026-10-01';

function endDateForDays(numberOfDays: number): string {
  const end = new Date(`${START_DATE}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + numberOfDays - 1);
  return end.toISOString().slice(0, 10);
}

function placeItem(placeId: string, factVersionId: string, reason: string) {
  return { itemType: 'place', placeId, reason, factReferences: [factVersionId] };
}

function warningItem(factVersionId: string, reason: string) {
  return { itemType: 'warning', reason, factReferences: [factVersionId] };
}

function dayPlanResponse(days: Array<{ dayNumber: number; items: unknown[] }>): string {
  return JSON.stringify({
    summary: 'A trip to Delhi.',
    days: days.map((d) => ({ dayNumber: d.dayNumber, summary: `Day ${d.dayNumber}.`, items: d.items })),
  });
}

describe('generateItinerary', () => {
  it('runs the job to completion and persists a provenance-traceable, multi-day itinerary', async () => {
    const provider = new FixturePlacesProvider([RED_FORT, KARIMS]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const redFortFact = await lookupFactVersionId(RED_FORT);
    const karimsFact = await lookupFactVersionId(KARIMS);

    const llm = new FakeLlmProvider(
      dayPlanResponse([
        { dayNumber: 1, items: [placeItem(redFortFact.placeId, redFortFact.factVersionId, 'A must-see fort.')] },
        { dayNumber: 2, items: [placeItem(karimsFact.placeId, karimsFact.factVersionId, 'Legendary Old Delhi kebabs.')] },
      ]),
    );

    let result: Awaited<ReturnType<typeof generateItinerary>> | undefined;
    try {
      result = await generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: ['history', 'food'],
        startDate: START_DATE,
        endDate: endDateForDays(2),
      });

      expect(result.rejectedItems).toHaveLength(0);

      const job = await getJob(pool, result.jobId);
      expect(job?.status).toBe('complete');
      expect(job?.itineraryId).toBe(result.itineraryId);
      expect(job?.startDate).toBe(START_DATE);
      expect(job?.endDate).toBe(endDateForDays(2));

      const itinerary = await getItineraryWithProvenance(pool, result.itineraryId);
      expect(itinerary?.destination).toBe('delhi');
      expect(itinerary?.startDate).toBe(START_DATE);
      expect(itinerary?.days).toHaveLength(2);
      expect(itinerary?.days[0].items).toHaveLength(1);
      expect(itinerary?.days[1].items).toHaveLength(1);

      // "Why does the system believe this?" (plan §5) must resolve to a
      // real, attributable source for every item, place or warning alike.
      for (const day of itinerary!.days) {
        for (const item of day.items) {
          expect(item.itemType).toBe('place');
          expect(item.provenanceKind).toBe('verified');
          expect(item.source?.name).toBe('OpenStreetMap (Overpass)');
          expect(item.source?.licence).toBe('odbl');
          // A traveler needs to know where to actually go, not just why
          // the system believes in the recommendation.
          expect(typeof item.place?.latitude).toBe('number');
          expect(typeof item.place?.longitude).toBe('number');
        }
      }

      const redFortItem = itinerary!.days[0].items[0];
      expect(redFortItem.place?.category).toBe('attraction');
      expect(redFortItem.place?.address).toBe('1 Netaji Subhash Marg, New Delhi');
      expect(redFortItem.place?.openingHours).toBe('Tu-Su 09:30-16:30');
      expect(redFortItem.place?.phone).toBe('+91 11 2327 7705');
      expect(redFortItem.place?.website).toBe('https://asi.nic.in');

      const karimsItem = itinerary!.days[1].items[0];
      expect(karimsItem.place?.category).toBe('restaurant');
      // No addr:*/opening_hours/phone/website tags for this fixture -
      // extraction degrades to null rather than throwing or omitting the key.
      expect(karimsItem.place?.address).toBeNull();
      expect(karimsItem.place?.openingHours).toBeNull();
    } finally {
      if (result) await deleteItineraryAndJob(pool, result);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, KARIMS.externalRef]);
    }
  });

  it('produces exactly the requested number of days for 1-day and 3-day trips', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);
    const redFortFact = await lookupFactVersionId(RED_FORT);

    const oneDayResult = await generateItinerary(
      pool,
      new FakeLlmProvider(
        dayPlanResponse([{ dayNumber: 1, items: [placeItem(redFortFact.placeId, redFortFact.factVersionId, 'Day one.')] }]),
      ),
      { destinationSlug: 'delhi', interests: [], startDate: START_DATE, endDate: endDateForDays(1) },
    );

    const threeDayResult = await generateItinerary(
      pool,
      new FakeLlmProvider(
        dayPlanResponse([
          { dayNumber: 1, items: [placeItem(redFortFact.placeId, redFortFact.factVersionId, 'Day one.')] },
          { dayNumber: 2, items: [placeItem(redFortFact.placeId, redFortFact.factVersionId, 'Day two, revisited.')] },
          { dayNumber: 3, items: [placeItem(redFortFact.placeId, redFortFact.factVersionId, 'Day three.')] },
        ]),
      ),
      { destinationSlug: 'delhi', interests: [], startDate: START_DATE, endDate: endDateForDays(3) },
    );

    try {
      const oneDayItinerary = await getItineraryWithProvenance(pool, oneDayResult.itineraryId);
      expect(oneDayItinerary?.days).toHaveLength(1);

      const threeDayItinerary = await getItineraryWithProvenance(pool, threeDayResult.itineraryId);
      expect(threeDayItinerary?.days).toHaveLength(3);
      expect(threeDayItinerary?.days.map((d) => d.dayNumber)).toEqual([1, 2, 3]);
    } finally {
      await deleteItineraryAndJob(pool, oneDayResult);
      await deleteItineraryAndJob(pool, threeDayResult);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('flows a seeded warning from the database into the generated itinerary (P0-2 integration test)', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);
    await seedWarnings(pool, 'delhi');

    const redFortFact = await lookupFactVersionId(RED_FORT);
    const warningFactVersionId = await lookupWarningFactVersionId('delhi');

    const llm = new FakeLlmProvider(
      dayPlanResponse([
        {
          dayNumber: 1,
          items: [
            placeItem(redFortFact.placeId, redFortFact.factVersionId, 'A must-see fort.'),
            warningItem(warningFactVersionId, 'Check your visa requirements before travelling.'),
          ],
        },
      ]),
    );

    let result: Awaited<ReturnType<typeof generateItinerary>> | undefined;
    try {
      result = await generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: [],
        startDate: START_DATE,
        endDate: endDateForDays(1),
      });

      expect(result.rejectedItems).toHaveLength(0);

      const itinerary = await getItineraryWithProvenance(pool, result.itineraryId);
      const warningItems = itinerary!.days[0].items.filter((i) => i.itemType === 'warning');
      expect(warningItems).toHaveLength(1);
      expect(warningItems[0].placeId).toBeNull();
      // A warning has no location - never fabricate a place block for it.
      expect(warningItems[0].place).toBeNull();
      // The response makes the source honestly clear - not a live advisory.
      expect(warningItems[0].source?.name).toBe('Manually curated Phase 1 seed content');
      expect(warningItems[0].provenanceKind).toBe('verified');
    } finally {
      if (result) await deleteItineraryAndJob(pool, result);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
      await deleteDestination(pool, 'delhi');
    }
  });

  it('strips an item referencing a fabricated fact_version end-to-end: it is never persisted, and is recorded on the job', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);
    const redFortFact = await lookupFactVersionId(RED_FORT);

    const llm = new FakeLlmProvider(
      dayPlanResponse([
        {
          dayNumber: 1,
          items: [
            placeItem(redFortFact.placeId, redFortFact.factVersionId, 'Real place.'),
            { itemType: 'place', placeId: 'not-a-real-place-id', reason: 'Invented.', factReferences: ['fv-fake'] },
          ],
        },
      ]),
    );

    let result: Awaited<ReturnType<typeof generateItinerary>> | undefined;
    try {
      result = await generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: [],
        startDate: START_DATE,
        endDate: endDateForDays(1),
      });

      expect(result.rejectedItems).toHaveLength(1);
      expect(result.rejectedItems[0].placeId).toBe('not-a-real-place-id');

      const job = await getJob(pool, result.jobId);
      expect(job?.rejectedItems).toHaveLength(1);

      const itinerary = await getItineraryWithProvenance(pool, result.itineraryId);
      // Only the real place was persisted - the fabricated one never
      // reaches storage, not even as an unverified row.
      expect(itinerary?.days[0].items).toHaveLength(1);
      expect(itinerary?.days[0].items[0].placeId).toBe(redFortFact.placeId);
    } finally {
      if (result) await deleteItineraryAndJob(pool, result);
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('marks the job failed and creates no itinerary when the model response is invalid', async () => {
    const llm = new FakeLlmProvider('not json');

    await expect(
      generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: [],
        startDate: START_DATE,
        endDate: endDateForDays(1),
      }),
    ).rejects.toThrow(/not valid JSON/);

    const jobs = await pool.query(
      `select id, status, error, itinerary_id from itinerary_jobs
       where destination = 'delhi' and status = 'failed'
       order by created_at desc limit 1`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].error).toMatch(/not valid JSON/);
    expect(jobs.rows[0].itinerary_id).toBeNull();

    await deleteItineraryAndJob(pool, { jobId: jobs.rows[0].id });
  });

  it('rejects an unknown destination before creating any job', async () => {
    const llm = new FakeLlmProvider('{}');

    await expect(
      generateItinerary(pool, llm, {
        destinationSlug: 'atlantis',
        interests: [],
        startDate: START_DATE,
        endDate: endDateForDays(1),
      }),
    ).rejects.toThrow(/Unknown destination/);

    const jobs = await pool.query(`select id from itinerary_jobs where destination = 'atlantis'`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('rejects an invalid date range before creating any job (P0-4)', async () => {
    const llm = new FakeLlmProvider('{}');

    await expect(
      generateItinerary(pool, llm, {
        destinationSlug: 'delhi',
        interests: [],
        startDate: '2026-10-05',
        endDate: '2026-10-01', // before startDate
      }),
    ).rejects.toThrow(/endDate must not be before startDate/);

    const jobs = await pool.query(
      `select id from itinerary_jobs where destination = 'delhi' and start_date = '2026-10-05'`,
    );
    expect(jobs.rows).toHaveLength(0);
  });
});

// Look up the id + current fact_version a just-ingested fixture place
// received, so the fake LLM response can cite real values without
// hardcoding UUIDs.
async function lookupFactVersionId(
  place: NormalizedPlace,
): Promise<{ placeId: string; factVersionId: string }> {
  const row = await pool.query(
    `select p.id as place_id, f.current_version_id as fact_version_id
     from places p
     join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
     where p.external_ref = $1`,
    [place.externalRef],
  );
  return { placeId: row.rows[0].place_id, factVersionId: row.rows[0].fact_version_id };
}

async function lookupWarningFactVersionId(destinationSlug: string): Promise<string> {
  const row = await pool.query(
    `select f.current_version_id as fact_version_id
     from destinations d
     join facts f on f.entity_table = 'destinations' and f.entity_id = d.id and f.fact_type = 'travel_warning'
     where d.slug = $1
     limit 1`,
    [destinationSlug],
  );
  return row.rows[0].fact_version_id;
}
