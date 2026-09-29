import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  findMissingMustVisitPlaces,
  mergeMustVisitCandidates,
  resolveMustVisitPlaces,
} from '../src/travel-intelligence/must-visit';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { DESTINATIONS } from '../src/destinations';
import type { Candidate, CandidateSet } from '../src/travel-intelligence/candidate-set';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { deletePlacesByExternalRef } from './helpers/db-cleanup';

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

// A private destination bucket - resolveMustVisitPlaces is not
// hardcoded to 'delhi' (it takes any destination string), so these
// tests never touch the shared real 'delhi' data other files depend on.
const DESTINATION = 'test-must-visit';
const { bbox, center } = DESTINATIONS.delhi;
const TEST_PREFIX = 'test:must-visit';

describe('resolveMustVisitPlaces', () => {
  it('resolves a valid, unambiguous must-visit place to its real placeId and fact_version', async () => {
    const place: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:valid`,
      name: 'Resolvable Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.01,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([place]), DESTINATION, bbox);

    try {
      const result = await resolveMustVisitPlaces(pool, DESTINATION, ['Resolvable Fort'], center);

      expect(result.unresolved).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].name).toBe('Resolvable Fort');
      expect(result.resolved[0].placeId).toBeTruthy();
      expect(result.resolved[0].factVersionId).toBeTruthy();
    } finally {
      await deletePlacesByExternalRef(pool, [place.externalRef]);
    }
  });

  it('is case-insensitive', async () => {
    const place: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:case`,
      name: 'Case Test Gate',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.02,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([place]), DESTINATION, bbox);

    try {
      const result = await resolveMustVisitPlaces(pool, DESTINATION, ['case test gate'], center);
      expect(result.resolved).toHaveLength(1);
    } finally {
      await deletePlacesByExternalRef(pool, [place.externalRef]);
    }
  });

  it('reports an unknown must-visit place as unresolved rather than silently dropping it', async () => {
    const result = await resolveMustVisitPlaces(pool, DESTINATION, ['A Place That Does Not Exist'], center);

    expect(result.unresolved).toEqual(['A Place That Does Not Exist']);
    expect(result.resolved).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('reports a must-visit place matching more than one real place as ambiguous, and never guesses one', async () => {
    const duplicateA: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:dup-a`,
      name: 'Duplicate Name Palace',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.03,
      raw: {},
    };
    const duplicateB: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:dup-b`,
      name: 'Duplicate Name Palace',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.04,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([duplicateA, duplicateB]), DESTINATION, bbox);

    try {
      const result = await resolveMustVisitPlaces(pool, DESTINATION, ['Duplicate Name Palace'], center);

      expect(result.resolved).toEqual([]);
      expect(result.unresolved).toEqual([]);
      expect(result.ambiguous).toHaveLength(1);
      expect(result.ambiguous[0].name).toBe('Duplicate Name Palace');
      expect(result.ambiguous[0].matches).toHaveLength(2);
    } finally {
      await deletePlacesByExternalRef(pool, [duplicateA.externalRef, duplicateB.externalRef]);
    }
  });

  it('resolves, reports unresolved, and reports ambiguous independently within one call', async () => {
    const valid: NormalizedPlace = {
      externalRef: `${TEST_PREFIX}:mixed-valid`,
      name: 'Mixed Test Fort',
      category: 'attraction',
      latitude: center.latitude,
      longitude: center.longitude + 0.05,
      raw: {},
    };
    await ingestPlaces(pool, new FixturePlacesProvider([valid]), DESTINATION, bbox);

    try {
      const result = await resolveMustVisitPlaces(
        pool,
        DESTINATION,
        ['Mixed Test Fort', 'Nonexistent Mixed Place'],
        center,
      );

      expect(result.resolved.map((c) => c.name)).toEqual(['Mixed Test Fort']);
      expect(result.unresolved).toEqual(['Nonexistent Mixed Place']);
    } finally {
      await deletePlacesByExternalRef(pool, [valid.externalRef]);
    }
  });
});

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    placeId: 'default-id',
    factVersionId: 'default-fv',
    name: 'Default',
    category: 'attraction',
    latitude: 0,
    longitude: 0,
    distanceFromCenterKm: 0,
    ...overrides,
  };
}

function makeCandidateSet(overrides: Partial<CandidateSet> = {}): CandidateSet {
  return {
    destination: 'test',
    attractions: [],
    restaurants: [],
    shops: [],
    warnings: [],
    ...overrides,
  };
}

describe('mergeMustVisitCandidates', () => {
  it('adds a must-visit candidate not already present in its category', () => {
    const base = makeCandidateSet({ attractions: [makeCandidate({ placeId: 'a1', name: 'Already There' })] });
    const mustVisit = makeCandidate({ placeId: 'a2', name: 'New Must-Visit', category: 'attraction' });

    const merged = mergeMustVisitCandidates(base, [mustVisit]);

    expect(merged.attractions.map((c) => c.placeId)).toEqual(['a1', 'a2']);
  });

  it('does not duplicate a must-visit candidate already present (e.g. within the category cap)', () => {
    const existing = makeCandidate({ placeId: 'a1', name: 'Already There' });
    const base = makeCandidateSet({ attractions: [existing] });

    const merged = mergeMustVisitCandidates(base, [existing]);

    expect(merged.attractions).toHaveLength(1);
  });

  it('places a must-visit candidate into the correct category array', () => {
    const base = makeCandidateSet();
    const restaurant = makeCandidate({ placeId: 'r1', category: 'restaurant', name: "Karim's" });

    const merged = mergeMustVisitCandidates(base, [restaurant]);

    expect(merged.restaurants).toHaveLength(1);
    expect(merged.attractions).toHaveLength(0);
  });

  it('does not mutate the original candidate set', () => {
    const base = makeCandidateSet({ attractions: [] });
    mergeMustVisitCandidates(base, [makeCandidate({ placeId: 'a1' })]);

    expect(base.attractions).toHaveLength(0);
  });
});

describe('findMissingMustVisitPlaces', () => {
  it('finds nothing missing when every must-visit place is present', () => {
    const itinerary = { days: [{ items: [{ itemType: 'place', placeId: 'a1' }, { itemType: 'place', placeId: 'a2' }] }] };
    const mustVisit = [makeCandidate({ placeId: 'a1' }), makeCandidate({ placeId: 'a2' })];

    expect(findMissingMustVisitPlaces(itinerary, mustVisit)).toEqual([]);
  });

  it('finds a must-visit place missing from the generated itinerary', () => {
    const itinerary = { days: [{ items: [{ itemType: 'place', placeId: 'a1' }] }] };
    const mustVisit = [makeCandidate({ placeId: 'a1' }), makeCandidate({ placeId: 'a2', name: 'Missing Place' })];

    const missing = findMissingMustVisitPlaces(itinerary, mustVisit);

    expect(missing).toHaveLength(1);
    expect(missing[0].name).toBe('Missing Place');
  });

  it('does not count a warning item as satisfying a must-visit place constraint', () => {
    const itinerary = { days: [{ items: [{ itemType: 'warning' }] }] };
    const mustVisit = [makeCandidate({ placeId: 'a1' })];

    expect(findMissingMustVisitPlaces(itinerary, mustVisit)).toHaveLength(1);
  });

  it('checks across all days, not just the first', () => {
    const itinerary = {
      days: [{ items: [{ itemType: 'place', placeId: 'a1' }] }, { items: [{ itemType: 'place', placeId: 'a2' }] }],
    };
    const mustVisit = [makeCandidate({ placeId: 'a2' })];

    expect(findMissingMustVisitPlaces(itinerary, mustVisit)).toEqual([]);
  });
});
