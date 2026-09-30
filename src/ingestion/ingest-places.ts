import type { Pool, PoolClient } from 'pg';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../providers/places-provider';

interface SourceRecord {
  name: string;
  type: 'osm_derived';
  url: string;
  licence: string;
  attributionText: string;
  requiresAttribution: boolean;
  commercialUseAllowed: boolean;
  priority: number;
}

// Priority tier per plan §5: OSM/community data sits below an official
// government source, but is currently the only Places source, so this
// is a placeholder for future conflict resolution rather than a live
// decision point yet.
const OSM_SOURCE: SourceRecord = {
  name: 'OpenStreetMap (Overpass)',
  type: 'osm_derived',
  url: 'https://www.openstreetmap.org/copyright',
  licence: 'odbl',
  attributionText: '© OpenStreetMap contributors',
  requiresAttribution: true,
  commercialUseAllowed: true,
  priority: 10,
};

async function getOrCreateSource(client: PoolClient, source: SourceRecord): Promise<string> {
  const existing = await client.query('select id from sources where name = $1', [source.name]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `insert into sources
       (name, type, url, licence, attribution_text, requires_attribution, commercial_use_allowed, priority)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      source.name,
      source.type,
      source.url,
      source.licence,
      source.attributionText,
      source.requiresAttribution,
      source.commercialUseAllowed,
      source.priority,
    ],
  );
  return inserted.rows[0].id;
}

async function upsertPlace(
  client: PoolClient,
  destination: string,
  place: NormalizedPlace,
): Promise<{ placeId: string; isNew: boolean }> {
  const existing = await client.query('select id from places where external_ref = $1', [
    place.externalRef,
  ]);

  if (existing.rows.length > 0) {
    const placeId = existing.rows[0].id;
    await client.query(
      `update places
         set name = $1, category = $2, location = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
       where id = $5`,
      [place.name, place.category, place.longitude, place.latitude, placeId],
    );
    return { placeId, isNew: false };
  }

  const inserted = await client.query(
    `insert into places (destination, name, category, location, external_ref)
     values ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6)
     returning id`,
    [destination, place.name, place.category, place.longitude, place.latitude, place.externalRef],
  );
  return { placeId: inserted.rows[0].id, isNew: true };
}

/**
 * Writes provenance for a place (plan §5): every ingestion write inserts
 * a NEW fact_version (append-only, never overwritten) and, when a prior
 * version from this same source already existed, chains it via
 * superseded_by before repointing facts.current_version_id.
 */
async function recordFact(
  client: PoolClient,
  placeId: string,
  sourceId: string,
  place: NormalizedPlace,
): Promise<void> {
  const existingFact = await client.query(
    `select id, current_version_id from facts
     where entity_table = 'places' and entity_id = $1 and fact_type = 'place_listing'`,
    [placeId],
  );

  let factId: string;
  let previousVersionId: string | null = null;
  if (existingFact.rows.length === 0) {
    const inserted = await client.query(
      `insert into facts (fact_type, entity_table, entity_id) values ('place_listing', 'places', $1) returning id`,
      [placeId],
    );
    factId = inserted.rows[0].id;
  } else {
    factId = existingFact.rows[0].id;
    previousVersionId = existingFact.rows[0].current_version_id;
  }

  const versionCount = await client.query(
    'select count(*)::int as count from fact_versions where fact_id = $1',
    [factId],
  );
  const versionNumber = versionCount.rows[0].count + 1;

  const newVersion = await client.query(
    `insert into fact_versions (fact_id, value, source_id, confidence, version_number)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [factId, JSON.stringify(place.raw), sourceId, 0.8, versionNumber],
  );
  const newVersionId = newVersion.rows[0].id;

  if (previousVersionId) {
    await client.query('update fact_versions set superseded_by = $1 where id = $2', [
      newVersionId,
      previousVersionId,
    ]);
  }

  await client.query('update facts set current_version_id = $1 where id = $2', [
    newVersionId,
    factId,
  ]);
}

export interface IngestResult {
  destination: string;
  placesCreated: number;
  placesUpdated: number;
}

/**
 * Ingestion (plan §2/§4): pulls from a PlacesProvider, normalizes,
 * attaches provenance, and writes into the canonical local store. This
 * is invoked by the manual ingestion CLI (Phase 1) - the itinerary
 * generator at runtime only ever reads what's written here, never a
 * provider directly.
 */
export async function ingestPlaces(
  pool: Pool,
  provider: PlacesProvider,
  destination: string,
  bbox: BoundingBox,
): Promise<IngestResult> {
  const places = await provider.search(bbox);

  const client = await pool.connect();
  let placesCreated = 0;
  let placesUpdated = 0;
  try {
    await client.query('BEGIN');
    const sourceId = await getOrCreateSource(client, OSM_SOURCE);

    for (const place of places) {
      const { placeId, isNew } = await upsertPlace(client, destination, place);
      await recordFact(client, placeId, sourceId, place);
      if (isNew) placesCreated += 1;
      else placesUpdated += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { destination, placesCreated, placesUpdated };
}
