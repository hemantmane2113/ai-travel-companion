# ai-travel-companion

“Everything you wish you knew before you travelled.”

An AI-powered travel companion: personalized itinerary planning grounded in
verified, sourced travel facts — not just an LLM guessing. See
[`docs/architecture-plan.md`](./docs/architecture-plan.md) for the full V1
architecture (modular monolith, provenance model, provider-neutral AI layer,
phased roadmap).

## Status

Phase 0, first task in progress: the provenance foundation schema
(`sources` / `facts` / `fact_versions`) that every later module (Places,
Food, Shopping, Travel Intelligence, AI grounding) will depend on.

## Getting started

Requires Docker and Node.js 20+.

```bash
cp .env.example .env
npm install

npm run db:up      # starts Postgres+PostGIS and Redis
npm run migrate    # applies the provenance schema
npm test           # runs the conflict-resolution test against real Postgres
```

To tear down: `npm run db:down`.

## Why this schema first

Every fact the system stores (a place's opening hours, a price, an
advisory) is versioned and tied to the source it came from. This is what
lets the product answer "why does the system believe this?" and lets the
AI layer be held to citing only facts that were actually given to it. See
§5 ("Final Provenance Flow") and §7 ("Final Trust Boundary") of the
architecture plan for the reasoning.
