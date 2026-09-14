# ai-travel-companion

“Everything you wish you knew before you travelled.”

An AI-powered travel companion: personalized itinerary planning grounded in
verified, sourced travel facts — not just an LLM guessing. See
[`docs/architecture-plan.md`](./docs/architecture-plan.md) for the full V1
architecture (modular monolith, provenance model, provider-neutral AI layer,
phased roadmap).

## Status

Phase 1, launch destination: **Delhi**. Done so far:
- The provenance foundation schema (`sources` / `facts` / `fact_versions`).
- The Places domain: an OSM Overpass provider adapter, an ingestion pipeline that
  normalizes and attaches provenance, and a manual ingestion command.

Food and Shopping (thin filters over `places`) and the Travel Intelligence /
AI Orchestration / itinerary job flow are next — see §12 of the architecture
plan for progress and what's next.

## Getting started

Requires Docker and Node.js 20+.

```bash
cp .env.example .env
npm install

npm run db:up              # starts Postgres+PostGIS and Redis
npm run migrate            # applies the schema
npm test                   # runs the test suite against real Postgres
npm run ingest:places -- delhi   # pulls real Delhi places from OSM Overpass
```

To tear down: `npm run db:down`.

## Why this schema first

Every fact the system stores (a place's opening hours, a price, an
advisory) is versioned and tied to the source it came from. This is what
lets the product answer "why does the system believe this?" and lets the
AI layer be held to citing only facts that were actually given to it. See
§5 ("Final Provenance Flow") and §7 ("Final Trust Boundary") of the
architecture plan for the reasoning.
