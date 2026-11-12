"""The companion's specialists: who handles what, with which tools and instructions.

One supervisor step picks a specialist for each message, and a specialist can hand
the turn to another. Each carries only its own tools and instructions, which keeps
every model request small and the model's choices narrow.
"""

import logging
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from app.providers.llm.base import Completion, LLMError, LLMProvider

logger = logging.getLogger(__name__)

PROMPT_VERSION = "v1"
_PROMPTS = Path(__file__).parent / "prompts"

HAND_OFF = "hand_off"
MULTI = "multi"  # the router's answer for a message that needs several specialists
BOOKING_TOOLS = frozenset({"prepare_booking", "prepare_cancellation"})
_NO_BOOKING_YET = (
    "## Booking\n\nYou cannot book or cancel anything yourself, and nothing can be booked until the "
    "traveller has seen a hotel comparison. If they ask to book, run `compare_hotels` first.\n"
)


@dataclass(frozen=True)
class Specialist:
    name: str
    title: str  # how it is referred to in instructions
    description: str  # what it handles, for the router and for the other specialists
    prompt_files: tuple[str, ...]
    tools: frozenset[str] | None  # None = every tool
    handles_booking: bool = False


GUIDE = Specialist(
    name="guide",
    title="local guide",
    description="Questions about a place: what to see and do, the local food in general, its history and "
    "stories, the weather, holidays, and what is happening there now. Answers questions; does not build "
    "itineraries or find specific restaurants.",
    prompt_files=("guide", "conditions"),
    tools=frozenset({"search_place_info", "get_travel_guide", "get_trip_conditions", "get_local_news"}),
)
TRIP_PLANNER = Specialist(
    name="trip_planner",
    title="trip planning",
    description="Planning a whole trip or changing an existing plan: collecting the trip details, agreeing "
    "the places, working out the shortest route, saving the day-by-day itinerary.",
    prompt_files=("planning", "conditions"),
    tools=frozenset(
        {"save_trip_requirements", "get_travel_guide", "search_place_info", "optimize_route", "save_itinerary"}
    ),
)
HOTELS = Specialist(
    name="hotels",
    title="hotels",
    description="Hotels: finding and comparing real hotels and prices, and the in-app booking demo "
    "(booking, checking, cancelling demo bookings).",
    prompt_files=("hotels",),
    tools=frozenset(
        {"hotel_search_links", "compare_hotels", "prepare_booking", "list_bookings", "prepare_cancellation"}
    ),
    handles_booking=True,
)
TRANSPORT = Specialist(
    name="transport",
    title="transport",
    description="Getting between cities: flights, trains and buses, with search links to the sites that "
    "have real times and fares.",
    prompt_files=("transport",),
    tools=frozenset({"transport_search_links"}),
)
RESTAURANTS = Specialist(
    name="restaurants",
    title="restaurants",
    description="Restaurants: finding where to eat a particular dish or cuisine in an area, reserving a table, "
    "checking or cancelling a table reservation.",
    prompt_files=("restaurants",),
    tools=frozenset(
        {"find_restaurants", "prepare_table_booking", "list_table_bookings", "prepare_table_cancellation"}
    ),
)
# Everything in one agent, for use without routing.
GENERALIST = Specialist(
    name="general",
    title="general",
    description="Everything.",
    prompt_files=("guide", "planning", "conditions", "hotels", "transport", "restaurants"),
    tools=None,
    handles_booking=True,
)

SPECIALISTS: dict[str, Specialist] = {s.name: s for s in (GUIDE, TRIP_PLANNER, HOTELS, TRANSPORT, RESTAURANTS)}
DEFAULT_SPECIALIST = GUIDE.name


def _read(name: str) -> str:
    return (_PROMPTS / f"{name}_{PROMPT_VERSION}.md").read_text(encoding="utf-8")


def _others(specialist: Specialist) -> list[Specialist]:
    return [other for other in SPECIALISTS.values() if other.name != specialist.name]


def build_system_prompt(today: date, specialist: Specialist, tool_names: set[str] | None = None) -> str:
    """Instructions for this specialist at this step. Sections about tools that are
    not on offer are left out."""
    team = ""
    if specialist.name in SPECIALISTS:
        others = "\n".join(f"- `{other.name}`: {other.description}" for other in _others(specialist))
        team = _read("team").replace("{specialist}", specialist.title).replace("{others}", others)
    parts = [_read("core").replace("{team}", team)]
    parts += [_read(name) for name in specialist.prompt_files]
    if specialist.handles_booking:
        bookable = tool_names is None or tool_names & BOOKING_TOOLS
        parts.append(_read("booking") if bookable else _NO_BOOKING_YET)
    return "\n".join(parts).replace("{today}", today.strftime("%A, %d %B %Y"))


def hand_off_schema(specialist: Specialist) -> dict[str, Any] | None:
    if specialist.name not in SPECIALISTS:
        return None
    return {
        "type": "function",
        "function": {
            "name": HAND_OFF,
            "description": "Pass the traveller's request to the specialist it belongs to.",
            "parameters": {
                "type": "object",
                "properties": {
                    "specialist": {"type": "string", "enum": [other.name for other in _others(specialist)]}
                },
                "required": ["specialist"],
            },
        },
    }


async def choose_specialist(
    llm: LLMProvider,
    message: str,
    last_reply: str | None,
    previous: str | None,
    allow_multi: bool = True,
    trip_note: str | None = None,
) -> str:
    """The supervisor's one decision: who takes this message, or MULTI when it needs several.

    A failed or unreadable answer never blocks the turn: the previous specialist
    (or the guide) takes it, and can hand off if that was wrong.
    """
    fallback = previous if previous in SPECIALISTS else DEFAULT_SPECIALIST
    listing = "\n".join(f"- {s.name}: {s.description}" for s in SPECIALISTS.values())
    system = _read("router").replace("{specialists}", listing).replace("{previous}", previous or "none yet")
    if not allow_multi:
        system = re.sub(r"\n- multi:.*?\n\nChoose multi only[^\n]*\n", "\n", system, flags=re.DOTALL)
    content = f"Traveller's message: {message[:600]}"
    if last_reply:
        content = f"Companion's last message: {last_reply[:400]}\n\n{content}"
    if trip_note:
        # A trip in progress is the strongest hint that a vague follow-up is about planning it.
        content = f"{trip_note[:700]}\n\n{content}"
    try:
        answer = ""
        async for chunk in llm.stream([{"role": "system", "content": system}, {"role": "user", "content": content}]):
            if isinstance(chunk, Completion):
                answer = chunk.content
    except LLMError as exc:
        logger.warning("router failed, using %s: %s", fallback, exc)
        return fallback
    answer = answer.lower()
    if allow_multi and re.search(rf"\b{MULTI}\b", answer):
        return MULTI
    # Longest name first, so a name contained in another cannot shadow it.
    for name in sorted(SPECIALISTS, key=len, reverse=True):
        if name in answer:
            return name
    logger.warning("router gave no usable answer (%r), using %s", answer[:80], fallback)
    return fallback
