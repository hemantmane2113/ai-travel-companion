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

**Next:** Travel Intelligence (deterministic filter/rank over `places`) + AI Orchestration (local `OpenAICompatibleAdapter`) + the itinerary job flow (§9), to close the full Phase 1 vertical slice.
