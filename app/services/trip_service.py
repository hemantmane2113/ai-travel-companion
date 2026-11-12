from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Trip
from app.schemas.trip import TripRequirementsArgs
from app.services import travel_dates

MAX_TRIP_DAYS = 30


class TripError(Exception):
    """The trip details are not valid. The message explains what to fix."""


async def get_trip(db: AsyncSession, conversation_id: int) -> Trip | None:
    return await db.scalar(select(Trip).where(Trip.conversation_id == conversation_id))


def trip_dates(trip: Trip) -> list[date]:
    if trip.start_date is None or trip.end_date is None:
        return []
    days = (trip.end_date - trip.start_date).days + 1
    return [trip.start_date + timedelta(days=offset) for offset in range(days)]


def missing_requirements(trip: Trip) -> list[str]:
    """What still has to be asked before an itinerary can be planned."""
    missing = []
    if not trip.destination:
        missing.append("destination")
    if trip.start_date is None or trip.end_date is None:
        missing.append("travel dates")
    if trip.adults is None:
        missing.append("number of travellers")
    if trip.budget_total is None and trip.budget_level is None:
        missing.append("budget")
    if not trip.interests:
        missing.append("interests")
    return missing


def trip_summary(trip: Trip) -> dict[str, Any]:
    missing = missing_requirements(trip)
    return {
        "destination": trip.destination,
        "origin": trip.origin,
        "start_date": trip.start_date.isoformat() if trip.start_date else None,
        "end_date": trip.end_date.isoformat() if trip.end_date else None,
        "dates": [day.isoformat() for day in trip_dates(trip)],
        "adults": trip.adults,
        "children": trip.children,
        "budget_total": float(trip.budget_total) if trip.budget_total is not None else None,
        "currency": trip.currency,
        "budget_level": trip.budget_level,
        "interests": trip.interests,
        "pace": trip.pace,
        "must_visit": trip.must_visit,
        "notes": trip.notes,
        "missing_before_planning": missing,
        "ready_to_plan": not missing,
    }


async def save_requirements(
    db: AsyncSession, user_id: int, conversation_id: int, args: TripRequirementsArgs, today: date
) -> Trip:
    trip = await get_trip(db, conversation_id)
    if trip is None:
        trip = Trip(user_id=user_id, conversation_id=conversation_id)

    updates = args.model_dump(exclude_none=True, exclude={"year_confirmed"})
    start = updates.get("start_date", trip.start_date)
    end = updates.get("end_date", trip.end_date)
    if start and start < today:
        raise TripError(travel_dates.past_dates_message(start, end, today))
    # Only new dates are checked: dates already saved were confirmed when they were saved.
    if "start_date" in updates and not args.year_confirmed and travel_dates.is_far_ahead(start, today):
        raise TripError(travel_dates.far_ahead_message(start, end, today))
    if start and end:
        if end < start:
            raise TripError("end_date is before start_date.")
        if (end - start).days + 1 > MAX_TRIP_DAYS:
            raise TripError(f"Trips longer than {MAX_TRIP_DAYS} days are not supported.")
    if "budget_total" in updates and not updates.get("currency", trip.currency):
        raise TripError("budget_total needs a currency.")

    for field, value in updates.items():
        setattr(trip, field, value.upper() if field == "currency" else value)
    db.add(trip)
    await db.commit()
    return trip
