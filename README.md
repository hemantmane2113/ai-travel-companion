# ai-travel-companion

“Everything you wish you knew before you travelled.”

An AI-powered travel companion: personalized itinerary planning grounded in
verified, sourced travel facts — not just an LLM guessing. See
[`docs/architecture-plan.md`](./docs/architecture-plan.md) for the full V1
architecture (modular monolith, provenance model, provider-neutral AI layer,
phased roadmap).

## Status

**Phase 1 vertical slice, stabilized**, for the launch destination, **Delhi**:
- The provenance foundation schema (`sources` / `facts` / `fact_versions`).
- The Places domain: an OSM Overpass provider adapter, an ingestion pipeline that
  normalizes and attaches provenance, and a manual ingestion command.
- Travel Intelligence (deterministic candidate selection, ranked by proximity,
  reading only from Postgres, including seeded warning facts) and AI
  Orchestration (a provider-neutral LLM boundary, defaulting to a local
  model), with a deterministic grounding validator that checks every item's
  cited `fact_version` id(s) were actually supplied in context - not just
  that a place id exists.
- **Multi-day itinerary generation** (`startDate`/`endDate` → the requested
  number of days, validated and persisted), including warning items sourced
  from the seeded facts above, each tagged with clear, honest provenance.
- Itinerary persistence and the job lifecycle (`pending → processing →
  complete/failed`), including a provenance query that answers "why does
  the system believe this?" for every itinerary item.
- Food and Shopping recommendations - thin, proximity-ranked filters over
  the same `places` table Travel Intelligence uses.
- An HTTP API (NestJS) wrapping all of the above - see [API](#api) below.

A read-only audit after the initial Phase 1 build found four concrete gaps
against the plan's own exit criteria (a malformed-id 500, warnings never
reaching generation, entity-only grounding, single-day-only output) - all
four are now fixed; see "Stabilization Pass" in `docs/architecture-plan.md`
for the full build log, including bugs caught and fixed via testing against
the actual running server, not just the test harness.

## Getting started

Requires Docker and Node.js 20+.

```bash
cp .env.example .env
npm install

npm run db:up                    # starts Postgres+PostGIS and Redis
npm run migrate                  # applies the schema
npm test                         # runs the test suite against real Postgres
npm run ingest:places -- delhi   # pulls real Delhi places from OSM Overpass
npm run seed:warnings -- delhi   # writes the seeded warning facts
npm run start:api                # starts the HTTP API on :3000
```

To tear down: `npm run db:down`.

By default the AI layer targets a local Ollama server (`http://localhost:11434/v1`,
model `qwen2.5:3b-instruct` - see plan §6 for why a small model, given Phase 1's
resolved CPU-only hardware). Override via `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY`
in `.env`. No paid API is required for any of this to work.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/itineraries` | `{ destinationSlug, interests, startDate, endDate }` → `202 { jobId }`, generation runs in the background |
| GET | `/itineraries/jobs/:jobId` | Job status: `pending \| processing \| complete \| failed`, plus any grounding-check rejections |
| GET | `/itineraries/:id` | The generated multi-day itinerary, with provenance and location/address/opening-hours on every place item (warnings have none) |
| GET | `/itineraries/:id/items/:itemId/provenance` | "Why does the system believe this?" for one item |
| GET | `/food?destination=delhi&cuisine=...` | Proximity-ranked food recommendations |
| GET | `/shopping?destination=delhi&shopType=...` | Proximity-ranked shopping recommendations |
| GET | `/advisories?destination=delhi` | Seeded warning facts, with provenance |

`:id`/`:jobId`/`:itemId` path params are validated as UUIDs before touching
the database - a malformed one returns `400`, never an unhandled `500`.
`startDate`/`endDate` are `YYYY-MM-DD`; the range must not be inverted and is
capped at 14 days.

## Why this schema first

Every fact the system stores (a place's opening hours, a price, an
advisory) is versioned and tied to the source it came from. This is what
lets the product answer "why does the system believe this?" and lets the
AI layer be held to citing only facts that were actually given to it. See
§5 ("Final Provenance Flow") and §7 ("Final Trust Boundary") of the
architecture plan for the reasoning.
