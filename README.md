# AI Travel Companion

A chat application for planning trips. You talk to one companion that can:

- answer questions about places, with facts and stories sourced from Wikipedia and Wikivoyage
- ask what it needs to know (dates, travellers, budget, interests), agree the places with you, and build a day-by-day itinerary
- tell you the weather for your dates and warn about public holidays and festivals
- order the agreed places into the shortest route, grouped into days of neighbouring stops
- compare hotel offers across providers
- prepare a hotel booking or cancellation, which you confirm with a button

## What is real and what is simulated

| Capability | Status |
|---|---|
| Chat, trip planning, itineraries | Real. Uses the Groq LLM API. |
| Place facts and stories | Real. Live lookups against Wikipedia and Wikivoyage, with source links. |
| Weather | Real. Open-Meteo: a forecast when the trip is within 15 days, otherwise the average for those dates over the last three years, labelled as not a forecast. |
| Air quality | Real. Open-Meteo's free air-quality data (CAMS model, no key), as the day's peak US AQI and mean PM2.5. A forecast up to 4 days ahead; further out, the average for the same dates in the most recent years with data (history starts August 2022). Model estimates for the city, not station readings; US EPA scale, not India's CPCB scale. |
| Holidays and festivals | Real, but limited. Nager.Date, and Google's public holiday calendar for India. **Strikes, rallies, concerts, sports events and local closures are not covered**; there is no free open feed for them. |
| Local news | Real. Recent headlines from the public Google News feed that mention the place and a possible disruption (strike, protest, closure, flood, traffic diversion). Checked for trips starting within 14 days. Headlines are unverified; the model picks the ones that matter and the card links all of them. |
| Restaurant search | Real, but thin. OpenStreetMap restaurants within 2.5 km of an area, matched on cuisine tags and names (Overpass servers first, Nominatim when they are overloaded, which caps results at 40). **No ratings, reviews, prices or menus**, so results are ordered by closeness of match and distance, never by quality. |
| Restaurants near you | Real. When you ask for places "near me", the page offers a **Share my location** button. The browser's position is used for that one search only: it is not stored or logged, the assistant only sees the area name (from Nominatim), and outside services get it rounded to about 100 m. Results show distance from you and a map (Leaflet, bundled in `app/static/vendor/leaflet`, with OpenStreetMap tiles). Same data limits as restaurant search. |
| Table reservations | **Simulated.** "TableDemo (demo)": the restaurant is not contacted and no table is held. |
| Locating places | Real. OpenStreetMap (Nominatim), then Wikipedia article coordinates. Places that neither knows are reported as not found and left out of the route. |
| Distances and route order | Real. OSRM over OpenStreetMap roads, without traffic. The shortest order is computed in code (exact up to 11 stops). |
| Hotels | Real, on the providers' sites. The companion gives pre-filled Google Hotels and Booking.com searches for the place, dates and guests; the traveller sees real hotels and prices and books there. The companion itself never sees those prices. |
| Flights, trains, buses | Real, on the providers' sites. Pre-filled searches: Google Flights and ixigo for flights, ixigo plus a Google search and IRCTC for trains, redBus for buses. No schedules or fares reach the companion. Link formats are in `app/services/search_links.py`. |
| Budget planning | **Estimates.** The budget is split in code (`app/services/budget_service.py`) using a hand-set table of typical Indian costs (`app/services/cost_table.py`): stay, getting there and back from the starting city, food, local transport and sightseeing, at three levels (budget, mid-range, comfort). The most comfortable level that fits the budget decides the style of the plan, the Booking.com nightly price filter and the suggested way of travelling. The figures are not quotes; edit the table to change them. |
| In-app hotel booking demo | **Simulated.** Three demo providers (StayEasy, RoomHub, TripNest) with fictional hotels and generated prices, used only when the traveller asks for the demo. No real reservation or payment is ever made. |

The hotel flow is complete (search → compare → confirm → book → cancel) but runs against
`app/providers/hotels/mock.py`. Connecting a real booking site means writing another
`HotelProvider` adapter; nothing else changes. Real hotel APIs need a commercial agreement
with the provider.

## Setup

Requires Python 3.12 or newer. No Docker needed; the database is a local SQLite file.

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python -m pip install -e ".[dev]"
```

Copy `.env.example` to `.env` and fill in:

- `SESSION_SECRET`: any long random string
- `GROQ_API_KEY`: from https://console.groq.com/keys

Create the database tables:

```bash
.venv\Scripts\alembic upgrade head
```

Run the app and open http://localhost:8000:

```bash
.venv\Scripts\python -m uvicorn app.main:create_app --factory --port 8000
```

Run the tests (they use a fake LLM and an in-memory database, so no key is needed):

```bash
.venv\Scripts\python -m pytest
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | Signs the login cookie. |
| `LLM_PROVIDER` | no | `groq` (default) or `openai_compatible`. |
| `GROQ_API_KEY` | with `groq` | Without a key for the chosen service the app starts but chat returns an error. |
| `GROQ_MODEL` | no | Must support tool calling. Default `openai/gpt-oss-120b`. |
| `GROQ_FALLBACK_MODELS` | no | Comma-separated models used, in order, while `GROQ_MODEL` is rate limited or out of its daily allowance. Default `openai/gpt-oss-20b,qwen/qwen3.8-27b`. Empty turns fallback off. |
| `LLM_BASE_URL` | with `openai_compatible` | Any OpenAI-style endpoint. Default is Cerebras, `https://api.cerebras.ai/v1`; OpenRouter and a local Ollama (`http://localhost:11434/v1`) work the same way. |
| `LLM_API_KEY`, `LLM_MODEL` | with `openai_compatible` | Key and model name for that endpoint. The model must support tool calling. |
| `DATABASE_URL` | no | Any SQLAlchemy async URL. Default is `sqlite+aiosqlite:///./travel.db`. |
| `APP_ENV` | no | `production` makes the session cookie HTTPS-only. |
| `HTTP_USER_AGENT` | no | How the app identifies itself to Wikipedia and OpenStreetMap. Put a contact address in it before any real use; both ask for one. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Shows "Continue with Google". Free; see below. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | Shows "Continue with GitHub". Free; see below. |
| `PUBLIC_BASE_URL` | no | The address the app is reached at, for sign-in callbacks. Empty on localhost. |
| `NOMINATIM_URL`, `OSRM_URL`, `OVERPASS_URLS`, `MAP_TILES_URL` | no | OpenStreetMap services. The public servers are for testing only; point these elsewhere for a public launch. |

### Sign in with Google or GitHub

Both are free and optional; each button appears once its two values are in `.env`.

**Google.** In the [Google Cloud console](https://console.cloud.google.com), create a project, set up the
*OAuth consent screen* (External; while it is in Testing, add your own Google address as a test user), then
*Credentials → Create credentials → OAuth client ID → Web application*. Add the authorised redirect URI
`http://localhost:8000/auth/google/callback`, and copy the client ID and secret into `.env`.

**GitHub.** In [GitHub developer settings](https://github.com/settings/developers), *OAuth Apps → New OAuth App*.
Homepage `http://localhost:8000`, callback `http://localhost:8000/auth/github/callback`. Generate a client
secret, and copy the ID and secret into `.env`.

Restart the app after editing `.env`. A Google or GitHub sign-in joins the existing account with the same
email only when the provider has verified that email; otherwise it is refused, so nobody can take over an
account by putting someone else's address on their profile. Apple sign-in is not offered: it needs a paid
Apple developer account.

## How it works

```
Browser chat  ──POST /api/conversations/{id}/chat (streamed)──►  CompanionAgent
                                                                    │ tool calls
      save_trip_requirements ─► trip_service        (validates dates, lists what to ask)
                                + conditions_service (weather, holidays, alerts)
      get_trip_conditions    ─► WeatherProvider, EventsProvider
      search_place_info      ─► KnowledgeProvider   (Wikipedia)
      get_travel_guide       ─► KnowledgeProvider   (Wikivoyage)
      optimize_route         ─► route_service       (locate places, shortest order, split into days)
      save_itinerary         ─► itinerary_service   (checks the plan against the trip)
                                + each day's weather, holidays and travel distance
      compare_hotels         ─► hotel_comparison    (all providers in parallel)
      prepare_booking        ─► booking_service     (re-quotes, holds for confirmation)
      list_bookings / prepare_cancellation

Confirm / cancel buttons ──POST /api/bookings/{id}/confirm | /cancel──► booking_service ─► HotelProvider
```

### Specialists

Each message is first routed by a small supervisor step to one specialist, which carries
only its own instructions and tools (`app/agent/specialists.py`, prompts in `app/agent/prompts/`):

| Specialist | Handles | Tools |
|---|---|---|
| `guide` | Questions about places, food, weather, holidays, local news | place lookup, travel guide, conditions, news |
| `trip_planner` | Collecting trip details, agreeing places, route, itinerary | trip details, travel guide, place lookup, route, itinerary |
| `hotels` | Real hotel searches, plus the in-app booking demo | hotel search links, demo compare, prepare booking, list bookings, prepare cancellation |
| `transport` | Flights, trains, buses between cities | transport search links |
| `restaurants` | Finding where to eat a dish in an area, reserving and cancelling tables | find restaurants, prepare table booking, list reservations, prepare cancellation |

**Router or orchestrator.** The router (a short call to the main Groq model) sends most
messages to one specialist. When a message asks for several things at once ("weather, trains
and hotels"), it answers `multi` and the orchestrator takes over (`app/agent/orchestrator.py`):
a separate model splits the message into ordered steps, code checks the plan, and each step
runs with its specialist, which is given its own part plus the traveller's words as context.
Each part's answer is shown as it finishes, so no extra model call is needed to join them.
The orchestrator's model is set by `ORCHESTRATOR_*` in `.env`: a local Ollama model by default,
any OpenAI-style endpoint (such as OpenAI) later. If it fails or exceeds its timeout, the
main model plans instead.

A specialist that receives something outside its area hands the turn to the right one
(`hand_off`), at most twice per turn. The traveller sees one assistant throughout.
`MULTI_AGENT=false` runs one agent with
every tool instead.

The model decides what to do and writes the replies. Code does everything that has to be right:

- **The model cannot book or cancel.** It has no tool for it. It can only prepare a booking;
  the commitment is made by the signed-in user pressing Confirm, which calls a separate endpoint.
- A booking is marked confirmed or cancelled only after the provider says so. A provider
  error or timeout is recorded as a failure and shown as one.
- Prices are compared and sorted in code. The model explains the result; it does not compute it.
- An itinerary is rejected unless it has one day per trip date, respects the pace, includes
  every must-visit place, and cites only source URLs that a lookup returned in that conversation.
- Hotel offers shown to the user are stored, and the price is re-checked with the provider
  before booking. A changed price is flagged rather than silently charged.
- Weather and holiday alerts are raised by fixed thresholds (rain likely, 38°C and above,
  freezing, public holiday), not by the model's judgement.
- The route is solved in code from road distances. The model is told the shortest order and
  may depart from it only for timing; a day that still wastes distance is flagged back to it.
- The saved trip (destination, dates, travellers, budget, estimate, itinerary status) is read
  from the database and put at the top of every prompt, router included, so the model never
  depends on old messages to know it. Earlier tool results are replayed as one-line recaps
  written in code, and history is trimmed by whole turns, never to nothing.
- The model never does budget sums. It is told the affordable level, the estimated total and
  any shortfall, and the itinerary card shows the same breakdown.
- The model is only shown the tools it can use at that moment: planning tools once the trip
  details are complete, booking tools once there is an offer or a booking.

## Layout

```
app/
  main.py              application factory
  config.py            settings from environment
  agent/               tool-calling loop, tool definitions, prompts/system_v1.md
  api/                 auth, chat (streaming), bookings
  services/            trip, itinerary, hotel comparison, booking (the deterministic rules)
  providers/
    llm/               LLMProvider interface + Groq + any OpenAI-compatible service (Cerebras, ...)
    knowledge/         KnowledgeProvider interface + Wikipedia/Wikivoyage
    hotels/            HotelProvider interface + mock providers
  models/  schemas/    database tables, validated data shapes
  templates/  static/  the web UI
alembic/               database migrations
tests/                 unit, agent loop, and API flow tests
```

## Groq rate limits

Groq's free tier allows each chat model about 8,000 tokens per minute and 200,000 per day,
counted separately per model. Planning a trip takes four or more model calls of 4,000 to
6,000 tokens each, which one model cannot serve without pauses.

So the app spreads the load: when the main model is rate limited or has used its daily
allowance, the next model in `GROQ_FALLBACK_MODELS` takes the request, and the main model is
used again as soon as it is due back. The chat only waits (showing "rate limited, continuing
in N seconds") when every model is limited at once. The fallback models are smaller, so
replies written by them follow the instructions less closely; the checks in code (itinerary
validation, booking confirmation, alerts, routes) apply whichever model answers.

A paid Groq tier removes the limits altogether.

## Known gaps

- Hotel providers are simulated (see above). There are no flight, train, bus or restaurant providers.
- Opening hours and ticket prices are not looked up anywhere.
- Events cover public holidays and festivals, plus whatever recent headlines turn up. The
  news check is keyword-based and not exhaustive, and nothing verifies a headline.
- The shortlist the planner proposes before places are agreed is described from the travel
  guide and the model's own knowledge; place facts are only looked up once places are agreed.
- Places the map services do not know by the name given (for example "Chappan Dukaan",
  "Khajrana Ganesh Temple") are left out of the route and listed as not found.
- The public Nominatim and OSRM servers are for light use only: Nominatim is limited to one
  lookup per second, so the first plan for a new city takes a few extra seconds. Heavier use
  needs self-hosted or paid instances.
- No password reset, no login rate limiting.
- Conversation replies are generated inside the HTTP request; there is no background job queue.
