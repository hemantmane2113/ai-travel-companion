# CLAUDE.md — AI Travel Companion Project Constitution

## 0. Mission

This repository implements an **AI-agent-based Travel Companion**.

The product is not merely an itinerary generator.

The product should behave as a single intelligent travel companion
capable of:

- answering small travel questions
- researching destinations
- recommending places, food and activities
- comparing hotels and travel options across available providers
- planning complete trips
- adapting plans to user constraints
- booking supported hotels, flights, trains, buses and restaurants
- modifying bookings
- cancelling bookings
- explaining the evidence behind recommendations
- maintaining grounded, provenance-aware travel information

The architecture must support a broad range of user intent without
forcing every request through a full-trip workflow.

------------------------------------------------------------------------

# 1. Product Philosophy

## 1.1 One companion, many capabilities

The user should experience one assistant.

Internally, the assistant may use multiple specialized agents, domain
services and tools.

Do not expose unnecessary architectural complexity to the user.

Conceptually:

``` text
                     USER
                       |
                       v
          +---------------------------+
          | Travel Companion /        |
          | Supervisor Agent          |
          +-------------+-------------+
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
       Answer        Research      Action
       Tasks         Tasks         Tasks
          |             |             |
          v             v             v
       Tools/        Comparison    Booking/
       Knowledge     Agents        Management
```

The supervisor coordinates the experience.

Specialized agents perform bounded tasks.

Deterministic services provide trustworthy computation and data
operations.

------------------------------------------------------------------------

# 2. Supported User Intent

The product must support both tiny and complex requests.

Examples:

### Tiny question

> What should I eat at Indore Khau Galli?

Expected behavior:

- answer the question
- retrieve relevant information
- provide useful recommendations
- do not automatically construct a full itinerary

### Destination question

> What are the best places to visit in Delhi?

Expected behavior:

- retrieve and rank relevant places
- explain recommendations
- optionally offer broader planning

### Hotel comparison

> Compare hotels near Karol Bagh in Delhi.

Expected behavior:

- search available providers
- normalize offers
- compare price, location, rating, amenities, cancellation terms and
  other relevant attributes
- identify the provider/source for each offer

### Complete trip

> I am visiting Delhi for 3 days. Plan a trip for me.

Expected behavior:

- understand dates/constraints
- gather destination facts
- generate a feasible multi-day plan
- ground factual claims
- provide provenance where applicable

### User-provided must-visit places

> I am visiting Delhi for three days and I definitely want to visit A, B
> and C. What is the best way to organize the trip?

Expected behavior:

- treat A/B/C as hard user constraints
- optimize the remaining itinerary around them
- use geographic/time reasoning
- explain the resulting structure

### Booking

> I like this Agoda hotel. Book it for me.

Expected behavior:

- identify the exact selected offer
- verify final booking details
- present the final commitment details
- obtain explicit confirmation if required
- execute through the appropriate provider
- verify success
- persist the booking

### Cancellation

> Cancel my hotel. I found a cheaper one.

Expected behavior:

- identify the existing booking
- retrieve cancellation policy/fee/refund information
- explain the consequences
- obtain required confirmation
- execute cancellation
- verify result
- update booking state

------------------------------------------------------------------------

# 3. Core Architectural Principle

## Agents orchestrate; deterministic services execute.

An AI agent should NOT become a giant collection of business logic.

The agent is responsible for:

- understanding intent
- planning a task
- selecting tools
- sequencing tool calls
- resolving ambiguity
- asking for missing information
- deciding when to request confirmation
- communicating results

Deterministic services are responsible for:

- calculations
- validation
- filtering
- ranking
- persistence
- database operations
- provenance
- booking state
- policy checks
- provider communication
- financial calculations
- date/time calculations

------------------------------------------------------------------------

# 4. High-Level Architecture

``` text
+-------------------------------------------------------------------+
|                           USER / UI                              |
|                    Next.js Web Application                        |
+-------------------------------+-----------------------------------+
                                |
                                v
+-------------------------------------------------------------------+
|                    TRAVEL COMPANION API                          |
|                         NestJS Backend                            |
+-------------------------------+-----------------------------------+
                                |
                                v
+-------------------------------------------------------------------+
|                 SUPERVISOR / TRAVEL COMPANION AGENT               |
|                                                                   |
|  Understand intent -> create task -> select agent/tools ->        |
|  maintain conversation state -> request confirmation              |
+-------------------------------+-----------------------------------+
                                |
       +------------------------+-------------------------+
       |                        |                         |
       v                        v                         v
+---------------+      +----------------+       +----------------------+
| Planning      |      | Research /    |       | Action Agents        |
| Agent         |      | Comparison    |       |                      |
|               |      | Agents        |       | Booking              |
| Full trips    |      | Hotels        |       | Booking Management   |
| Trip changes  |      | Transport     |       | Cancellation         |
| Constraints   |      | Restaurants   |       | Modification         |
+-------+-------+      +-------+--------+       +----------+-----------+
        |                      |                           |
        +----------------------+---------------------------+
                               |
                               v
+-------------------------------------------------------------------+
|                         TOOL LAYER                                |
|                                                                   |
| Travel Intelligence | Search | Retrieval | Pricing | Availability |
| Itinerary | Comparison | Provenance | Booking | Cancellation     |
+--------------------------------+----------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
|                     DOMAIN / DATA SERVICES                       |
|                                                                   |
| Users | Trips | Places | Food | Hotels | Transport | Restaurants |
| Itineraries | Bookings | Sources | Facts | Fact Versions         |
+--------------------------------+----------------------------------+
                                 |
              +------------------+------------------+
              |                                     |
              v                                     v
+---------------------------+          +-----------------------------+
| PostgreSQL + PostGIS      |          | Redis                       |
| structured travel data    |          | cache / jobs / state        |
| provenance                |          |                             |
+---------------------------+          +-----------------------------+

                                 |
                                 v
+-------------------------------------------------------------------+
|                    PROVIDER ABSTRACTION                            |
|                                                                   |
| Hotel Providers | Flight Providers | Rail | Bus | Restaurants     |
| Maps/Routing | Travel Data | Knowledge Providers                  |
+-------------------------------------------------------------------+
```

------------------------------------------------------------------------

# 5. Agent Architecture

## 5.1 Supervisor / Travel Companion Agent

This is the primary conversational agent.

Responsibilities:

1.  Understand the user's request.
2.  Determine intent.
3.  Determine required scope.
4.  Select an appropriate specialized agent or tool.
5.  Maintain task state.
6.  Ask clarification questions when necessary.
7.  Coordinate multi-step workflows.
8.  Enforce confirmation boundaries.
9.  Return a coherent response.

It must NOT directly implement provider-specific booking logic.

------------------------------------------------------------------------

## 5.2 Planning Agent

Handles:

- complete trip planning
- multi-day itinerary generation
- user constraints
- must-visit places
- food preferences
- budget
- geographic clustering
- timing
- itinerary modifications

It uses:

- Travel Intelligence
- Places
- Food
- Events when available
- Weather when available
- Advisory information
- retrieval
- LLM reasoning

The LLM creates the plan/narrative.

Travel Intelligence validates deterministic constraints.

------------------------------------------------------------------------

## 5.3 Research / Q&A Capability

This capability handles small questions.

Examples:

- "What should I eat here?"
- "Is Red Fort worth visiting?"
- "What is famous in this market?"
- "How far are these two places?"
- "What can I do in Delhi at night?"

Do NOT invoke the complete itinerary planner for every question.

------------------------------------------------------------------------

## 5.4 Hotel Comparison Agent

Responsibilities:

- search available hotel providers
- retrieve offers
- normalize provider-specific structures
- compare prices
- compare room types
- compare cancellation policies
- compare location
- compare ratings
- compare amenities
- preserve source/provider identity
- explain differences

It must not fabricate availability or price.

------------------------------------------------------------------------

## 5.5 Transport Comparison Agents

Support:

- flights
- trains
- buses

The architecture should allow provider-specific adapters while exposing
a normalized comparison model.

The user should be able to say:

> Compare flights from Pune to Delhi.

or:

> Find me a train.

or:

> Which bus is cheapest?

The system should route the request appropriately.

------------------------------------------------------------------------

## 5.6 Restaurant Agent

Responsibilities:

- restaurant discovery
- cuisine recommendations
- local food recommendations
- comparison
- availability/reservation where supported
- source attribution

Example:

> What should I eat at Indore Khau Galli?

This is a research/recommendation task, not necessarily a booking task.

------------------------------------------------------------------------

## 5.7 Booking Agent

The Booking Agent executes supported purchases/reservations.

Supported domains:

- hotels
- flights
- trains
- buses
- restaurants

The exact supported providers depend on real integrations.

Never claim a booking succeeded until the provider confirms success.

------------------------------------------------------------------------

## 5.8 Booking Management / Cancellation Agent

Handles:

- cancellation
- modification
- replacement
- rebooking
- checking booking state
- retrieving policies
- calculating/communicating consequences

A cancellation is a state-changing financial action and therefore
requires appropriate confirmation.

------------------------------------------------------------------------

# 6. Travel Intelligence

Travel Intelligence is a deterministic domain reasoning layer.

It is NOT an AI agent.

Responsibilities include:

- distance calculation
- geographic clustering
- candidate filtering
- budget filtering
- ranking
- itinerary feasibility
- time constraints
- date calculations
- must-visit constraints
- dietary filtering
- candidate-set construction
- deterministic validation

Example:

``` text
Agent:
"I need to plan 3 days in Delhi."

Travel Intelligence:
"These 20 candidates match the user's constraints."

Agent:
"Create a coherent itinerary from these candidates."

Travel Intelligence:
"These day allocations are geographically and temporally feasible."
```

The LLM should not replace deterministic validation.

------------------------------------------------------------------------

# 7. AI / GenAI Layer

GenAI is used for:

- intent understanding
- task decomposition
- tool selection
- natural language reasoning
- itinerary generation
- comparison explanation
- conversational responses
- summarization
- grounded synthesis

The LLM is NOT authoritative for:

- current prices
- current availability
- booking confirmation
- cancellation confirmation
- source provenance
- database state
- financial calculations

Those must come from tools/services.

------------------------------------------------------------------------

# 8. RAG Architecture

RAG is a supporting subsystem.

Use RAG for unstructured knowledge that benefits from semantic
retrieval.

Potential sources:

- destination guides
- travel documentation
- official advisories
- visa information
- curated travel knowledge
- provider documentation
- policy documents

Flow:

``` text
User question
   |
   v
Agent
   |
   v
Retrieval tool
   |
   v
Retriever
   |
   +--> Vector / lexical search
   |
   v
Relevant documents/chunks
   |
   v
LLM synthesis
   |
   v
Grounded response
```

Structured travel facts should remain in PostgreSQL/PostGIS where
appropriate.

Do not use RAG for simple structured queries such as:

> Find hotels within 2 km of Karol Bagh.

------------------------------------------------------------------------

# 9. Data Architecture

Primary database:

**PostgreSQL + PostGIS**

Use it for:

- users
- preferences
- trips
- itinerary
- places
- restaurants
- accommodation records
- transportation information
- bookings
- sources
- facts
- fact_versions
- provenance
- booking state

PostGIS handles:

- coordinates
- geographic distance
- geographic filtering
- spatial clustering

Redis handles:

- caching
- asynchronous jobs
- temporary task state
- rate limiting where appropriate

------------------------------------------------------------------------

# 10. Provenance

Every important factual recommendation should be traceable.

Core chain:

``` text
Recommendation
      |
      v
fact_version
      |
      v
fact
      |
      v
source
      |
      v
URL / provider / retrieval metadata
```

The product should be able to answer:

> Why does the system believe this?

Provenance must not be invented by the LLM.

------------------------------------------------------------------------

# 11. Provider Abstraction

Never couple agents directly to external providers.

Example:

``` text
HotelSearchService
       |
       v
HotelProvider interface
       |
       +--> AgodaAdapter
       +--> MakeMyTripAdapter
       +--> Other adapters
```

Similarly:

``` text
FlightProvider
TrainProvider
BusProvider
RestaurantProvider
```

The exact provider list is configuration/integration dependent.

Provider adapters own:

- authentication
- API calls
- request mapping
- response normalization
- provider-specific errors
- rate limits
- booking operations
- cancellation operations

------------------------------------------------------------------------

# 12. Comparison Model

Comparison results must be normalized before the LLM sees them.

Example normalized hotel offer:

``` text
HotelOffer
- provider
- hotelId
- hotelName
- location
- roomType
- totalPrice
- currency
- taxes
- cancellationPolicy
- amenities
- rating
- reviewCount
- availability
- sourceUrl
- retrievedAt
```

The comparison agent reasons over normalized offers.

Never ask the LLM to infer which provider has the lower price from raw
unrelated provider payloads if deterministic comparison can do it.

------------------------------------------------------------------------

# 13. Booking Workflow

Required pattern:

``` text
User request
    |
    v
Search
    |
    v
Compare
    |
    v
User selects offer
    |
    v
Prepare booking
    |
    v
Show final details
    |
    v
Explicit confirmation
    |
    v
Booking Agent
    |
    v
Provider Adapter
    |
    v
Provider confirmation
    |
    v
Persist booking
    |
    v
Return confirmation
```

Never skip provider verification.

------------------------------------------------------------------------

# 14. Cancellation Workflow

``` text
User requests cancellation
        |
        v
Identify booking
        |
        v
Retrieve provider policy
        |
        v
Calculate/display refund/fee consequences
        |
        v
Confirm cancellation
        |
        v
Cancellation Agent
        |
        v
Provider Adapter
        |
        v
Provider confirmation
        |
        v
Update booking state
```

The database must not be updated to "cancelled" until the provider
confirms the cancellation.

------------------------------------------------------------------------

# 15. Memory and State

The system must distinguish:

### Conversation state

What the user is currently discussing.

### Task state

What the current agent workflow is doing.

### User preferences

Longer-term preferences such as:

- preferred budget range
- food preferences
- hotel preferences
- travel style

### Booking state

Actual external commitments.

Never confuse conversational statements with confirmed bookings.

Example:

> "Maybe book this hotel."

This is not a booking.

> "Yes, confirm the booking."

This is an explicit action request subject to the confirmation workflow.

------------------------------------------------------------------------

# 16. Trust Boundary

The LLM is not trusted as a factual source.

Potential hallucination point:

``` text
LLM reasoning
```

Controls:

- structured outputs
- fact/reference validation
- provenance checks
- deterministic post-generation validation
- provider response verification
- database constraints
- explicit booking confirmation
- tests

A generated claim must not become a verified fact simply because the LLM
stated it.

------------------------------------------------------------------------

# 17. Error Handling

Agents must handle:

- provider timeout
- provider unavailable
- provider rate limit
- stale price
- changed availability
- booking failure
- cancellation failure
- invalid user input
- ambiguous intent
- missing information
- LLM malformed output
- tool failure

Never hide provider failures behind fabricated natural-language
responses.

Example:

Bad:

> "Your hotel is booked."

when the provider timed out.

Good:

> "The provider did not confirm the booking, so I have not marked it as
> booked."

------------------------------------------------------------------------

# 18. Async Architecture

Long-running workflows should use asynchronous jobs.

Potential async tasks:

- itinerary generation
- multi-provider hotel comparison
- transport comparison
- booking operations where provider latency requires it
- cancellation operations
- ingestion
- scheduled refresh

User-facing API pattern:

``` text
POST request
   |
   v
202 Accepted
   |
   v
jobId
   |
   v
poll/status or event
   |
   v
completed result
```

Do not block HTTP requests unnecessarily.

------------------------------------------------------------------------

# 19. Efficiency Rules

Avoid these architectural bottlenecks:

### Do not create one giant agent

Instead use bounded capabilities.

### Do not create too many tiny agents

If a task can be a deterministic service/tool, it does not need an
agent.

### Do not make agents call providers directly

Use provider adapters.

### Do not make every request use RAG

Use structured queries where appropriate.

### Do not make every request invoke an LLM

Simple deterministic questions should remain cheap and fast where
possible.

### Do not make the itinerary engine call providers live unnecessarily

Use ingestion/local data for relatively static information.

### Do not synchronously call many providers serially

Where comparison requires multiple providers, use parallel provider
calls with timeouts and partial-result handling.

### Do not make the LLM perform deterministic calculations

Use code.

------------------------------------------------------------------------

# 20. Security and Authorization

Sensitive operations require authorization.

Examples:

- booking
- cancellation
- payment
- personal travel information
- booking retrieval

Never allow the LLM itself to bypass authorization.

The backend must enforce permissions.

Provider credentials must never be placed into prompts.

Secrets must remain in environment/configuration/secret-management
systems.

------------------------------------------------------------------------

# 21. Observability

Every meaningful agent execution should be traceable.

Capture, as appropriate:

- request ID
- conversation/task ID
- agent selected
- tools called
- provider calls
- latency
- errors
- LLM usage
- booking attempt
- booking result
- confirmation state

Do not log sensitive payment information or credentials.

------------------------------------------------------------------------

# 22. Testing Strategy

Use multiple levels.

### Unit tests

- date calculations
- ranking
- filtering
- validation
- provenance
- booking state transitions
- cancellation state transitions

### Integration tests

- database
- Redis
- provider adapters
- normalized models
- provenance

### Agent tests

Test:

- intent routing
- correct tool selection
- missing information
- refusal to invent data
- confirmation behavior
- multi-step workflows

### End-to-end tests

Example:

``` text
User
 -> Supervisor
 -> Hotel comparison
 -> Provider mocks
 -> normalized offers
 -> user selects
 -> confirmation
 -> booking adapter
 -> provider confirmation
 -> persisted booking
```

Real provider tests should only be used where permitted and safe.

------------------------------------------------------------------------

# 23. Infrastructure

Start simple.

Preferred baseline:

- NestJS
- Next.js
- PostgreSQL/PostGIS
- Redis
- Docker
- local/open model during development where useful
- provider APIs only where actually required

Do NOT introduce:

- Kubernetes
- Kafka/RabbitMQ
- microservices
- service mesh
- complex orchestration infrastructure

unless a measured requirement justifies them.

The architecture should remain a modular monolith initially.

------------------------------------------------------------------------

# 24. Modular Monolith Boundary

Recommended modules:

``` text
auth
users
trips
places
food
hotels
transportation
restaurants
itinerary
bookings
booking-management
travel-intelligence
agents
ai-orchestration
retrieval
provenance
providers
ingestion
jobs
```

These are logical modules, not separate deployable services.

Future extraction is allowed only when justified by:

- measured load
- independent scaling requirement
- team ownership
- deployment isolation
- reliability requirement
- architectural necessity

------------------------------------------------------------------------

# 25. Development Rules for Claude

Before implementing any major change:

1.  Read the current code.
2.  Read relevant tests.
3.  Read database migrations.
4.  Understand current behavior.
5.  Identify reusable components.
6.  Explain the proposed change.
7.  Implement the smallest coherent increment.
8.  Run tests.
9.  Run type checking.
10. Run relevant integration/e2e checks.
11. Report exactly what changed.
12. Report remaining gaps.

Do not claim a capability is implemented merely because interfaces
exist.

For provider integrations, distinguish:

- mocked capability
- sandbox/test integration
- real provider integration
- real booking capability

These are not equivalent.

------------------------------------------------------------------------

# 26. Do Not Regress Existing Strengths

The existing project has important architectural foundations.

Do not regress:

- provenance
- fact versioning
- grounding validation
- deterministic Travel Intelligence
- API validation
- multi-day itinerary support
- asynchronous generation
- database migration discipline
- tests
- CI
- provider abstraction
- ingestion/runtime separation

If a new architecture change conflicts with an existing capability,
explicitly identify the conflict before modifying it.

------------------------------------------------------------------------

# 27. Product Success Criteria

The user should eventually be able to move naturally through workflows
such as:

``` text
Question
   |
   v
Research
   |
   v
Comparison
   |
   v
Selection
   |
   v
Booking
   |
   v
Trip planning
   |
   v
Modification
   |
   v
Cancellation
```

But these are not mandatory stages.

A user may stop at any point.

For example:

``` text
"What should I eat at Indore Khau Galli?"
```

should end with an answer.

The system must not force:

``` text
Answer -> itinerary -> hotel -> flight -> booking
```

unless the user asks for those capabilities.

------------------------------------------------------------------------

# 28. Ultimate Product Definition

The product is:

> **An AI-powered travel companion that understands what the traveler is
> trying to accomplish, uses specialized agents and deterministic travel
> services to research and reason about options, retrieves grounded
> information, compares real alternatives across providers, plans trips
> when requested, and can execute authorized travel bookings,
> modifications and cancellations through provider integrations.**

The user should experience this as one coherent companion.

The architecture underneath should remain modular, testable,
provider-neutral, provenance-aware and safe.

------------------------------------------------------------------------

# 29. Model Strategy: Local-First and Provider-Neutral

## 29.1 Local-first, zero-cost by default

The system must be capable of operating without paid LLM APIs or paid
AI SaaS.

Open-weight models running locally are the default inference path.

CPU compatibility is a first-class constraint.

Model selection must be benchmark-driven rather than assumed.

External model APIs are optional adapters and must never become
architectural dependencies.

## 29.2 No architecture around a single model

The architecture must not be optimized around a single model.

Models are replaceable infrastructure behind the Model Gateway.

------------------------------------------------------------------------

# 30. Final Rule

When making architectural decisions, optimize for:

**Correctness > user intent > trust/grounding > safety of actions >
maintainability > efficiency > feature count.**

Do not add technology merely because it is associated with AI agents.

Every agent, tool, provider, database table and infrastructure component
must have a concrete responsibility and consumer.
