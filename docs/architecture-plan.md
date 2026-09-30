# AI Travel Companion — V1 Architecture Plan (Final)

## Context

`ai-travel-companion` is an empty repo. This is the third and final pass of this plan. Pass 1 over-scoped V1 as production microservices on Kubernetes — rejected. Pass 2 corrected that to a modular monolith but still had three real problems, corrected here:

1. It treated Claude/OpenAI as V1's default AI provider, violating the "no paid API required" constraint.
2. It let the itinerary generator call external providers live, when most travel data (places, food, shopping, events) is static enough to ingest once and query locally — providers belong in an **ingestion pipeline**, not the request path.
3. It kept "Travel Intelligence stays in-process" as a permanent architectural lock, and kept Advisory in Phase 1 by default rather than testing whether it earns its place in the smallest possible vertical slice.

This pass fixes all three, adds a first-class **provenance chain** (recommendation → fact → fact version → source), an explicit **trust boundary** naming exactly where hallucination can occur and which layer is responsible for catching it, and cuts Phase 0/1 down to only what has a real, immediate consumer.

Everything from the prior pass not called out below (data architecture choices in §4 of the previous version, infra classification, security, observability, testing, repo structure, hotel/transport/crowd/web-vs-mobile reasoning) still holds and is restated here in compressed form for a single coherent document.

---

## 1. Final V1 Architecture

```
Client (Next.js web)
        │ HTTPS REST (OpenAPI-documented)
        ▼
API layer (NestJS controllers) — validation, auth guard, versioning only, no business logic
        ▼
Application/domain modules (Trips, Itinerary, Places, Food, Shopping, [Phase 2: Accommodation,
Transportation, Advisory, Events, Weather]) — own their data, never call external APIs or an LLM directly
        ▼
Travel Intelligence Engine (in-process domain service) — deterministic rules + candidate ranking
        ▼
AI Orchestration module — the ONLY module allowed to call an LLM, via a provider-neutral interface
        ▼
[at generation time: reads only from the local normalized store below — no live external calls]

──────────────────────────── separately, out of the request path ────────────────────────────

Ingestion pipeline (scheduled/manual job runner)
        ▼
Provider Abstraction (interface → adapter → external source) — the ONLY code allowed to call
OSM Overpass, OpenTripMap, data.gov.in, etc.
        ▼
Normalization → Provenance attachment → Validation
        ▼
PostgreSQL + PostGIS (facts, fact_versions, sources, users, trips, itineraries)  +  Redis (cache, queue)
```

**Layer responsibilities (unchanged core boundaries, restated):**
- **API layer** — HTTP concerns only.
- **Domain modules** — own their data slice; query the local store, never an external API, never an LLM.
- **Travel Intelligence Engine** — combines normalized facts + user context + deterministic rules into a candidate set. **This module remains an in-process module initially. It may be extracted later if measured latency, scaling, team ownership, or architectural requirements justify it** — not a permanent decision, a starting point.
- **AI Orchestration** — the only egress point to an LLM, of whatever kind (local or hosted).
- **Provider Abstraction** — the only egress point to external travel-data APIs, and it is invoked by the **ingestion pipeline**, not by a live user request (this is the corrected boundary — see §3).

---

## 2. Final Architecture Diagram — Ingestion vs Runtime, explicitly separated

```
INGESTION (offline / scheduled / manually triggered — Phase 1: manual CLI command per destination)
────────────────────────────────────────────────────────────────────────────────────────────
External source (OSM Overpass, OpenTripMap, data.gov.in, ...)
        ▼
Provider adapter (implements PlacesProvider / FoodProvider / etc.)
        ▼
Normalization (external schema → NormalizedFact shape)
        ▼
Provenance attachment (source_id, retrieved_at, valid_from/until, confidence, licence)
        ▼
Validation (sanity checks: coordinates in expected bounding box, required fields present)
        ▼
PostgreSQL: sources, facts, fact_versions   ← the canonical, trusted store


RUNTIME (per user request — Phase 1: synchronous within the async itinerary job)
────────────────────────────────────────────────────────────────────────────────────────────
Trip request
        ▼
Query normalized store (Postgres, via domain modules) — NOT the external provider
        ▼
Travel Intelligence Engine (deterministic filter/rank over already-ingested facts)
        ▼
AI context assembly (condensed fact_version references, not raw provider payloads)
        ▼
AI Orchestration → LLM (local or hosted, provider-neutral)
        ▼
Schema validation → deterministic grounding validation → persisted itinerary
```

This is the single most important structural correction from the prior pass: **the itinerary generator never depends on a live external API call.** If a destination hasn't been ingested yet, that's a data-availability gap surfaced to the user/operator ("this destination isn't available yet"), not a live fetch bolted into the request path.

---

## 3. Final Module Boundaries

| Module | Responsibility | Owned data | Depends on | Phase | Future extraction |
|---|---|---|---|---|---|
| Auth | Login, JWT/refresh | `users.credentials` | — | 1 | Easy, low priority |
| Users | Profile, preferences | `users`, `user_preferences` | Auth | 1 | Easy |
| Trips | Trip record (destination, dates, party, budget) | `trips` | Users | 1 | With Itinerary |
| Itinerary | Job lifecycle, persists plan, versions edits | `itineraries`, `itinerary_days`, `itinerary_jobs` | Trips, Travel Intelligence, AI Orchestration | 1 | Last to extract (orchestrator) |
| Travel Intelligence | Deterministic rules + ranking + AI context assembly | none (reads via other modules) | Places, Food, Shopping | 1 | **Stays in-process initially; extract only if measured need justifies it** (not a permanent lock) |
| Places | Shared POI store — attractions/history, the base layer Food/Shopping sit on | `places`, `place_fact_versions` | Provider Abstraction (via ingestion) | 1 | Candidate once POI-search load is real |
| Food | Restaurant/cuisine filtering over Places | reuses `places` + `food_fact_versions` | Places | 1 | With Places |
| Shopping | Markets/shopping districts over Places | reuses `places` + `shopping_fact_versions` | Places | 1 | With Places |
| Accommodation | Lodging discovery (not live pricing) | `accommodations` | Provider Abstraction | **2** | Independent |
| Transportation | Local transit + inter-city info, deep-links | `transport_options` | Provider Abstraction | **2** | Independent |
| Advisory | Safety/visa/health facts + change detection | `advisories`, `advisory_history` | Provider Abstraction (polling) | **2 — deferred, see §9** | Independent |
| Events | Holidays/festivals feeding crowd + timing | `events` | Provider Abstraction | **2** | With Weather |
| Weather | Forecast (on-demand, short TTL) | `weather_cache` | Provider Abstraction | **2** | Easy |
| Sources/Provenance | Cross-cutting: `sources`, `facts`, `fact_versions` | see §5 | used by all ingestion | 1 | Stays cross-cutting |
| AI Orchestration | Provider-neutral LLM calls | `ai_usage_log`, `ai_response_cache` | none | 1 | Candidate once cost/latency isolation matters |
| Ingestion | Runs Provider Abstraction jobs, writes normalized facts | none of its own | Provider Abstraction, Sources | 1 (manual trigger) | Becomes a scheduler in Phase 2 |

---

## 4. Final Data Flow — Ingestion cadence per data type

| Data type | Ingestion cadence | Why |
|---|---|---|
| Places / POIs (attractions, restaurants, shops) | Manual/batch per destination (Phase 1: one-off CLI run; Phase 2: scheduled monthly refresh) | Static enough that live-fetching on every request is pure waste and needlessly burns free-tier rate limits |
| Events/holidays | Batch, ahead-of-season (Phase 2) | Published in advance — no reason to poll live |
| Weather | **On-demand, short TTL cache** — not pre-ingested | Only meaningful within a ~10–16 day forecast horizon; pre-ingesting arbitrary future dates would be wasted/wrong |
| Routing/distance between two known places | **Computed locally, no external call at all** — PostGIS `ST_Distance` / haversine over already-ingested coordinates, plus a flat walking/transit-speed heuristic | V1 doesn't need routing-API accuracy; this removes an entire provider dependency (OpenRouteService) from V1 |
| Advisories (if/when built) | Periodic polling with change-detection (Phase 2) | The one genuinely time-sensitive domain — but that's exactly why it's a scheduled ingestion job, still never called live from a user request |

**Real-time is never "call the external API during the user's request."** Even the most time-sensitive data (advisories, weather) is ingestion-refreshed on a schedule/on-demand-with-cache into the local store; the runtime path only ever reads Postgres/Redis. This is what "mobile-ready, low-latency, provider-outage-resilient" actually requires.

---

## 5. Final Provenance Flow

**Chain:** `Recommendation item → referenced fact_version → source record → source URL, retrieved_at, validity period, licence/attribution`

**Schema (Postgres):**
```
sources
  id, name, type (official_government | open_data_portal | osm_derived | wiki | ...),
  url, licence, attribution_text, requires_attribution, commercial_use_allowed

facts                              -- one logical fact (e.g. "opening hours of Place X")
  id, fact_type, entity_table, entity_id, current_version_id

fact_versions                      -- append-only — provenance lives HERE, not on raw responses
  id, fact_id, value (jsonb), source_id, retrieved_at, valid_from, valid_until,
  confidence (0-1), version_number, superseded_by (nullable fk to fact_versions.id)

itinerary_items
  ..., referenced_fact_version_id (nullable), provenance_kind (verified | ai_inference)
```

- Provenance is a property of the **normalized fact version**, not the raw provider payload — the raw payload is discarded after normalization (or kept only as a debug blob), but every stored, queryable fact has a `fact_version` row with a `source_id`.
- **Versioning:** re-ingesting a destination doesn't overwrite — it inserts a new `fact_versions` row and updates `facts.current_version_id`; old versions stay queryable (`superseded_by` chains them), so a past itinerary's citation still resolves to the exact evidence used at generation time even after the fact is later updated.
- **Conflicting sources:** two adapters disagreeing on the same fact (e.g. OSM vs OpenTripMap on an opening hour) produce **two separate `fact_versions`** with different `source_id`s and no supersede relationship between them. Resolution is a documented priority order (official government > established open-data aggregator > OSM/community tag) applied when `facts.current_version_id` is chosen; if priority is equal, `confidence` is capped below a threshold and the Travel Intelligence Engine treats the fact as "unconfirmed," which the AI layer must phrase as such rather than stating it flatly.
- **"Why does the system believe this?"** is answered by a direct query: itinerary item → `referenced_fact_version_id` → `fact_versions` row → `source_id` → `sources` row (name, URL, licence). This must be a real API endpoint (`GET /itineraries/:id/items/:itemId/provenance`), not just a data-model capability — it's core to the product promise ("everything you wish you knew"), so it should be user-facing, not just internal.

---

## 6. Final AI Flow — provider-neutral by default, no paid dependency

```
Domain/Travel-Intelligence modules
        ▼
AiOrchestrationService (only module allowed to call an LLM)
        ▼
LLMProvider interface:  generate(prompt, context, schema) -> {structuredOutput, usage}
        ▼
OpenAICompatibleAdapter   ← default/reference adapter for V1
   (talks to ANY OpenAI-Chat-Completions-compatible HTTP endpoint —
    covers a local model server AND, later, a hosted OpenAI-compatible provider,
    with zero code change, only a config change)
        ▼
Configured target (env-driven):  local Ollama / vLLM / LM Studio endpoint (V1 default)
                                  — later, optionally, a hosted provider's compatible endpoint
```

- **No hosted/paid provider is a V1 dependency.** The reference adapter is provider-neutral by construction: it speaks the OpenAI Chat Completions HTTP format, which a self-hosted open-weight model server (Ollama, vLLM, LM Studio) also speaks — so "local model" and "future hosted provider" are the *same adapter*, differing only by a base-URL/API-key config value. A distinct `AnthropicAdapter` is only written later, if/when a non-OpenAI-compatible provider (Claude's native Messages API) is actually approved for use.
- **Callers never know which provider is being used** — `AiOrchestrationService` is the only thing that reads the provider config.
- **Smallest practical Phase 1 LLM setup:** self-hosted **Ollama** running a small open-weight instruct model (candidates: Qwen2.5-7B-Instruct or Llama-3.1-8B-Instruct, 4-bit quantized, ~5GB memory footprint), exposed via Ollama's built-in OpenAI-compatible API — zero cost, fully open-source, runs on a developer machine or a single server.
- **Hardware implications — explicit open decision, not assumed:**
  - CPU-only inference works on any machine with ≳16GB RAM, but itinerary-generation latency is likely **30 seconds to a few minutes** depending on CPU and model size. This is *tolerable* precisely because the architecture already treats generation as an async job with polling (§8/§9) — but it must be **measured against a real machine**, not assumed acceptable.
  - A GPU (even a modest consumer one, 8GB+ VRAM) would cut that to low tens of seconds.
  - **Resolved:** Phase 1 hardware is CPU-only (no GPU). Per the trade-off above, the Phase 1 default model is therefore a smaller **3-4B instruct model** (e.g. Qwen2.5-3B-Instruct or Llama-3.2-3B-Instruct, 4-bit quantized), not the 7-8B target — prioritizing acceptable latency within the async job pattern over model strength. Revisit upward once/if GPU hardware becomes available; the adapter interface does not change either way, only the configured model name.
- **What the AI layer does:** model/provider selection (config-driven), prompt/schema management, structured-output enforcement, grounding validation (post-generation fact-existence check), response caching, usage logging.
- **What it explicitly does NOT do:** fetch external travel data, decide advisory gating/budget math/filtering (Travel Intelligence's job), persist itineraries (Itinerary module's job), or leak provider identity to any caller outside itself.

---

## 7. Final Trust Boundary — where hallucination can occur, and who prevents it

```
External sources → Provider adapters → Normalized facts + provenance → deterministic
Travel Intelligence rules → constrained AI context → LLM reasoning → schema validation →
deterministic post-generation validation → persisted itinerary
```

| Stage | Can it introduce a hallucination? | Who is responsible for preventing/catching it |
|---|---|---|
| External sources | No (may be stale/wrong, but that's a data-quality issue, not hallucination) | Provenance/confidence model (§5) |
| Provider adapters / normalization | No (a bug here is a mapping error, tested by contract tests) | Provider adapter contract tests |
| Normalized facts + provenance | No — this is the trusted ground truth | The ingestion validation step |
| Deterministic Travel Intelligence rules | No — pure code, cannot invent facts, only misapply a rule | Unit tests on the rules themselves |
| Constrained AI context assembly | No, but a *sloppy* context (missing an explicit "only use what's here" instruction) increases downstream risk | Prompt/context design discipline in AI Orchestration |
| **LLM reasoning** | **Yes — this is the only stage where a genuinely new, unverified claim can appear** | Not the LLM itself — it cannot be trusted to self-police |
| Schema validation | No (catches shape errors, not invented facts) | Structural validation only |
| **Deterministic post-generation validation** | N/A — this stage's entire job is to catch what the LLM stage introduced | **This layer is the actual safety net**: every fact claim in the LLM's output must resolve to a `fact_version_id` that was present in the context sent to it; anything that doesn't resolve is rejected/stripped/regenerated, never silently persisted |
| Persisted itinerary | No | Tagged `verified` vs `ai_inference` per item so the UI never presents an inference as a measured fact |

**The load-bearing conclusion:** hallucination risk is architecturally concentrated at exactly one stage (LLM reasoning), and exactly one downstream stage (deterministic post-generation validation) is accountable for containing it. This is why that validation step is non-negotiable in Phase 1 — skipping it to save time would remove the system's only actual hallucination guard.

---

## 8. Final Phase 0 Scope — only what has a real, immediate consumer

| Component | Why needed immediately | What consumes it | Test that proves it works |
|---|---|---|---|
| Postgres + PostGIS (Docker, local) | Phase 1's first task is writing the `sources`/`facts`/`fact_versions` schema | Every module from Phase 1 onward | A migration runs; an insert/select round-trip succeeds |
| Redis (Docker, local) | Phase 1's AI response cache and (once needed) job queue | AI Orchestration, Itinerary job runner | Connect + `SET`/`GET` succeeds |
| Two-app monorepo skeleton (`apps/api` empty NestJS, `apps/web` empty Next.js) | Container for all Phase 1 code | All subsequent phases | Both apps boot locally |
| CI running lint + test on push | Cheap to add now, expensive to retrofit after code exists | Every future PR | A trivial passing test runs green in CI |

**Explicitly NOT in Phase 0** (no real consumer yet, would be speculative): `libs/` shared packages (created when Phase 1 actually needs to share code, not before), any provider adapter, any AI adapter, docker-compose beyond local Postgres/Redis, any message broker, any Kubernetes/Helm artifact, Nx's full generator tooling beyond the two app shells.

---

## 9. Final Phase 1 Vertical Slice — with Advisory reasoning made explicit

**Test applied to every candidate domain: does it help prove `trip requirements → real data → normalization/provenance → Travel Intelligence → AI reasoning → grounded itinerary → useful UX`, or does it just add feature count?**

**In Phase 1:**
- **Places** (shared ingestion: OSM Overpass + OpenTripMap, one adapter pair covering attractions/history/restaurants/shops via category tags) — this is the highest-leverage choice because **Food and Shopping ride on the same ingestion pipeline at near-zero marginal cost**, giving three of the product's named feature domains from one provider integration.
- **Food**, **Shopping** — thin filtering views over Places (§3).
- **Travel Intelligence** — deterministic filtering (budget, dietary if provided) + ranking (rating/distance clustering) + AI context assembly.
- **AI Orchestration** — local model via `OpenAICompatibleAdapter` (§6).
- **Deterministic post-generation validation** (§7) — non-negotiable, it's the system's only hallucination guard.
- **A small number of manually-seeded "warning-type" facts** for the one Phase 1 launch destination (e.g. one visa-requirement note, one safety note), inserted through the *same* `facts`/`fact_versions`/`sources` schema as everything else, with a real (if minimal) source record — **not** a live Advisory ingestion service.

**Deferred to Phase 2, with reasoning (not by default):**
- **Full Advisory module** (external polling, change-detection, subscription/notification) — its *value proposition* (warnings) is real and worth proving, which is exactly why a couple of seeded warning facts prove the Travel Intelligence "warnings" output type and the UI's verified/AI-inference distinction for that item type, **without** building a live-polling ingestion service, a change-detection algorithm, and a notification pathway that Phase 1 doesn't otherwise need. The full service is deferred because it's expensive machinery in service of a data-freshness guarantee ("we'll tell you if this changes") that isn't required to validate the core reasoning loop — it's validated later, once the core loop already works, against a real chosen advisory source.
- **Accommodation, Transportation** — each needs its own provider research/integration (uncertain India coverage, per the earlier draft's findings) and is more "discovery list" than "reasoning," so it adds integration risk without stress-testing the part of the architecture that's actually novel (Travel Intelligence + grounded AI + provenance).
- **Events, Weather** — genuinely useful, but Weather is intentionally on-demand/short-TTL (§4) which is a different runtime pattern than the batch-ingested Places data — validating that second pattern is real work better done once the first (batch-ingested, deterministic-heavy) pattern is proven.

**Exit criteria:** a real user can request a trip for the one launch destination and get back a generated itinerary covering places/food/shopping recommendations plus at least one grounded warning, with every item's provenance queryable (§5's endpoint), and with a test case that proves the deterministic grounding validation actually rejects a fabricated fact.

---

## 10. Explicitly Deferred Technologies/Features (full list)

- Kubernetes, Helm, Argo CD, Vault, full OpenTelemetry stack, RabbitMQ/Kafka, MongoDB, OpenSearch/Elasticsearch — each avoided until a specific measured need, not "expected at scale."
- OpenRouteService / any routing API — removed entirely from V1 scope by §4's correction (local PostGIS distance computation replaces it).
- Full Advisory ingestion service, Accommodation, Transportation, Events, Weather modules — deferred to Phase 2 per §9.
- `AnthropicAdapter` / any hosted-LLM adapter — deferred until a paid provider is explicitly approved; V1 ships on the local/open-weight path only.
- Mobile app (React Native) — deferred per the prior pass's web-first recommendation (unchanged; backend stays API-first/mobile-ready).
- Any scheduler/cron for ingestion — Phase 1 ingestion is a manually-triggered CLI command for the single launch destination; automation is a Phase 2 concern once there's more than one destination to keep fresh.

---

## 11. Remaining Decisions Requiring Approval

1. ~~Hardware for Phase 1 local LLM inference~~ — **Resolved: CPU-only.** Phase 1 default model is 3-4B quantized (§6).
2. ~~Phase 1 launch destination~~ — **Resolved: Delhi.**
3. **Seeded-warning approach for Phase 1** (§9) — confirm that manually-entered warning facts (rather than a live Advisory service) are an acceptable way to prove the "warnings" output type in the first slice.
4. **Future advisory source priority** (deferred to Phase 2, but worth flagging now) — which source should be treated as primary once the real Advisory service is built.

---

## 12. Implementation Progress

**Task 1 (done):** the `sources` / `facts` / `fact_versions` provenance schema. Implemented in `migrations/1700000000000_init-provenance-schema.js`, `src/provenance.ts`, and `test/provenance.test.ts`.

**Task 2 (done):** the Places domain, end to end for the resolved launch destination (Delhi):
- `migrations/1700000001000_places-schema.js` — the `places` table (PostGIS `geography(Point)`, category, provider-qualified `external_ref` for idempotent re-ingestion).
- `src/providers/places-provider.ts` — the `PlacesProvider` interface (plan §8's Provider Abstraction boundary).
- `src/providers/osm-overpass-adapter.ts` — the OSM Overpass adapter, with normalization (`normalizeOsmElement`) kept as a pure, independently-tested function per the plan's provider-adapter testing strategy.
- `src/ingestion/ingest-places.ts` — the ingestion pipeline: writes/updates `places`, attaches provenance (`facts`/`fact_versions`, source = OpenStreetMap/Overpass, ODbL licence, attribution required), and correctly chains `superseded_by` on re-ingestion rather than overwriting (proven in `test/ingest-places.test.ts` against a real database, using a fixture provider so CI never depends on a live/rate-limited Overpass call).
- `src/ingestion/destinations.ts` + `src/ingestion/cli.ts` — the manual ingestion command (`npm run ingest:places -- delhi`), per Phase 1's "no scheduler yet" scope.

This proves the ingestion side of §2's diagram end-to-end for one domain. Food and Shopping (§9) ride on this same `places` table/ingestion pipeline via category filtering — no new provider integration needed for them.

**Task 3 (done):** Travel Intelligence + AI Orchestration, wired to the trust boundary in §7:
- `src/geo.ts` — the local haversine distance function that replaces a routing-API dependency for V1 (plan §4).
- `src/destinations.ts` — the Delhi bounding box and reference center, shared by ingestion and Travel Intelligence.
- `src/travel-intelligence/candidate-set.ts` — the deterministic half: reads only `places`/`facts` (never an external API, never an LLM), filters by destination/category, ranks by proximity to the destination center, and caps each category (context-window discipline, plan §7). Every returned candidate carries the exact `fact_version_id` it came from.
- `src/ai/llm-provider.ts` + `src/ai/openai-compatible-adapter.ts` + `src/ai/config.ts` — the provider-neutral AI boundary (plan §6): one adapter class speaks the OpenAI Chat Completions format, which a local Ollama server and a future hosted provider both speak, so switching is a config change, not a code change. No hosted/paid provider is a dependency; the adapter's request/response handling is tested against a mocked `fetch`, never a live call.
- `src/ai/ai-orchestration-service.ts` — assembles the candidate set + trip context into a prompt, calls the configured `LlmProvider`, and applies the plan §7 **deterministic post-generation grounding validation**: every `placeId` the model references must resolve to a candidate actually supplied in context, or it is stripped into `rejectedItems` and never returned as part of the plan. `test/ai-orchestration-service.test.ts` proves this directly — including the case where the model fabricates a `placeId` that doesn't exist.
- `src/ai/fake-llm-provider.ts` — a deterministic stand-in used only by tests, so the test suite never depends on a live/slow CPU-only local model (plan §6's hardware trade-off).

This closes the "grounded reasoning" half of the Phase 1 exit criteria (§9): real ingested data → deterministic candidate selection → AI reasoning → a validated, hallucination-checked result.

**Task 4 (done):** Itinerary persistence and job lifecycle:
- `migrations/1700000002000_itinerary-schema.js` — `itineraries` / `itinerary_days` / `itinerary_items` (carrying `referenced_fact_version_id` + `provenance_kind`, plan §5) / `itinerary_jobs` (`pending → processing → complete/failed`, plan §9).
- `src/itinerary/generate-itinerary.ts` — ties Travel Intelligence and AI Orchestration into the job lifecycle from §9's flow (steps 3-14: job creation → candidate retrieval → AI generation → persistence → completion). Implemented as a direct async call rather than a real queue: BullMQ/Redis is deferred until there's an HTTP layer that actually needs to return `202 Accepted` immediately (plan §8's Phase 0 table marks the job queue "once needed") — the `itinerary_jobs` table already carries the status states a queue worker would update, so wiring a real queue later is additive, not a rewrite.
- `src/itinerary/persist-itinerary.ts` — persists only grounding-validated items, tagged `verified` with their exact `fact_version_id`.
- `src/itinerary/get-itinerary.ts` — `getItineraryWithProvenance`, the real, queryable answer to "why does the system believe this?" (plan §5's explicit requirement that this be user-facing, not just a data-model capability): itinerary item → fact_version → source (name, URL, licence).
- `test/generate-itinerary.test.ts` — proves the full pipeline end-to-end against real Postgres: a happy path with provenance-traceable persistence, the **hallucination guard at the persistence layer** (a fabricated placeId is stripped, recorded on the job's audit trail, and never reaches storage - not even as an unverified row), a failed-job path (invalid model output → job marked `failed`, no itinerary created), and an unknown-destination guard.

**Task 5 (done):** Food and Shopping, as the thin filters over Places the plan calls for (§3/§9) rather than new provider integrations:
- `src/places/query-places.ts` — extracted the shared "already-ingested places + current fact_version + source" read (previously duplicated inside Travel Intelligence alone) into one function, `queryPlacesByCategory`, that Travel Intelligence, Food, and Shopping now all build on. `candidate-set.ts` was refactored to use it too, with its existing test suite re-verified green - this is what makes "Food and Shopping ride on the same ingestion pipeline at near-zero marginal cost" (§9) literally true in the code, not just in the plan.
- `src/food/recommend-food.ts` — restaurants ranked by proximity, with an optional cuisine filter read from the OSM `cuisine` tag captured at ingestion time.
- `src/shopping/recommend-shopping.ts` — shops ranked by proximity, with an optional shop-type filter read from the OSM `shop` tag.
- Both return full provenance (source name/URL/licence) per recommendation, not just for itinerary items - consistent with §5's requirement that "why does the system believe this" be answerable everywhere a recommendation is shown, not only inside a generated itinerary.
- Tested in `test/recommend-food.test.ts` / `test/recommend-shopping.test.ts`: filtering, proximity ranking, provenance, and that an unqueried/unknown destination simply returns nothing rather than ever reaching for an external API.

**Task 6 (done): seeded warning facts.** `migrations/1700000003000_destinations-schema.js` adds a minimal `destinations` table (just enough to give `facts.entity_id` a real uuid to point at for destination-level facts). `src/advisory/seed-warnings.ts` writes two manually-curated, honestly-sourced warning facts for Delhi through the *same* `facts`/`fact_versions`/`sources` schema as everything else - deliberately generic travel guidance (visa/e-Visa reminder, general safety awareness) rather than a fabricated specific official advisory level, since this codebase has no live-verified source for that right now. The source record is honest about what it is (`'Manually curated Phase 1 seed content'`, low priority `1`) rather than falsely claiming to be an official government feed - the whole point of the provenance model is that provenance can't lie. `src/advisory/get-warnings.ts` reads them back with provenance; both are idempotent and tested in `test/seed-warnings.test.ts`.

**Task 7 (done): the HTTP API surface.** NestJS wraps the existing framework-free modules - no controller contains business logic, every one is thin wiring:
- `src/http/core.module.ts` — the single place that decides the active `LlmProvider` (`OpenAiCompatibleAdapter`, config-driven per plan §6) and provides the shared `Pool`, both via DI tokens (`src/http/tokens.ts`).
- `src/itinerary/generate-itinerary.ts` was split into `createItineraryJob` (creates the job row, returns immediately) and `runItineraryJob` (does the actual work); `generateItinerary` (unchanged behavior, still used by the CLI/tests) just calls both in sequence. `ItinerariesController.create` calls `createItineraryJob` then fires `runItineraryJob` without awaiting it, returning **202** as soon as the job row exists (plan §9 step 3) - genuinely non-blocking without needing BullMQ/Redis yet.
- Endpoints: `POST /itineraries`, `GET /itineraries/jobs/:jobId`, `GET /itineraries/:id`, `GET /itineraries/:id/items/:itemId/provenance` (the literal endpoint plan §5 asks for), `GET /food`, `GET /shopping`, `GET /advisories`, `GET /health`.
- **A real bug the e2e test caught, not just a theoretical risk:** NestJS's automatic `ValidationPipe` infers a `@Body()` DTO's type via TypeScript's `emitDecoratorMetadata`, which `tsx` (used for both `npm run start:api` and the test suite) transpiles via esbuild - and esbuild does not reliably emit that metadata for method-parameter types. The global pipe was silently a no-op: malformed request bodies sailed through unvalidated in production, not just in tests. Fixed by `src/http/validate-dto.ts`, which validates explicitly via `class-validator`'s `validate()` against the DTO's own property decorators (which work fine regardless of esbuild's metadata gaps), independent of NestJS's automatic inference. Verified by booting the *actual* production entrypoint (`npx tsx src/main.ts`) and curling it directly, not just the Nest testing module.
- **A second bug the same smoke test caught:** an unknown destination surfaced as a raw 500 (`createItineraryJob` throws a plain framework-free `Error`, which Nest doesn't know how to map). Fixed by catching it in the controller and rethrowing as `BadRequestException` - confirmed 400 against the real running server afterward.
- `test/http/app.e2e.test.ts` runs the full stack (`@nestjs/testing` + `supertest`) against real Postgres with the `LLM_PROVIDER`/`POOL` tokens overridden (fake LLM, shared test pool) - it drives the complete create → poll → fetch → provenance flow through actual HTTP requests, including the fabricated-placeId grounding guard surviving end-to-end through the API layer.
- **A latent test-isolation bug surfaced along the way:** `candidate-set.test.ts` deliberately sits at the category-cap boundary (9 inserted places, expects exactly 8 kept), which made it flaky once a second test file (`http/app.e2e.test.ts`) held 'delhi'-destination fixture rows alive for its whole run - Vitest runs test files in parallel by default. Fixed by giving cap-sensitive/name-sensitive test files (`candidate-set`, `recommend-food`, `recommend-shopping`) their own private destination-string bucket instead of sharing the real `'delhi'` slug (which only `generate-itinerary.test.ts` and the e2e test must use, since they validate against the real `DESTINATIONS` map) - confirmed stable across 5 consecutive full-suite runs.
- Dependency note: pinned `@nestjs/*` to `^12.0.2` (not the commonly-cited `^10.x`) after `npm audit` found real vulnerabilities (multer/body-parser/qs DoS) in what `^10.x` resolved to; `npm audit --omit=dev` now reports zero vulnerabilities in production dependencies.

This closes every item in §9's Phase 1 exit criteria: a real HTTP request can drive a destination through ingestion → Travel Intelligence → grounded AI reasoning → persisted, provenance-traceable itinerary, plus Food/Shopping/Advisory recommendations, all without a paid API or any infrastructure beyond Postgres+Redis.

**Correction (post-audit):** a subsequent read-only audit found this last claim overstated - warnings existed but were never actually wired into itinerary generation, so no generated itinerary had ever included one. See the stabilization pass below for the fix.

---

## Stabilization Pass — P0-1 through P0-4 (post-audit)

A read-only Phase 1 audit found the core engineering (provenance chain, provider-neutral AI, entity-level grounding) solid, but identified four concrete gaps against the plan's own stated exit criteria. This pass fixes exactly those four, nothing else - no Phase 2 scope, no new infrastructure (no microservices/K8s/Kafka/RabbitMQ/MongoDB/OpenSearch/mobile/second LLM provider/BullMQ/Redis/auth).

**P0-1 - malformed UUID handling.** `GET /itineraries/:id`, `GET /itineraries/jobs/:jobId`, and `GET /itineraries/:id/items/:itemId/provenance` used to let a malformed id reach Postgres, which threw `22P02 invalid_text_representation` uncaught - an unhandled 500. Fixed with NestJS's built-in `ParseUUIDPipe` applied explicitly at each `@Param()` (not inferred via `emitDecoratorMetadata`, so it isn't affected by the same esbuild metadata gap that broke automatic DTO validation earlier in this project - see Task 7 above). Verified live against the real running server: malformed ids now 400, valid-but-nonexistent ids still correctly 404 (no regression).

**P0-2 + P0-3 - warnings in context, and fact-version-level grounding (one combined schema change).** The audit's most important finding: the grounding validator only checked that a `placeId` existed, never whether a *claim* about that place was actually traceable to a fact. And seeded warnings were never read by itinerary generation at all. Both are fixed by the same redesigned AI output contract:
- `src/travel-intelligence/warning-candidates.ts` - `queryWarningCandidates`, reading seeded warning facts (with their `fact_version_id`) the same read-only-Postgres way places are read. `src/advisory/get-warnings.ts` (`GET /advisories`) now builds on this instead of duplicating the query.
- `CandidateSet` (`candidate-set.ts`) gained a `warnings` array, assembled by `buildCandidateSet` alongside attractions/restaurants/shops - "stored warning facts → Travel Intelligence → constrained AI context", per spec.
- `src/ai/itinerary-plan.ts` (replaces `day-plan.ts`): every item is now `{ itemType: 'place' | 'warning', placeId?, reason, factReferences: string[] }` - `factReferences` names the exact `fact_version_id`(s) the item is grounded in, not just an entity id.
- `src/ai/ai-orchestration-service.ts` (`generateDayPlan` → `generateItinerary`): the deterministic validator now checks, per item, that every `factReferences` id was actually supplied in context (not just that a `placeId` exists) - and, for a `'place'` item, that it cites *its own* fact_version specifically, not merely some other real id (a pure id-membership check, not prose parsing - stops an item from citing an unrelated fact and still passing). A `'warning'` item has no `placeId` and is validated purely on its `factReferences`. The system prompt instructs the model to phrase any included warning as a static note ("Note:"), never as live/current monitoring.
- `itinerary_items` gained an `item_type` column (migration `1700000004000`) so a warning item (`place_id = null`) is explicit rather than inferred.
- Three-level test coverage, per the stabilization spec: unit (`ai-orchestration-service.test.ts` - a warning with a real fact_version succeeds; a real place citing a *fabricated* fact_version is rejected; a real place citing its own real fact_version succeeds; a real place citing someone else's real fact_version, e.g. the warning's, is rejected; a day-count mismatch is rejected), integration (`generate-itinerary.test.ts` - a seeded warning flows from the database into a persisted itinerary item with correct provenance), and e2e (`http/app.e2e.test.ts` - the same flow through real HTTP, with the warning's source clearly exposed as `'Manually curated Phase 1 seed content'`, never presented as live).

**P0-4 - real trip duration.** `persist-itinerary.ts` used to hardcode `day_number = 1` - every itinerary was exactly one day regardless of what was asked. `CreateItineraryDto` gained `startDate`/`endDate` (`@IsDateString()`); `src/itinerary/trip-dates.ts` (`parseTripDuration`) validates the range (end not before start, capped at 14 days - a placeholder constant, not a specified requirement) and computes `numberOfDays`, which `AiOrchestrationService` now requires the model's `days` array to match exactly (a wrong count is treated as an invalid response, same as any other schema mismatch). `itineraries` and `itinerary_jobs` both gained `start_date`/`end_date` columns (migration `1700000005000`) so a fetched itinerary or job status shows its own requested dates. `persist-itinerary.ts` now loops over the model's `days` array instead of inserting a single hardcoded row. Tested for 1-day, 2-day, and 3-day trips producing exactly that many `itinerary_days` rows, plus invalid-range and malformed-date-format rejection, at the unit (`trip-dates.test.ts`), integration, and e2e levels.

**Verification:** full test suite (58 tests across 13 files, up from 41/12) green across repeated runs; all 6 migrations roll back and reapply cleanly from scratch; existing provenance assertions (item → fact_version → source) re-verified unchanged for both place and warning items; P0-1 and P0-4 additionally confirmed live against the real running server (`npx tsx src/main.ts`) via direct `curl` - not just the test harness. A real POST with no local LLM endpoint configured in this sandbox was also verified to degrade gracefully (`202` accepted, job asynchronously marked `failed` with a clear `"fetch failed"` error, no server crash) rather than hang or 500.

---

## Post-stabilization: itinerary place details

A traveler-perspective review after the stabilization pass found that a generated itinerary, while fully provenance-traceable, was not actually actionable: an item carried only a name and a free-text `note` - no location, no address, no category, nothing a real traveler could use to get there. `queryPlacesByCategory` (and the raw provider tags captured at ingestion) already had this data; it simply never made it past the candidate stage into the itinerary response.

`src/itinerary/get-itinerary.ts`'s `ITEM_SELECT` now also joins in `places.category` and the place's coordinates (`ST_Y`/`ST_X` on the existing `geography(Point)` column, the same cast `query-places.ts` already uses), and reads the item's own `referenced_fact_version_id` value (the provider's raw tags, e.g. OSM `addr:*`/`opening_hours`/`phone`/`website`) to compose a best-effort address and extract opening hours/phone/website - mirroring the existing `extractCuisine`/`extractShopType` pattern in `food`/`shopping`. Every `ItineraryItemWithProvenance` now carries a `place` object (`category`, `latitude`, `longitude`, `address`, `openingHours`, `phone`, `website`) for a `'place'` item, and `null` for a `'warning'` item (a warning has no location - never fabricated). Purely additive on the read side: no AI/prompt change (the model already only ever picks a real `placeId`; this just surfaces more of what was already known about it), no new migration, no new external call. Tested end-to-end (`generate-itinerary.test.ts`, `app.e2e.test.ts`) including the case where a place's raw tags simply don't have an address/opening-hours - extraction degrades to `null`, never throws or omits the field.

Two further traveler-facing gaps were identified but deliberately deferred: the same place can currently be recommended on more than one day of a multi-day trip (no cross-day duplicate-avoidance), and items within a day carry no time-of-day ordering/scheduling structure.
