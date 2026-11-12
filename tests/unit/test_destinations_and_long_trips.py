from datetime import date, timedelta

import httpx
import pytest

from app.models import Trip
from app.providers.maps.nominatim import NominatimGeocoder, pick_destination
from app.schemas.trip import SaveItineraryArgs
from app.services import itinerary_service
from app.services.itinerary_service import ItineraryError

# Nominatim's answers for "Kashmir", trimmed. The two villages come first in its list.
KASHMIR = [
    {"name": "Kashmir", "lat": "26.26", "lon": "71.60", "importance": 0.147, "addresstype": "village",
     "boundingbox": ["26.24", "26.28", "71.58", "71.62"], "address": {"state": "Rajasthan", "country": "India", "country_code": "in"}},
    {"name": "Kashmir", "lat": "31.9", "lon": "77.1", "importance": 0.133, "addresstype": "hamlet",
     "boundingbox": ["31.89", "31.91", "77.09", "77.11"], "address": {"state": "Himachal Pradesh", "country": "India", "country_code": "in"}},
    {"name": "Jammu and Kashmir", "lat": "33.66", "lon": "75.16", "importance": 0.590, "addresstype": "state",
     "boundingbox": ["32.27", "34.65", "73.75", "76.79"], "address": {"state": "Jammu and Kashmir", "country": "India", "country_code": "in"}},
]


def test_the_most_prominent_match_wins_over_villages_of_the_same_name():
    city = pick_destination(KASHMIR)
    assert city.name == "Jammu and Kashmir" and city.country_code == "IN"
    assert city.region is None  # a state is not "in" itself
    assert 150 < city.radius_km < 250  # a state reaches far; a village would be the 40 km minimum


def test_a_city_keeps_its_state_and_a_small_radius():
    city = pick_destination(
        [{"name": "Indore", "lat": "22.72", "lon": "75.87", "importance": 0.6, "boundingbox": ["22.56", "22.88", "75.70", "76.02"],
          "address": {"state": "Madhya Pradesh", "country": "India", "country_code": "in"}}]
    )
    assert (city.name, city.region) == ("Indore", "Madhya Pradesh")
    assert city.radius_km == 40.0  # a city smaller than the minimum gets the minimum
    assert pick_destination([]) is None


async def test_destination_lookups_are_cached():
    calls = []

    def handler(request):
        calls.append(dict(request.url.params))
        return httpx.Response(200, json=KASHMIR)

    finder = NominatimGeocoder("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), min_interval=0)
    first = await finder.find_destination("Kashmir")
    again = await finder.find_destination("  kashmir ")
    assert first == again and len(calls) == 1
    assert calls[0]["limit"] == "6" and calls[0]["addressdetails"] == "1"


# ---------- saving a long itinerary in parts ----------

START = date.today() + timedelta(days=30)


def _trip(days: int) -> Trip:
    return Trip(
        id=1, user_id=1, conversation_id=1, destination="Kashmir", start_date=START, end_date=START + timedelta(days=days - 1), adults=2,
        budget_level="budget", interests=["nature"], pace="moderate", must_visit=["Gulmarg"],
    )


def _days(first: int, count: int, place: str = "Dal Lake") -> list[dict]:
    return [
        {"date": (START + timedelta(days=first + i)).isoformat(), "theme": "Day",
         "items": [{"time_of_day": "morning", "place": place, "activity": "Visit."}]}
        for i in range(count)
    ]


async def _save(db, trip, days, summary=""):
    return await itinerary_service.save_days(db, trip, SaveItineraryArgs(summary=summary, days=days, tips=["Pack warm"]), set())


async def test_a_long_trip_is_saved_in_parts_and_completes_on_the_last(session_factory):
    trip = _trip(12)
    async with session_factory() as db:
        db.add(trip)
        await db.commit()

        itinerary, remaining = await _save(db, trip, _days(0, 5), "Twelve days in the valley.")
        assert itinerary is None and len(remaining) == 7 and remaining[0] == START + timedelta(days=5)
        itinerary, remaining = await _save(db, trip, _days(5, 5))
        assert itinerary is None and len(remaining) == 2
        itinerary, remaining = await _save(db, trip, _days(10, 1, "Gulmarg") + _days(11, 1))

        assert remaining == [] and itinerary.version == 1
        data = itinerary.data
        assert [d["date"] for d in data["days"]] == [(START + timedelta(days=i)).isoformat() for i in range(12)]
        assert data["summary"] == "Twelve days in the valley." and data["tips"] == ["Pack warm"]
        assert trip.itinerary_draft is None


async def test_parts_are_checked_as_they_arrive(session_factory):
    trip = _trip(12)
    async with session_factory() as db:
        db.add(trip)
        await db.commit()
        with pytest.raises(ItineraryError, match="at most 5 days per call"):
            await _save(db, trip, _days(0, 6))
        with pytest.raises(ItineraryError, match="not a trip date"):
            await _save(db, trip, _days(20, 1))
        with pytest.raises(ItineraryError, match="appears twice"):
            await _save(db, trip, _days(0, 1) + _days(0, 1))


async def test_a_resent_day_replaces_the_earlier_one_and_must_visit_is_checked_at_the_end(session_factory):
    trip = _trip(2)
    async with session_factory() as db:
        db.add(trip)
        await db.commit()
        await _save(db, trip, _days(0, 1))
        with pytest.raises(ItineraryError, match="Must-visit place 'Gulmarg'"):
            await _save(db, trip, _days(1, 1))
        # Nothing is lost: resending one day with the must-visit place completes the plan.
        itinerary, remaining = await _save(db, trip, _days(1, 1, "Gulmarg"))
        assert remaining == [] and itinerary.data["days"][1]["items"][0]["place"] == "Gulmarg"
