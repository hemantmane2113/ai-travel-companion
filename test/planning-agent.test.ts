import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { planTrip } from '../src/agents/planning-agent';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { getJob } from '../src/itinerary/jobs';
import { getItineraryWithProvenance } from '../src/itinerary/get-itinerary';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { DESTINATIONS } from '../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { deleteItineraryAndJob, deletePlacesByExternalRef } from './helpers/db-cleanup';

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

const TEST_PREFIX = 'test:planning-agent';
const { bbox, center } = DESTINATIONS.delhi;

async function waitForJob(jobId: string) {
  let job;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    job = await getJob(pool, jobId);
    if (job?.status === 'complete' || job?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return job;
}

async function lookupPlace(externalRef: string) {
  const row = await pool.query(
    `select p.id as place_id, f.current_version_id as fact_version_id
     from places p join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
     where p.external_ref = $1`,
    [externalRef],
  );
  return { placeId: row.rows[0].place_id as string, factVersionId: row.rows[0].fact_version_id as string };
}

describe('planTrip (Planning Agent)', () => {
  it('plans a trip without must-visit exactly as the existing pipeline always has (regression check)', async () => {
    const RED_FORT: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:no-must-visit`,
      name: 'Red Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.01,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([RED_FORT]), 'delhi', bbox);
    const { placeId, factVersionId } = await lookupPlace(RED_FORT.externalRef);

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [{ dayNumber: 1, summary: 'History.', items: [{ itemType: 'place', placeId, reason: 'A must-see fort.', factReferences: [factVersionId] }] }],
      }),
    );

    const { jobId } = await planTrip(pool, llm, {
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-11-01',
      endDate: '2026-11-01',
    });

    try {
      const job = await waitForJob(jobId);
      expect(job?.status).toBe('complete');
      const itinerary = await getItineraryWithProvenance(pool, job!.itineraryId!);
      expect(itinerary?.days[0].items).toHaveLength(1);
      expect(itinerary?.days[0].items[0].placeName).toBe('Red Fort');
    } finally {
      const job = await getJob(pool, jobId);
      await deleteItineraryAndJob(pool, { jobId, itineraryId: job?.itineraryId });
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('resolves a valid must-visit place, forces it into the candidate set, and the final itinerary contains it', async () => {
    const RED_FORT: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:mv-red-fort`,
      name: 'Red Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.01,
      raw: {},
    };
    const HUMAYUNS_TOMB: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:mv-humayun`,
      name: "Humayun's Tomb (planning-agent test)",
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.02,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([RED_FORT, HUMAYUNS_TOMB]), 'delhi', bbox);
    const redFort = await lookupPlace(RED_FORT.externalRef);
    const humayun = await lookupPlace(HUMAYUNS_TOMB.externalRef);

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [
              { itemType: 'place', placeId: redFort.placeId, reason: 'A must-see fort.', factReferences: [redFort.factVersionId] },
              { itemType: 'place', placeId: humayun.placeId, reason: 'As requested.', factReferences: [humayun.factVersionId] },
            ],
          },
        ],
      }),
    );

    const { jobId } = await planTrip(pool, llm, {
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-11-02',
      endDate: '2026-11-02',
      mustVisit: ["Humayun's Tomb (planning-agent test)"],
    });

    try {
      const job = await waitForJob(jobId);
      expect(job?.status).toBe('complete');
      const itinerary = await getItineraryWithProvenance(pool, job!.itineraryId!);
      const names = itinerary?.days[0].items.map((i) => i.placeName);
      expect(names).toContain("Humayun's Tomb (planning-agent test)");
    } finally {
      const job = await getJob(pool, jobId);
      await deleteItineraryAndJob(pool, { jobId, itineraryId: job?.itineraryId });
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, HUMAYUNS_TOMB.externalRef]);
    }
  });

  it('rejects an unresolved must-visit place before creating any job, with a clear message', async () => {
    // Distinctive date scoped to this one test, not a global count -
    // proves no job was created for THIS request specifically without
    // being racy against other files creating unrelated jobs.
    const startDate = '2031-03-03';

    await expect(
      planTrip(pool, new FakeLlmProvider('{}'), {
        destinationSlug: 'delhi',
        interests: [],
        startDate,
        endDate: startDate,
        mustVisit: ['A Place That Absolutely Does Not Exist'],
      }),
    ).rejects.toThrow(/couldn't find these place\(s\) in Delhi: A Place That Absolutely Does Not Exist/);

    const jobs = await pool.query(
      `select id from itinerary_jobs where destination = 'delhi' and start_date = $1`,
      [startDate],
    );
    expect(jobs.rows).toHaveLength(0);
  });

  it('rejects an ambiguous must-visit place before creating any job, and never guesses which match was meant', async () => {
    const DUP_A: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:ambiguous-a`,
      name: 'Ambiguous Palace (planning-agent test)',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.03,
      raw: {},
    };
    const DUP_B: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:ambiguous-b`,
      name: 'Ambiguous Palace (planning-agent test)',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.04,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([DUP_A, DUP_B]), 'delhi', bbox);
    const startDate = '2031-04-04';

    try {
      await expect(
        planTrip(pool, new FakeLlmProvider('{}'), {
          destinationSlug: 'delhi',
          interests: [],
          startDate,
          endDate: startDate,
          mustVisit: ['Ambiguous Palace (planning-agent test)'],
        }),
      ).rejects.toThrow(/matches more than one place in Delhi/);

      const jobs = await pool.query(
        `select id from itinerary_jobs where destination = 'delhi' and start_date = $1`,
        [startDate],
      );
      expect(jobs.rows).toHaveLength(0);
    } finally {
      await deletePlacesByExternalRef(pool, [DUP_A.externalRef, DUP_B.externalRef]);
    }
  });

  it('fails the job (does not silently persist) when the LLM omits a resolved must-visit place', async () => {
    const RED_FORT: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:missing-red-fort`,
      name: 'Red Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.01,
      raw: {},
    };
    const HUMAYUNS_TOMB: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:missing-humayun`,
      name: "Humayun's Tomb (planning-agent test)",
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.02,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([RED_FORT, HUMAYUNS_TOMB]), 'delhi', bbox);
    const redFort = await lookupPlace(RED_FORT.externalRef);

    // The model only returns Red Fort - never mentions the resolved
    // must-visit place at all. This is deliberately NOT a grounding
    // failure (Red Fort's own reference is perfectly valid) - it's
    // specifically the must-visit presence check that must catch this
    // and fail the job.
    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [{ dayNumber: 1, summary: 'History.', items: [{ itemType: 'place', placeId: redFort.placeId, reason: 'A must-see fort.', factReferences: [redFort.factVersionId] }] }],
      }),
    );

    const { jobId } = await planTrip(pool, llm, {
      destinationSlug: 'delhi',
      interests: [],
      startDate: '2026-11-05',
      endDate: '2026-11-05',
      mustVisit: ["Humayun's Tomb (planning-agent test)"],
    });

    try {
      const job = await waitForJob(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.error).toMatch(/did not include required must-visit place\(s\): Humayun's Tomb \(planning-agent test\)/);
      expect(job?.itineraryId).toBeNull();
    } finally {
      const job = await getJob(pool, jobId);
      await deleteItineraryAndJob(pool, { jobId, itineraryId: job?.itineraryId });
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef, HUMAYUNS_TOMB.externalRef]);
    }
  });
});
