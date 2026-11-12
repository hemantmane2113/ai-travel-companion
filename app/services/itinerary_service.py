from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Itinerary, Trip
from app.schemas.trip import ItineraryDay, SaveItineraryArgs
from app.services.trip_service import missing_requirements, trip_dates

MAX_ITEMS_PER_DAY = {"relaxed": 3, "moderate": 5, "packed": 8}
DEFAULT_PACE = "moderate"
# A long trip is saved in parts: the whole of a two-week plan in one tool call is more
# than models can write reliably, and more than a free-tier request allows.
MAX_DAYS_PER_CALL = 5
MAX_TIPS = 8


class ItineraryError(Exception):
    """The proposed itinerary breaks a rule. The message lists every problem."""


def _normalise(text: str) -> str:
    return " ".join(text.lower().split())


def _require_complete_details(trip: Trip) -> None:
    missing = missing_requirements(trip)
    if missing:
        raise ItineraryError(f"Trip details are incomplete: {', '.join(missing)}. Ask the traveller first.")


def day_problems(trip: Trip, days: list[ItineraryDay], known_source_urls: set[str]) -> list[str]:
    """Rules each day must meet on its own: the pace limit and sources that were really retrieved."""
    problems: list[str] = []
    limit = MAX_ITEMS_PER_DAY[trip.pace or DEFAULT_PACE]
    for day in days:
        if len(day.items) > limit:
            problems.append(
                f"{day.date.isoformat()} has {len(day.items)} stops; a {trip.pace or DEFAULT_PACE} pace allows at most {limit}."
            )
        for item in day.items:
            # A "#section" anchor on a page we did retrieve is still that page.
            if item.source_url and item.source_url.split("#")[0] not in known_source_urls:
                problems.append(
                    f"source_url for '{item.place}' was not returned by a lookup in this conversation. "
                    "Look the place up or leave source_url empty."
                )
    return problems


def plan_problems(trip: Trip, days: list[ItineraryDay]) -> list[str]:
    """Rules for the plan as a whole: exactly the trip's dates, and every must-visit place."""
    problems: list[str] = []
    expected = [day.isoformat() for day in trip_dates(trip)]
    given = [day.date.isoformat() for day in days]
    if given != expected:
        problems.append(f"Days must be exactly one per trip date, in order: {', '.join(expected)}. Got: {', '.join(given)}.")
    places = [_normalise(f"{item.place} {item.activity}") for day in days for item in day.items]
    for wanted in trip.must_visit or []:
        if not any(_normalise(wanted) in place for place in places):
            problems.append(f"Must-visit place '{wanted}' is not in the plan.")
    return problems


def validate_itinerary(trip: Trip, args: SaveItineraryArgs, known_source_urls: set[str]) -> None:
    """Check a complete plan against the facts we hold. The model proposes; this decides."""
    _require_complete_details(trip)
    problems = plan_problems(trip, args.days) + day_problems(trip, args.days, known_source_urls)
    if problems:
        raise ItineraryError(" ".join(problems))


async def save_days(
    db: AsyncSession, trip: Trip, args: SaveItineraryArgs, known_source_urls: set[str]
) -> tuple[Itinerary | None, list[date]]:
    """Add these days to the plan being built.

    Returns the saved itinerary once every trip date has a day, and the dates still
    missing otherwise. Days can be sent in any order and resent to replace them.
    """
    _require_complete_details(trip)
    trip_days = trip_dates(trip)
    problems: list[str] = []
    if len(args.days) > MAX_DAYS_PER_CALL:
        problems.append(f"Send at most {MAX_DAYS_PER_CALL} days per call, then call again for the rest.")
    given = [day.date for day in args.days]
    outside = [day.isoformat() for day in given if day not in trip_days]
    if outside:
        problems.append(f"{', '.join(outside)} {'is' if len(outside) == 1 else 'are'} not a trip date.")
    if len(set(given)) != len(given):
        problems.append("The same date appears twice.")
    problems += day_problems(trip, args.days, known_source_urls)
    if problems:
        raise ItineraryError(" ".join(problems))

    draft = dict(trip.itinerary_draft or {"days": {}, "summary": "", "tips": []})
    days = dict(draft["days"])
    for day in args.days:
        days[day.date.isoformat()] = day.model_dump(mode="json")
    tips = list(dict.fromkeys([*draft["tips"], *args.tips]))[:MAX_TIPS]
    draft = {"days": days, "summary": args.summary or draft["summary"], "tips": tips}

    remaining = [day for day in trip_days if day.isoformat() not in days]
    if remaining:
        trip.itinerary_draft = draft
        await db.commit()
        return None, remaining

    complete = SaveItineraryArgs(
        summary=draft["summary"], days=[days[day.isoformat()] for day in trip_days], tips=draft["tips"]
    )
    problems = plan_problems(trip, complete.days)
    if problems:
        # Keep what was saved: only the missing piece needs fixing.
        trip.itinerary_draft = draft
        await db.commit()
        raise ItineraryError(" ".join(problems) + " Resend the days that need changing.")

    latest = await db.scalar(select(func.max(Itinerary.version)).where(Itinerary.trip_id == trip.id))
    itinerary = Itinerary(trip_id=trip.id, version=(latest or 0) + 1, data=complete.model_dump(mode="json"))
    db.add(itinerary)
    trip.itinerary_draft = None
    await db.commit()
    return itinerary, []


async def save_itinerary(
    db: AsyncSession, trip: Trip, args: SaveItineraryArgs, known_source_urls: set[str]
) -> Itinerary:
    """Save a complete plan in one go."""
    validate_itinerary(trip, args, known_source_urls)
    latest = await db.scalar(select(func.max(Itinerary.version)).where(Itinerary.trip_id == trip.id))
    itinerary = Itinerary(trip_id=trip.id, version=(latest or 0) + 1, data=args.model_dump(mode="json"))
    db.add(itinerary)
    await db.commit()
    return itinerary


def itinerary_card(trip: Trip, itinerary: Itinerary) -> dict[str, Any]:
    return {
        "type": "itinerary",
        "destination": trip.destination,
        "start_date": trip.start_date.isoformat(),
        "end_date": trip.end_date.isoformat(),
        "adults": trip.adults,
        "children": trip.children or 0,
        "version": itinerary.version,
        **itinerary.data,
    }
