from datetime import date, timedelta

import pytest

from app.models import Trip
from app.schemas.trip import SaveItineraryArgs, TripRequirementsArgs
from app.services import trip_service
from app.services.itinerary_service import ItineraryError, validate_itinerary
from app.services.trip_service import TripError, missing_requirements, trip_dates

TODAY = date(2026, 9, 1)
RED_FORT_URL = "https://en.wikipedia.org/wiki/Red_Fort"


def _trip(**overrides) -> Trip:
    values = dict(
        destination="Delhi",
        start_date=date(2026, 9, 12),
        end_date=date(2026, 9, 13),
        adults=2,
        budget_level="mid-range",
        interests=["history"],
        pace="relaxed",
        must_visit=["Red Fort"],
    )
    values.update(overrides)
    return Trip(**values)


def _plan(days: list[tuple[str, list[str]]], source_url: str | None = None) -> SaveItineraryArgs:
    return SaveItineraryArgs(
        summary="Two days in Old and New Delhi.",
        days=[
            {
                "date": day,
                "theme": "Theme",
                "items": [
                    {"time_of_day": "morning", "place": place, "activity": "Walk around.", "source_url": source_url}
                    for place in places
                ],
            }
            for day, places in days
        ],
    )


def test_missing_requirements_lists_what_to_ask():
    assert missing_requirements(Trip(destination="Delhi")) == [
        "travel dates",
        "number of travellers",
        "budget",
        "interests",
    ]
    assert missing_requirements(_trip()) == []
    assert missing_requirements(_trip(budget_level=None, budget_total=50000)) == []


def test_trip_dates_are_inclusive():
    assert trip_dates(_trip(start_date=date(2026, 9, 12), end_date=date(2026, 9, 15))) == [
        date(2026, 9, 12),
        date(2026, 9, 13),
        date(2026, 9, 14),
        date(2026, 9, 15),
    ]


async def test_save_requirements_merges_and_validates(session_factory):
    async with session_factory() as db:
        first = TripRequirementsArgs(destination="Delhi", start_date="2026-09-12", end_date="2026-09-15")
        trip = await trip_service.save_requirements(db, 1, 1, first, TODAY)
        assert trip_service.trip_summary(trip)["ready_to_plan"] is False

        second = TripRequirementsArgs(adults=2, budget_total=60000, currency="inr", interests=["food"])
        trip = await trip_service.save_requirements(db, 1, 1, second, TODAY)
        summary = trip_service.trip_summary(trip)
        assert summary["destination"] == "Delhi"  # kept from the first call
        assert summary["currency"] == "INR"
        assert summary["ready_to_plan"] is True
        assert len(summary["dates"]) == 4

        with pytest.raises(TripError, match="before start_date"):
            await trip_service.save_requirements(db, 1, 1, TripRequirementsArgs(end_date="2026-09-10"), TODAY)
        with pytest.raises(TripError, match="in the past"):
            await trip_service.save_requirements(db, 1, 1, TripRequirementsArgs(start_date="2026-08-01"), TODAY)
        with pytest.raises(TripError, match="longer than"):
            await trip_service.save_requirements(
                db, 1, 1, TripRequirementsArgs(end_date=date(2026, 9, 12) + timedelta(days=40)), TODAY
            )


async def test_budget_amount_needs_currency(session_factory):
    async with session_factory() as db:
        with pytest.raises(TripError, match="currency"):
            await trip_service.save_requirements(db, 1, 1, TripRequirementsArgs(budget_total=500), TODAY)


def test_valid_itinerary_passes():
    plan = _plan([("2026-09-12", ["Red Fort"]), ("2026-09-13", ["Qutub Minar"])], RED_FORT_URL)
    validate_itinerary(_trip(), plan, {RED_FORT_URL})


def test_itinerary_rejected_when_trip_incomplete():
    with pytest.raises(ItineraryError, match="incomplete: budget"):
        validate_itinerary(_trip(budget_level=None), _plan([("2026-09-12", ["Red Fort"])]), set())


def test_itinerary_must_cover_exactly_the_trip_dates():
    with pytest.raises(ItineraryError, match="exactly one per trip date"):
        validate_itinerary(_trip(), _plan([("2026-09-12", ["Red Fort"])]), set())
    with pytest.raises(ItineraryError, match="exactly one per trip date"):
        validate_itinerary(_trip(), _plan([("2026-09-12", ["Red Fort"]), ("2026-09-14", ["Qutub Minar"])]), set())


def test_itinerary_respects_pace_must_visit_and_sources():
    crowded = _plan([("2026-09-12", ["Red Fort", "A", "B", "C"]), ("2026-09-13", ["D"])])
    with pytest.raises(ItineraryError, match="at most 3"):
        validate_itinerary(_trip(), crowded, set())

    without_fort = _plan([("2026-09-12", ["Jama Masjid"]), ("2026-09-13", ["Qutub Minar"])])
    with pytest.raises(ItineraryError, match="Must-visit place 'Red Fort'"):
        validate_itinerary(_trip(), without_fort, set())

    invented = _plan([("2026-09-12", ["Red Fort"]), ("2026-09-13", ["Qutub Minar"])], "https://example.com/made-up")
    with pytest.raises(ItineraryError, match="was not returned by a lookup"):
        validate_itinerary(_trip(), invented, {RED_FORT_URL})
