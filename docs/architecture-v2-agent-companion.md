# AI Travel Companion — V2 Agent Architecture (Final Decision Document)

**Status: proposed, pending your approval. No implementation code has been
written against this document yet.** It resolves the open questions from
the migration audit (see "Post-stabilization" note at the end of
`docs/architecture-plan.md`) and CLAUDE.md's architectural intent, grounded
in the actual current repository (NestJS, no Next.js app present,
Postgres+PostGIS, provenance chain, itinerary generation, grounding
validator, Redis provisioned but unused, 58 tests).

**Revision 2** (this version): incorporates five refinements from a
stress-test review against all 14 representative product queries: (1)
entity/reference resolution elevated to a named Supervisor responsibility
with a mandatory clarify-don't-guess rule, (2) Comparison Agent's `domain`
parameter changed from a single value to a set (one request can compare
hotels/flights/trains/buses simultaneously), (3) the fifth agent renamed
back to **Booking Management / Cancellation Agent** with an explicit
modify (native or cancel+rebook composite) workflow, (4) cancellation-policy
lookup split out as a standalone tool usable outside an active
cancellation, (5) provider-side booking idempotency (client idempotency
key + mandatory status-check before any retry). None of these change the
agent count, the data model, or the phased plan — they refine boundaries
within the same design.

---

## A. Final architecture overview

```text
                              USER
                                |
                                v
                    Companion API (NestJS, new)
                    POST /companion/messages
                    GET  /companion/conversations/:id
                                |
                                v
                     SUPERVISOR AGENT (new)
   resolve entity refs -> classify intent -> route ->
   maintain task state -> enforce confirmation boundary ->
   compose response  (ask user to clarify, never guess)
                                |
        +----------+-----------+-----------+-----------+
        |          |           |           |           |
        v          v           v           v           v
   Q&A tool   Planning     Comparison   Booking    Booking Mgmt /
  (capability)  Agent    (multi-domain)   Agent    Cancellation
        |          |           |           |           |
        +----------+-----------+-----------+-----------+
                                |
                                v
                        TOOL LAYER (new + existing)
      Travel Intelligence | Retrieval(RAG) | Provider Adapters
                                |
                                v
                     DOMAIN / DATA SERVICES
   Places | Food | Itinerary | Hotels | Transport | Bookings
                                |
                +---------------+---------------+
                v                               v
      PostgreSQL + PostGIS                    Redis
   (source of truth, all state)     (deferred until Phase 5+;
                                      rate-limiting / provider
                                      concurrency control)
```

The existing V1 pipeline (`generate-itinerary.ts` → Travel Intelligence →
`AiOrchestrationService` → grounding validator → persistence) is **not
replaced**. It becomes the implementation of the Planning Agent, called
by the Supervisor instead of by the HTTP controller directly.

---

## B. Component architecture — KEEP vs. NEW

| Layer | Existing component | Disposition |
|---|---|---|
| HTTP | `ItinerariesController`, `/food`, `/shopping`, `/advisories` | **Keep**, become secondary/direct routes; primary traffic moves to the new companion endpoint |
| HTTP | Companion endpoint | **New** |
| Orchestration | `AiOrchestrationService.generateItinerary()` | **Refactor**: split into (1) a generic "call model → parse → validate against supplied facts" primitive, (2) the Planning Agent's own prompt/schema |
| Orchestration | Supervisor, Planning, Comparison, Booking, Booking Management/Cancellation agents | **New** |
| Reasoning | Travel Intelligence (`candidate-set.ts`, `query-places.ts`, `warning-candidates.ts`) | **Keep + generalize**: made independently callable outside the itinerary job |
| Grounding | Deterministic validator pattern in `AiOrchestrationService` | **Keep + generalize** to comparison/booking narrative |
| Data | provenance chain (`sources`/`facts`/`fact_versions`) | **Keep as-is** |
| Data | itinerary schema | **Keep as-is** |
| Data | `conversations`/`messages`/`tasks`/`bookings`/… | **New** (§F) |
| Providers | `PlacesProvider`/`OsmOverpassAdapter` | **Keep as the template** |
| Providers | Hotel/Transport/Booking provider interfaces | **New** |
| Infra | Redis | **Keep provisioned, stay unused** until a phase actually needs it (§L) |
| Frontend | Next.js | **New**, deliberately late (§ frontend decision below) |

---

## Frontend decision

**No Next.js app exists in this repository** (confirmed: no `frontend/`,
no `apps/`, no Next.js dependency anywhere). Nothing in the repo suggests
a separate frontend repo exists either — CLAUDE.md and the transition plan
both assume one is being "preserved," which is simply inaccurate for this
repo as it stands today.

**Decision: build the frontend late, and don't let its absence block
backend work.** Concretely:

- Backend work (Supervisor, agents, tools) proceeds against the existing
  HTTP surface plus the new companion endpoint. All of it is testable via
  the existing e2e pattern (`supertest` against the real Nest app) without
  any UI.
- Introduce Next.js **only once the companion API contract is stable
  enough to be worth building against** — concretely, after Phase 3 (§N):
  Supervisor + Q&A + one comparison capability working end-to-end. Building
  UI earlier risks rework against a moving conversational contract.
- Until then, the API is exercised via tests, curl, and (optionally) a
  disposable local HTML/console harness — not a production frontend
  investment.
- When Next.js does start, it consumes the companion endpoint's
  message/task-state model directly — no separate BFF layer needed given
  the modular-monolith constraint.

---

## C. Agent architecture

### Which capabilities are real agents, and why

CLAUDE.md §19 explicitly warns against "too many tiny agents." Applying
that test (does this need multi-step tool orchestration and its own
bounded state, or is it one deterministic call?) to every capability
listed in your prompt:

| Capability | Real agent? | Reasoning |
|---|---|---|
| Supervisor / Travel Companion | **Yes** | The only top-level agent: intent, routing, state, confirmation gate, response composition. |
| Planning Agent | **Yes** | Genuinely multi-step: gather candidates, allocate days, generate narrative, validate, persist. Already exists in spirit as `generate-itinerary.ts`. |
| Research / Q&A | **No — a capability/tool path**, not an agent | CLAUDE.md's own §5.3 heading already says "Capability," not "Agent." One retrieval call + one LLM synthesis call, invoked directly by the Supervisor. No multi-step loop needed for "what should I eat here?" |
| Hotel Comparison Agent | **Merged into one Comparison Agent** (see below) | |
| Flight/Train/Bus Comparison Agents | **Merged into the same Comparison Agent**, parametrized by a domain **set** | Search→normalize→compare is the *same workflow shape* for hotels, flights, trains, buses — only the provider adapter set differs. Three-to-four near-identical agents is exactly the anti-pattern §19 warns against. One `ComparisonAgent(domains: Domain[], providers[])` replaces all of §5.4+§5.5, and handles a single request spanning multiple domains at once (query 7) without needing a coordinating meta-agent. |
| Restaurant/Food Agent | **No — a tool/capability**, not an agent | No multi-provider price comparison exists for restaurants today (unlike hotels/flights); it's single-source ranked recommendation, i.e. exactly what `recommend-food.ts` already is. Stays a tool the Supervisor or Planning Agent calls directly. If real reservation-platform integration arrives later, "restaurant" becomes one more domain the Booking Agent parametrizes over — still no new agent. |
| Booking Agent | **Yes**, one agent parametrized by domain (hotel/flight/train/bus/restaurant) | Workflow shape (prepare→show→confirm→execute→verify→persist) is identical across domains; only the `ProviderAdapter` differs. |
| Booking Management / Cancellation Agent | **Yes, separate from Booking** | Different trigger, different policy lookups (refund/fee), different state transitions (unwind vs. commit), **plus modification** (native provider `modify()`, or a Supervisor-coordinated cancel+rebook composite — see §I). CLAUDE.md itself keeps these as separate headings (§5.7 vs §5.8) for the same reason, and names "modification" explicitly under §5.8. |

**Final count: 5 real agents** — Supervisor, Planning, Comparison,
Booking, **Booking Management / Cancellation**. Everything else (Q&A,
restaurant discovery, Travel Intelligence, cancellation-policy lookup) is
a tool or deterministic service the agents call.

### Supervisor: entity/reference resolution (new — first-class responsibility)

Before intent routing runs, the Supervisor resolves any reference in the
incoming message to something concrete from the active conversation's
open task — "the second one," "this hotel," "the cheaper one," "the train
I selected," "my hotel booking." This is not a side effect of routing; it
is its own explicit step, because getting it wrong (silently guessing the
wrong offer or booking) is a direct hallucination-adjacent safety issue,
not just a UX nicety.

**Resolution order, deterministic-first:**

1. **Clean ordinal/positional reference** ("the second one," "the first
   option") — resolved by a pure array-index lookup into the persisted,
   domain-tagged offer list on `tasks.result`. **Zero LLM calls.**
2. **Attribute-filtered reference** ("the cheaper one," "the one near
   Karol Bagh," "the train") — resolved by a deterministic filter over the
   same persisted list's structured fields (price, location, `domain`).
   **Zero LLM calls** when the filter maps directly onto a stored field.
3. **Genuinely free-text reference** that doesn't reduce to (1) or (2) —
   the LLM is used *only* to parse the reference into an index/filter
   against the already-persisted list; it is never used to recall or
   reconstruct what the offer/booking actually was.
4. **Ambiguous or zero-match** (the reference could mean more than one
   persisted item, or matches none) — the Supervisor **must ask the user
   a clarifying question** ("Did you mean the Agoda hotel or the
   MakeMyTrip one?"). **It never guesses**, and it never silently falls
   back to "the most recent thing mentioned" as a default.

This same mechanism resolves "my hotel booking" (query 11) against
`bookings` filtered by user + active status, and "the Agoda option" (query
8) against a `provider` field on the persisted comparison result.

### Responsibility split (per CLAUDE.md §3, made concrete)

| Concern | Owner |
|---|---|
| "What does the user want?" | Supervisor (LLM-assisted classification, see §G) |
| "Which workflow applies?" | Supervisor (mostly deterministic routing, see §G) |
| "What are the valid candidates/constraints?" | Travel Intelligence (deterministic) |
| "What does the plan/comparison/answer say in natural language?" | The relevant agent's one LLM call, constrained to a supplied candidate/offer set |
| "Is this claim actually grounded?" | Deterministic validator (generalized from today's `AiOrchestrationService` check) |
| "What's the real price/availability?" | Provider adapter response — never the LLM |
| "Did the user actually confirm this booking?" | Supervisor's deterministic confirmation gate (§I) — never inferred by the LLM |

---

## D. Tool architecture

Tools are plain, testable TypeScript functions/services agents call —
exactly the existing codebase's style (no new framework). Each agent has
an explicit, small tool list; it does not have open-ended access to "every
tool in the system."

| Tool | Backing code (existing or new) | Used by |
|---|---|---|
| `buildCandidateSet` | `candidate-set.ts`, made callable standalone (refactor) | Planning, Q&A |
| `queryWarningCandidates` | `warning-candidates.ts` | Planning, Q&A |
| `recommendFood` / `recommendShopping` | existing, unchanged | Q&A, Planning |
| `retrieveKnowledge(query)` | **new**, RAG (§ RAG below) | Q&A, Planning (visa/advisory questions) |
| `searchHotels(criteria)` | **new**, calls `HotelProvider` adapters in parallel | Comparison |
| `searchTransport(criteria, domains: TransportDomain[])` | **new**, fans out to `{Flight,Train,Bus}Provider` adapters in parallel per requested domain, independent per-domain timeout, partial results on a domain/provider failure | Comparison |
| `prepareBooking(offerId)` / `executeBooking(...)` | **new**, `executeBooking` accepts/generates a client idempotency key (§I) | Booking |
| `getCancellationPolicy(offerRef \| bookingRef)` | **new, standalone** — reads a structured field off a `NormalizedOffer`/`bookings` row directly when present; falls back to `retrieveKnowledge` (RAG) only for unstructured terms documents | **Q&A** (informational, e.g. query 14) **and** Booking Management/Cancellation (internal step) |
| `executeCancellation(...)` / `modifyBooking(...)` | **new** — `modifyBooking` tries a provider-native `modify()` first, else the Supervisor composes cancel+rebook (§I) | Booking Management/Cancellation |
| generic structured-generation primitive (extracted from `AiOrchestrationService`) | **refactor** | every agent's "narrate/synthesize" step |

---

## E. Provider architecture

Generalizes the existing `PlacesProvider`/`OsmOverpassAdapter` pattern
(kept as the template) to every external domain, with an explicit
**read/search vs. write/booking split**, because the two have completely
different safety, idempotency, and error-handling requirements:

```text
ReadProvider<T>            WriteProvider<T>
  search(criteria)            prepare(offer) -> hold/quote
  -> normalized offers[]      execute(preparedBooking, idempotencyKey)
                                 -> confirmation | already-executed (§I)
                               cancel(bookingRef) -> cancellation result
                               modify?(bookingRef, changes) -> new state
                                 (optional — only if the provider supports
                                 native modification; absent otherwise,
                                 never assumed)
                               getStatus(bookingRef) -> current state
                                 (used to resolve an ambiguous/timed-out
                                 execute before any retry — §I)
```

```text
HotelProvider      = ReadProvider<HotelOffer> & WriteProvider<HotelBooking>
  |- AgodaAdapter
  |- MakeMyTripAdapter

FlightProvider      = ReadProvider<TransportOffer> & WriteProvider<...>
TrainProvider        = ReadProvider<TransportOffer> & WriteProvider<...>
BusProvider           = ReadProvider<TransportOffer> & WriteProvider<...>
RestaurantProvider  = ReadProvider<Place> (existing `places`/OSM path) — no WriteProvider until real reservation integration exists
```

A given real provider may implement only `ReadProvider` (comparison-only,
no booking capability) — the architecture must not assume every provider
supports both. **No mocked/sandbox/real distinction is ever hidden**: every
adapter declares its integration level, and the API response for any
comparison/booking result must say which kind of result it is (mirrors
CLAUDE.md §25's "distinguish mocked / sandbox / real / real-booking").

**LLM never invents price, availability, or booking/cancellation status —
those fields only ever come from a `ProviderAdapter` response object**,
enforced the same way the itinerary validator enforces "no fabricated
`placeId`" today: the agent's LLM call is only allowed to narrate over an
already-fetched, already-normalized offer object; numeric/status fields
in its output are ignored/overwritten by the deterministic values, never
trusted from the LLM's own JSON.

---

## F. Data architecture (entities, no migrations yet)

| Table | Status | Purpose |
|---|---|---|
| `sources`, `facts`, `fact_versions` | Keep | durable/versioned fact provenance |
| `places`, `destinations` | Keep | |
| `itineraries`, `itinerary_days`, `itinerary_items`, `itinerary_jobs` | Keep | Planning Agent's persistence layer |
| `users` | **New** | FK target for everything below. Real auth is deferred (§ risk), but the column/table should exist early — start with a single dev/anonymous user if needed, explicitly flagged as incomplete. |
| `conversations` | **New** | one thread per user session |
| `messages` | **New** | `role` (user/assistant/tool), `content`, `structured_payload jsonb`, `conversation_id` |
| `tasks` | **New** | generalization of `itinerary_jobs`: `task_type` (planning\|comparison\|booking\|cancellation), `status`, `input jsonb`, `result jsonb`, `conversation_id`. **Not** a replacement for `itinerary_jobs` yet — new task types use `tasks`; unifying `itinerary_jobs` into `tasks` is a later, separate refactor once the pattern is proven (avoid a risky big-bang migration now). |
| `hotel_offers` | **New** | normalized `HotelOffer` (per CLAUDE.md §12), persisted **per-task**, not long-lived cache — hotel prices are volatile, unlike `places` |
| `transport_offers` | **New** | analogous, `mode` column (flight\|train\|bus) |
| `bookings` | **New** | `domain`, `provider`, `provider_booking_ref`, `offer_snapshot jsonb` (exact booked offer, for audit), `status` |
| `booking_events` | **New** | append-only audit log: created / provider_confirmed / provider_failed / cancel_requested / cancelled / … — this *is* the evidence trail behind "never claim booked until provider confirms" |
| `provider_operations` | **New** | infra-level tracing of every provider call (latency, status, redacted request/response) — separate from `booking_events`, which is business-state history |
| `user_preferences` | **Deferred** | budget range, food/hotel prefs, travel style — not required for the first several phases |

**Restaurant offers get no new table.** Unlike hotels/flights, there's no
multi-provider price comparison for restaurants today — discovery stays on
the existing `places`/`food` path. A `restaurant_offers`-shaped table only
becomes justified once a real reservation-platform integration exists.

---

## G. AI / GenAI / RAG architecture

Being explicit, per your instruction not to call every LLM call an
"agent":

| Layer | What it is | Where used |
|---|---|---|
| **LLM reasoning** | A single, stateless model call with a constrained prompt and a JSON schema it must match | Intent classification (fallback only, see below), itinerary narrative, comparison explanation, Q&A answer synthesis |
| **Agent orchestration** | Deciding *which* tools to call, *in what order*, and whether to ask the user something — implemented as plain TypeScript control flow, not an LLM free-reasoning loop | Supervisor, Planning, Comparison, Booking, Booking Management/Cancellation |
| **Deterministic business logic** | Travel Intelligence: filtering, ranking, distance, feasibility, budget math | Called *by* agents, never replaced by them |
| **Tools** | Typed functions wrapping the above, plus provider adapters and retrieval | Called by agents |
| **External providers** | Real/sandboxed/mocked systems behind `ReadProvider`/`WriteProvider` | Called only by tools/adapters, never directly by an agent or the LLM |

**Relationship chain:**

```text
Supervisor Agent
   -> resolves entity/reference to the active task, if any (deterministic-
      first, clarifying question on ambiguity — never a guess)
   -> classifies intent (mostly deterministic, LLM fallback for ambiguity)
   -> selects: Q&A tool | Planning Agent | Comparison Agent (domain set)
      | Booking Agent | Booking Management/Cancellation Agent
        -> agent calls Travel Intelligence / retrieval / provider adapters (tools)
             -> deterministic results come back
        -> agent makes ONE LLM call to narrate/synthesize over those results
        -> generalized grounding validator checks the LLM output against what was actually supplied
   -> Supervisor composes the final user-facing response and updates task state
```

### Intent routing: hybrid, not LLM-only

Per CLAUDE.md §19 ("do not make every request invoke an LLM") and the
local-CPU constraint, the Supervisor's router is **deterministic-first**:

1. Fast pattern/keyword pre-classification (`"book"`/`"confirm"` →
   action-in-progress-task check; `"compare"` → Comparison; date range +
   `"plan"`/`"trip"` → Planning; else → Q&A default).
2. Only when the deterministic signal is ambiguous does the router make
   one small, cheap LLM call to classify intent — never the full
   generation call.

This keeps the common cases fast and cheap on CPU, and reserves LLM calls
for what actually needs judgment.

### RAG — exactly where it belongs

| Question type | Path |
|---|---|
| "What are the visa/safety requirements?" | **RAG** — today this is 2 hardcoded seeded strings; needs real unstructured-document retrieval |
| "How far is Red Fort from India Gate?" | **Travel Intelligence** (deterministic distance calc) — never RAG |
| "Hotels within 2km of Karol Bagh" | **Structured query / provider search** — never RAG |
| "What should I eat at Indore Khau Galli?" | **Places/Food tool** (structured, ranked) — RAG only if/when unstructured local-food guide content is ingested |
| Cancellation policy fine print | **RAG** over provider policy documents, once such documents exist |

**Start RAG on Postgres full-text search (`tsvector`) over a new
`knowledge_documents` table** — not a vector DB. This reuses existing
infrastructure and satisfies §19/§23 ("don't add infra without measured
justification"). Move to embeddings/pgvector only if retrieval quality is
measured to actually need it.

---

## H. Trust / grounding architecture

The existing validator pattern (fact_version-reference membership check)
generalizes cleanly:

- **Durable facts** (places, warnings, retrieved knowledge chunks) keep
  the existing `fact_version`→`source` chain, unchanged.
- **Volatile commercial data** (hotel/transport offers, booking state) use
  a **lighter, separate provenance pattern**: `provider` + `source_url` +
  `retrieved_at` fields directly on the offer/booking row, not the
  fact_version machinery. Forcing every price tick through a versioned
  fact chain would be architecturally wrong — that chain is for
  slowly-changing curated facts, not point-in-time commercial quotes.
- **Comparison/booking narrative** gets the same treatment the itinerary
  narrative gets today: the LLM's prose must reference only offers/facts
  actually supplied in its context; any numeric claim (price, distance,
  rating) is cross-checked against the deterministic source object, not
  trusted from the LLM's text.

"Why does the system believe this?" now has two honest answers depending
on data type: "sourced from `<source>`, versioned, confidence `<x>`" for
durable facts, or "quoted by `<provider>` at `<retrieved_at>`, not yet
re-verified" for a live offer — the UI/response should say which.

---

## I. Booking / cancellation / modification architecture

```text
search -> compare -> user selects -> prepare booking
  -> show final price/details (re-verify against provider, since time
     has passed since compare)
  -> explicit user confirmation (deterministic check, see below)
  -> Booking Agent -> Provider Adapter (write, with idempotency key)
  -> provider confirmation
  -> persist booking + booking_event
  -> return confirmation
```

**Confirmation is enforced deterministically, not inferred by the LLM.**
Concretely: at "prepare" time, the task stores a fingerprint of the exact
offer (provider + offer id + price + cancellation policy + expiry). The
Supervisor only invokes the Booking Agent when the user's next message is
an affirmative reply **to that specific pending task** — checked in code,
not assumed from sentiment. Before executing, the Booking Agent
re-verifies price/availability with the provider; if it changed, the flow
returns to "show final details" rather than silently booking something
different from what was confirmed.

Cancellation follows the mirror flow (§CLAUDE.md §14), driven by the
**Booking Management / Cancellation Agent**, with the same
deterministic-confirmation discipline, and the database is never updated
to `cancelled` until the provider confirms.

### Idempotency (our side + provider side)

Two distinct failure modes, two distinct guards:

1. **Our side — a double-click or retried client request.** Booking
   execution is guarded by a DB-level conditional transition
   (`awaiting_confirmation → executing`, only once) keyed on the task id.
   A second concurrent request against the same task finds zero rows
   updated and no-ops.
2. **Provider side — the write call itself times out.** This is a
   *different* problem: our own DB guard already stopped a double
   *invocation*, but the provider call's outcome is now genuinely
   unknown — it may have booked, may not have. `executeBooking` always
   generates (or reuses, on a retried task) a client idempotency key and
   passes it to the provider where the provider API supports one. **On a
   timeout or ambiguous response, the Booking Agent never blindly
   retries the write.** It first calls `getStatus(bookingRef |
   idempotencyKey)` against the provider; only once the provider
   confirms the original attempt did *not* go through does it retry —
   with the same idempotency key, not a new one. The idempotency key and
   the resulting execution state (`unknown`/`confirmed`/`not-executed`)
   are recorded on the `bookings`/`tasks` row, not just implied by
   whatever the last HTTP response happened to say.

### Modification (new — the composite workflow)

"I changed my dates — modify/cancel the relevant bookings" is not plain
cancellation. The Booking Management / Cancellation Agent handles it as:

```text
identify existing booking
  -> does the provider adapter implement modify()?
       YES -> call it directly -> provider confirms new state
              -> persist + booking_event -> done
       NO  -> composite workflow, coordinated by the SUPERVISOR
              (not by the agent itself, to keep the agent's own
              scope bounded to one domain's write operation):
                1. Booking Management Agent: look up cancellation
                   consequences (refund/fee) for the existing booking
                   -- does not execute yet
                2. Comparison Agent (search only, not a full comparison
                   turn) or Booking Agent's own prepare step: get a
                   fresh price quote for the equivalent new-dates offer
                   -- does not execute yet. Exactly one of these owns
                   this step per implementation (decided in Phase 9,
                   not this document) -- it is never done twice.
                3. Supervisor presents BOTH together as ONE combined
                   confirmation: "cancelling costs you ₹X (fee/refund
                   delta), the new dates cost ₹Y — net ₹Z. Confirm?"
                4. ONLY on that single explicit confirmation:
                   Booking Management Agent executes the cancellation,
                   THEN Booking Agent executes the new booking
                5. persist both booking_events; if step 4's rebooking
                   fails after the cancellation already succeeded, the
                   user is told plainly (never silently) and the
                   conversation is left in a state a human can resolve
```

**Never two independent confirmations for one user-requested
modification** — a user who confirms "yes, cancel" without knowing the
rebooking costs ₹8,000 more has not actually confirmed the modification
they asked for.

---

## J. Conversation / task-state architecture

| State | What it tracks | Storage |
|---|---|---|
| Conversation state | What's currently being discussed | `conversations` + recent `messages` |
| Task state | The in-flight agent workflow (comparison results, prepared booking, etc.) | `tasks.input`/`tasks.result`, keyed to the conversation |
| User preferences | Longer-term, cross-conversation | `user_preferences` (deferred) |
| Booking state | Actual external commitments | `bookings` + `booking_events` |

**Resolving "I like the second one":** the ordered offer list from the
comparison result is persisted verbatim in `tasks.result`, **each item
tagged with its `domain`/`provider`** (not re-derived) — this is what
lets "the train I selected" (query 10) disambiguate correctly even when
the same task's list also contains flights and buses, from a
multi-domain comparison (§E). Resolution mechanics are the Supervisor's
responsibility, detailed in §C — deterministic index/attribute lookup
first, LLM parse-only as a fallback, explicit clarifying question on
ambiguity, never a guess.

**Context-window discipline:** the prompt sent to the model on any turn is
built from a bounded recent-message window plus a rolling summary of
older turns, not the full conversation history — necessary for local-CPU
model quality and latency, and consistent with the existing candidate-cap
pattern already used for itinerary generation.

---

## K. Request-flow examples

**1. "What should I eat at Indore Khau Galli?"**
Supervisor (deterministic router: no dates, no "book"/"compare" → Q&A) →
`recommendFood`/`retrieveKnowledge` tool → one LLM synthesis call → answer.
No task row created beyond a lightweight message log. May *offer* (not
force) broader Indore assistance.

**2. "I am visiting Delhi for 3 days. Plan a trip for me."**
Supervisor → Planning Agent → `buildCandidateSet` + `queryWarningCandidates`
→ one LLM generation call (today's `AiOrchestrationService`, refactored) →
grounding validator → persist itinerary → response with provenance.

**3. "I am visiting Delhi for 3 days and want to visit Red Fort, India Gate
and Qutub Minar."**
Same as #2, but the three places are resolved to real `placeId`s first
(deterministic lookup) and passed into the candidate set as hard
must-include constraints; Travel Intelligence, not the LLM, guarantees
they appear.

**4. "Compare hotels near Karol Bagh."**
Supervisor → Comparison Agent, invoked with `domain: ['hotel']` (a
single-element set — the same call shape example 7 uses with three) →
parallel `HotelProvider` adapter calls (`Promise.allSettled`,
per-provider timeout) → normalize → persist `hotel_offers` under a new
task → one LLM explanation call → response. Task stays
`awaiting_selection`.

**5. "I like the second one." → "Book it through Agoda."**
Supervisor loads the open task, resolves "second one" against the
persisted offer list, moves to `prepared` (re-verifying with Agoda) →
shows final details → waits for explicit confirmation → **only on
confirmation** invokes Booking Agent → Agoda write adapter → provider
confirmation → persist `bookings`/`booking_events` → confirmation message.

**6. "Cancel my hotel. I found a cheaper one."**
Supervisor → entity resolution ("my hotel" against `bookings`, zero or
one match — clarify if more than one) → Booking Management/Cancellation
Agent → `getCancellationPolicy` (structured field on the booking, no RAG
needed) → presents consequences → explicit confirmation → provider
cancel call (with idempotency key) → update `bookings`/`booking_events`
only after provider confirms.

**7. "Compare flights, trains and buses from Pune to Delhi."**
Supervisor → Comparison Agent invoked **once** with `domain: ['flight',
'train', 'bus']` → `searchTransport` fans out to all three provider
families in parallel, each with its own timeout → results merged into one
domain-tagged offer list, persisted to `tasks.result` → if, say, the bus
provider times out, the response still returns flight+train results with
a note that bus results are unavailable, rather than failing the whole
comparison.

**8. "Book the train I selected."**
Supervisor resolves "the train" against the domain-tagged list from
example 7 (filters to `domain='train'`, then the prior selection/ordinal)
→ same prepare→revalidate→confirm→execute flow as example 5, with the
`TrainProvider` write adapter.

**9. "I changed my travel dates. Modify/cancel the relevant bookings."**
Supervisor → Booking Management/Cancellation Agent checks for a native
`modify()` on the existing booking's provider; if absent, the Supervisor
runs the cancel+rebook composite from §I — cancellation consequences and
new-dates price gathered *without executing either*, presented as one
combined confirmation, and only on that single confirmation are both
operations executed in sequence.

**10. "What is the cancellation policy for this hotel?"**
Supervisor (deterministic router: no "cancel my booking," this is a
question, not an action) → Q&A path → `getCancellationPolicy` called
directly (not via the Booking Management Agent, since there's no booking
to cancel yet) → reads the structured field off the relevant
`NormalizedOffer`/`bookings` row if one is in context, else RAG only if
the terms require document-level detail → answer.

---

## L. Bottleneck / risk analysis

| Bottleneck | Mitigation |
|---|---|
| Single Supervisor as a chokepoint | Keep it mostly deterministic-routed and stateless (all state in Postgres) so it's trivially horizontally replicable |
| LLM latency on local CPU | Hybrid router minimizes LLM calls; small/scoped prompts; async 202+poll for any LLM-touching request; Model Gateway allows a smaller/faster model for routing vs. a larger one for synthesis |
| Local CPU model reliability for structured tool-calling | Keep tool selection mostly deterministic (router), not LLM-driven; the LLM only ever narrates over an already-fetched, already-validated candidate set — same posture that already works for itinerary generation today |
| Provider rate limits / failures | `Promise.allSettled` + per-provider timeout + partial-result handling (already required by §19); adapter-level backoff/circuit-breaking |
| Comparison normalization drift | Each adapter is solely responsible for mapping into the canonical offer shape; a validation step rejects malformed normalized offers before the LLM sees them |
| Stale offers / booking races / duplicate bookings (our side) | Re-verify price/availability at confirm time, not just compare time; DB-level conditional state transition keyed on task id prevents double-execution |
| **Duplicate bookings (provider side, ambiguous timeout on the write call)** | **New (§I)**: client idempotency key passed to the provider where supported; on timeout/ambiguous response, a mandatory `getStatus` check before ever retrying — never a blind retry of a write |
| Cancellation races | Same state-machine discipline: mutations to a `bookings` row are guarded by its current status, not read-then-write |
| **Entity-reference ambiguity** ("this hotel" with no clear antecedent, or matching more than one persisted item) | **New (§C)**: the Supervisor's deterministic resolution asks a clarifying question on zero or multiple matches — it never guesses or defaults to "most recent" |
| **Multi-domain comparison fan-out cost** (query 7 — three provider families in one request) | **New (§E/§K)**: per-domain timeout is independent, so one slow domain never blocks the others; partial results returned with an explicit note on what's missing |
| Hallucination / provenance gaps | Generalized grounding validator: numeric/status claims always come from the deterministic object, never the LLM's own text |
| Long-running / infinite tool loops | Hard cap on tool-calls per task turn (e.g. 5–6) with a deterministic fallback response if exceeded |
| Retry storms | Exponential backoff + max-retry cap per provider adapter |
| Redis/job failures | Jobs are DB-status-backed, not memory-backed, so a crashed process is recoverable — **but note: this reconciliation sweep (finding tasks stuck in `processing`) doesn't exist even for today's `itinerary_jobs` — a real existing gap to fix as part of generalizing the pattern, not a new-architecture-only concern** |
| Database contention | Index `tasks`/`messages` on `conversation_id`/`status`; never hold a DB transaction open across a provider call |
| Context-window growth | Bounded recent-window + rolling summary, not full history, in every prompt |

---

## Local-first / ₹0-cost feasibility

**Where a local CPU model is likely insufficient**, named explicitly per
your instruction:

1. Reliable strict-JSON tool selection across many candidate tools —
   mitigated by keeping the *router* deterministic and giving each agent
   only a small, fixed tool list, so the model is never asked to choose
   among many options.
2. Long multi-turn context with large offer/candidate sets — mitigated by
   the context-window discipline above (bounded window + summary), the
   existing candidate-cap pattern, and per-domain prompt scoping.
3. Latency for a synchronous-feeling UX — mitigated by the existing
   202/poll async pattern, already proven for itinerary generation.

**No paid API is a V1 dependency.** The existing `LlmProvider`/
`OpenAiCompatibleAdapter` abstraction already satisfies this — it's the
Model Gateway CLAUDE.md §29 asks for. A paid provider remains an optional,
swap-in adapter via `AI_BASE_URL`/`AI_MODEL`/`AI_API_KEY`, never assumed.
Benchmark-driven model selection (§29.1) is future work: a small internal
eval harness (representative prompts + expected structured-output shape)
run against candidate local models before picking defaults — not
something this document decides today.

---

## M. KEEP / REFACTOR / GENERALIZE / ADD / DEFER

| Component | Disposition |
|---|---|
| Provenance chain, `resolveCurrentVersion` | **KEEP** |
| `PlacesProvider`/`OsmOverpassAdapter`, ingestion pipeline | **KEEP** |
| Itinerary schema, job lifecycle, persistence, provenance read chain | **KEEP** |
| `recommend-food.ts`/`recommend-shopping.ts` | **KEEP** as tools |
| Test patterns (`FakeLlmProvider`, db-cleanup, destination buckets) | **KEEP** |
| CI | **KEEP** |
| `AiOrchestrationService` | **REFACTOR**: split generic validated-generation primitive from itinerary-specific prompt/schema |
| `generate-itinerary.ts` orchestration | **REFACTOR**: becomes Planning Agent's internals, invoked by Supervisor not controller |
| `candidate-set.ts` | **GENERALIZE**: callable standalone, not itinerary-only |
| grounding validator pattern | **GENERALIZE**: to comparison/booking narrative |
| job/async 202-poll pattern | **GENERALIZE**: to `tasks` (new types), `itinerary_jobs` stays as-is for now |
| Supervisor, Planning(wrapper), Comparison (multi-domain), Booking, Booking Management/Cancellation agents | **ADD** |
| Supervisor entity/reference resolution step | **ADD** (§C) |
| `conversations`/`messages`/`tasks`/`hotel_offers`/`transport_offers`/`bookings`/`booking_events`/`provider_operations` | **ADD** |
| Hotel/Transport/Booking provider interfaces + adapters (incl. optional `modify()`/`getStatus()`) | **ADD** |
| `getCancellationPolicy` standalone tool | **ADD** (§D) |
| RAG (`knowledge_documents` + tsvector retrieval) | **ADD** |
| Next.js frontend | **DEFER** (after Phase 3) |
| Redis usage | **DEFER** (until Phase 5+, rate-limiting/provider concurrency) |
| `users`/real auth | **DEFER**, but table stub added early as an FK target |
| `user_preferences` | **DEFER** |
| Unifying `itinerary_jobs` into `tasks` | **DEFER** — prove the new pattern first |
| Stuck-job reconciliation sweep | **ADD** (existing gap, fix while generalizing the job pattern) |

---

## N. Phased implementation plan

| Phase | Scope | Proves |
|---|---|---|
| **0** | This document, reviewed and approved | Shared understanding |
| **1** | Extract the generic validated-generation primitive from `AiOrchestrationService`; make `buildCandidateSet` standalone-callable. No behavior change. | Refactor is safe; all 58 tests still pass |
| **2** | `conversations`/`messages`/`tasks` tables. New companion endpoint. Minimal Supervisor: deterministic router with exactly two routes — "full trip" (→ existing Planning path, unchanged) and "everything else" (→ new Q&A tool path, no persistence beyond message log). | **The smallest change that proves the new architecture end-to-end** — see below |
| **3** | Formalize Supervisor + Planning Agent as named modules (`src/agents/`). Add must-visit-place constraint handling to Planning. | Supervisor calling a real multi-step agent, not just a stub |
| **4** | Comparison Agent (built domain-set-first from the start, per §E, even though only `HotelProvider` exists yet) + one real-or-mocked hotel adapter + `hotel_offers`. Supervisor entity-resolution step (§C) added here — needed as soon as a comparison result exists to select from. | First provider abstraction beyond Places; first "compare" workflow; first multi-turn selection |
| **5** | Redis introduced for provider-call rate-limiting/concurrency control. Extend Comparison Agent's existing domain-set support to transport (flight/train/bus adapters) — no interface change, just more domains registered. `getCancellationPolicy` added as a standalone tool. | Redis earns its keep with a measured need; multi-domain comparison (query 7) proven end-to-end |
| **6** | RAG (`knowledge_documents` + tsvector) wired into Q&A for visa/advisory questions and as `getCancellationPolicy`'s fallback for unstructured terms. | First non-structured-DB knowledge source |
| **7** | Booking preparation + confirmation boundary + idempotency-key plumbing (no real provider write yet — stop at "prepared, awaiting confirmation"). | Confirmation-boundary and idempotency logic provably correct before any money-adjacent call exists |
| **8** | Booking Agent executes through a real/sandbox provider write adapter, with idempotency key + `getStatus` reconciliation on ambiguous responses. `bookings`/`booking_events`. | Full search→compare→select→confirm→book→persist loop, safe under retry |
| **9** | Booking Management / Cancellation Agent: pure cancellation first, then the modify composite workflow (native `modify()` or Supervisor-coordinated cancel+rebook with one combined confirmation). | Mirror flow, provider-confirmed state transitions, modify workflow |
| **10** | Next.js frontend begins (per frontend decision above). Auth/`users` hardened. Observability, provider expansion, stuck-job reconciliation sweep. | Productionization |

At every phase: run the existing 58 tests + typecheck, add tests for new
behavior, never bypass the grounding validator, never let the LLM be
authoritative for price/availability/booking truth.

---

## O. Exact first implementation task

**Phase 1** (smallest, lowest-risk, purely a refactor):

1. Extract from `AiOrchestrationService` a new, itinerary-agnostic
   function — e.g. `generateValidatedStructuredOutput(provider,
   systemPrompt, userPrompt, { isWellFormed, extractCitedFactIds,
   allowedFactIds })` — that does exactly what today's grounding check
   does (parse JSON, validate shape, check every cited fact_version id
   against a supplied set) without knowing anything about
   `GeneratedItinerary`'s specific shape.
2. Rewrite `AiOrchestrationService.generateItinerary()` to be a thin
   itinerary-specific caller of that primitive (same external behavior,
   same tests, same day-count enforcement — day-count is itinerary-specific
   and stays in the itinerary layer).
3. Add a standalone-callable export from `candidate-set.ts` usable without
   going through `generate-itinerary.ts`.
4. No HTTP, schema, or test-observable behavior changes. All 58 existing
   tests must pass unmodified; typecheck must be clean.
5. Report exactly what changed, confirm no regressions, before Phase 2
   (which is the first phase that adds new tables/endpoints) begins.

This phase deliberately produces **zero user-visible change** — it's the
foundation Phase 2's Supervisor/Q&A path is built on, and it's the
cheapest possible way to prove the refactor doesn't regress anything
before any new agent code exists.

---

*This revision incorporates the five refinements from the stress-test
review (entity resolution, multi-domain Comparison Agent, Booking
Management/Cancellation Agent + modify workflow, standalone
cancellation-policy tool, provider-side idempotency). Remaining judgment
calls carried over unchanged from Revision 1 (frontend timing, RAG
storage choice, Redis deferral, offer-provenance split in §H) still stand
as documented. Waiting for final go-ahead before Phase 1 begins.*
