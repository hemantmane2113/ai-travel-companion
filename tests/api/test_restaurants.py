from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from sqlalchemy import update

from app.agent.specialists import RESTAURANTS, build_system_prompt
from app.models import TableBooking
from app.providers.maps.base import GeoPoint
from app.providers.restaurants.base import RestaurantsError
from app.providers.restaurants.mock_reservations import MockTableReservations
from app.providers.restaurants.overpass import (
    FallbackRestaurantProvider,
    NominatimRestaurantProvider,
    OverpassRestaurantProvider,
    parse_element,
)
from app.services import restaurant_service
from tests.conftest import call, chat, eatery, new_conversation, say, tool_results

FISH = ["seafood", "fish", "malvani", "konkani", "goan"]
SEARCH = {"city": "Pune", "area": "Kothrud", "dish": "fish curry", "cuisine_keywords": FISH}
DAY = (date.today() + timedelta(days=3)).isoformat()


# ---------- ranking ----------


def test_cuisine_match_beats_name_match_and_distance_breaks_ties():
    center = GeoPoint(28.60, 77.21)
    places = [
        eatery("Fish Land", ["indian"], 28.602),  # keyword only in the name
        eatery("Far Seafood", ["seafood"], 28.620),
        eatery("Near Seafood", ["seafood"], 28.601),
        eatery("Two Matches", ["goan", "sea_food", "seafood"], 28.615),
        eatery("Pizza Point", ["pizza"], 28.6001),
    ]

    ranked = restaurant_service.rank(places, center, ["seafood", "fish", "goan"])

    assert [r.name for r, _, _ in ranked] == ["Two Matches", "Near Seafood", "Far Seafood", "Fish Land"]
    assert ranked[0][2] == ["serves seafood", "serves goan"]
    assert ranked[3][2] == ["'fish' in its name"]


def test_vegetarian_only_places_are_left_out_for_meat_or_fish():
    center = GeoPoint(28.60, 77.21)
    places = [
        eatery("Shubham Pure Veg", ["indian", "seafood"], 28.601),
        eatery("Tagged Veg", ["seafood"], 28.602, vegetarian_only=True),
        eatery("Coastal", ["seafood"], 28.603),
    ]
    assert [r.name for r, _, _ in restaurant_service.rank(places, center, ["seafood"], needs_non_veg=True)] == ["Coastal"]
    assert len(restaurant_service.rank(places, center, ["seafood"])) == 3


async def test_broad_keywords_are_ignored(client, llm):
    conversation_id = await new_conversation(client)
    await _search(client, llm, conversation_id, {**SEARCH, "cuisine_keywords": ["indian", "food", "seafood"]})
    result = tool_results(llm)[-1]
    assert [r["name"] for r in result["restaurants"]] == ["Coastal Kitchen"]  # Udupi Bhavan etc. not matched on "indian"


def test_no_keywords_lists_everything_nearest_first():
    ranked = restaurant_service.rank(
        [eatery("B", ["pizza"], 28.62), eatery("A", [], 28.601)], GeoPoint(28.60, 77.21), []
    )
    assert [r.name for r, _, _ in ranked] == ["A", "B"]


# ---------- OpenStreetMap ----------


def test_element_is_normalised_and_unusable_ones_dropped():
    node = {
        "type": "node", "id": 42, "lat": 18.5, "lon": 73.8,
        "tags": {"name": "मजघर", "name:en": "Majghar", "cuisine": "maharashtrian;konkani, sea_food", "addr:housenumber": "12",
                 "addr:street": "Rambaug Colony Road", "addr:suburb": "Kothrud", "opening_hours": "Mo-Su 11:00-23:00",
                 "contact:phone": "+91 20 1234", "diet:vegetarian": "only"},
    }
    place = parse_element(node)
    assert place.name == "Majghar" and place.cuisines == ["maharashtrian", "konkani", "sea food"]
    assert place.address == "12 Rambaug Colony Road, Kothrud" and place.phone == "+91 20 1234"
    assert place.vegetarian_only and place.opening_hours == "Mo-Su 11:00-23:00"
    assert place.source_url == "https://www.openstreetmap.org/node/42"

    way = {"type": "way", "id": 7, "center": {"lat": 18.5, "lon": 73.8}, "tags": {"name": "Cafe"}}
    assert parse_element(way).latitude == 18.5 and parse_element(way).cuisines == []
    assert parse_element({"type": "node", "id": 1, "lat": 1, "lon": 1, "tags": {"amenity": "restaurant"}}) is None


async def test_overpass_falls_back_to_the_next_server_and_caches():
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        if request.url.host == "overpass-api.de":
            return httpx.Response(504)
        return httpx.Response(200, json={"elements": [{"type": "node", "id": 1, "lat": 18.5, "lon": 73.8, "tags": {"name": "A"}}]})

    provider = OverpassRestaurantProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    center = GeoPoint(18.5072, 73.8056)
    found = await provider.nearby(center, 2500)
    await provider.nearby(center, 2500)

    assert [r.name for r in found] == ["A"] and hosts == ["overpass-api.de", "maps.mail.ru"]

    down = OverpassRestaurantProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(504))))
    with pytest.raises(RestaurantsError):
        await down.nearby(center, 2500)


async def test_nominatim_search_covers_for_overpass():
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=[{
            "osm_type": "node", "osm_id": 11269059290, "lat": "18.50", "lon": "73.80", "name": "Prithvi Restaurant",
            "extratags": {"cuisine": "indian;sea_food", "opening_hours": "Mo-Su 11:00-23:00"},
            "address": {"house_number": "4", "road": "Lane 4", "suburb": "Kothrud"},
        }, {"osm_type": "node", "osm_id": 2, "lat": "18.5", "lon": "73.8", "name": None}])

    busy = OverpassRestaurantProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(504))))
    nominatim = NominatimRestaurantProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    found = await FallbackRestaurantProvider([busy, nominatim]).nearby(GeoPoint(18.5, 73.8), 2500)

    assert [(r.name, r.cuisines, r.address, r.opening_hours) for r in found] == [
        ("Prithvi Restaurant", ["indian", "sea food"], "4 Lane 4, Kothrud", "Mo-Su 11:00-23:00")
    ]
    assert found[0].source_url == "https://www.openstreetmap.org/node/11269059290"
    params = seen[0]
    assert params["amenity"] == "restaurant" and params["bounded"] == "1" and params["extratags"] == "1"
    west, north, east, south = map(float, params["viewbox"].split(","))
    assert west < 73.8 < east and south < 18.5 < north and round(north - 18.5, 3) == 0.023

    both_down = FallbackRestaurantProvider([busy, NominatimRestaurantProvider(
        "test", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))))])
    with pytest.raises(RestaurantsError):
        await both_down.nearby(GeoPoint(18.5, 73.8), 2500)


async def test_mock_reservations_issue_and_cancel_references():
    provider = MockTableReservations()
    reference = await provider.reserve(eatery("A", [], 1.0), date.today(), datetime.now().time(), 2, "Asha")
    assert reference.startswith("TD-") and provider.is_demo
    await provider.cancel(reference)
    with pytest.raises(RestaurantsError):
        await provider.cancel("SE-1234")


# ---------- search through the companion ----------


async def _search(client, llm, conversation_id, arguments=SEARCH):
    llm.queue(call("find_restaurants", arguments), say("Coastal Kitchen matches most closely."))
    return await chat(client, conversation_id, "I want to eat fish curry in Pune, Kothrud area")


async def test_search_returns_matches_with_honest_limits(client, llm, restaurants, geocoder):
    conversation_id = await new_conversation(client)
    events = await _search(client, llm, conversation_id)

    card = next(data for event, data in events if event == "card")
    assert card["type"] == "restaurants" and card["area"] == "Kothrud, Pune" and card["dish"] == "fish curry"
    assert [r["name"] for r in card["restaurants"]] == ["Coastal Kitchen", "Majghar", "Fish Land"]
    assert card["nearby_count"] == 5 and card["radius_km"] == 2.5
    assert card["restaurants"][0]["matched_on"] == ["serves seafood", "serves goan"]
    assert card["restaurants"][1]["opening_hours"] == "Mo-Su 11:00-23:00"

    result = tool_results(llm)[0]
    assert [r["name"] for r in result["restaurants"]] == ["Coastal Kitchen", "Majghar", "Fish Land"]
    assert "no ratings" in result["about_this_data"] and "do not invent ratings" in result["about_this_data"]
    assert geocoder.queries == ["Kothrud, Pune"] and restaurants.asked[0][1] == 2500


async def test_no_match_unknown_area_and_source_failure_are_reported(client, llm, restaurants):
    conversation_id = await new_conversation(client)

    events = await _search(client, llm, conversation_id, {**SEARCH, "cuisine_keywords": ["sushi"]})
    assert not [e for e in events if e[0] == "card"]
    assert "do not suggest restaurants from memory" in tool_results(llm)[-1]["note"]

    await _search(client, llm, conversation_id, {**SEARCH, "area": "Atlantis"})
    assert "Could not find 'Atlantis, Pune' on the map" in tool_results(llm)[-1]["error"]

    restaurants.error = RestaurantsError("The restaurant map service is not responding right now.")
    await _search(client, llm, conversation_id)
    assert "No restaurants were retrieved" in tool_results(llm)[-1]["error"]


async def test_city_wide_search_without_area_or_keywords(client, llm, geocoder):
    conversation_id = await new_conversation(client)
    events = await _search(client, llm, conversation_id, {"city": "Pune"})
    card = next(data for event, data in events if event == "card")
    assert card["area"] == "Pune" and len(card["restaurants"]) == 5 and geocoder.queries == ["Pune"]


# ---------- reserving ----------


async def _pending(client, llm, time="19:00", party=4) -> tuple[int, int]:
    conversation_id = await new_conversation(client)
    await _search(client, llm, conversation_id)
    restaurant_id = tool_results(llm)[-1]["restaurants"][1]["restaurant_id"]  # Majghar
    arguments = {"restaurant_id": restaurant_id, "date": DAY, "time": time, "party_size": party, "guest_name": "Asha Rao"}
    llm.queue(call("prepare_table_booking", arguments, "p"), say("Check the card and confirm."))
    events = await chat(client, conversation_id, "Book Majghar at 7 pm for 4, name Asha Rao")
    card = next(data for event, data in events if event == "card")
    assert card["type"] == "table_confirm"
    return card["booking_id"], conversation_id


async def test_prepare_does_not_reserve_and_confirm_does(client, llm, table_reservations):
    booking_id, conversation_id = await _pending(client, llm)

    prepared = tool_results(llm)[-1]
    assert prepared["status"].startswith("NOT RESERVED YET") and prepared["time"] == "19:00"
    assert prepared["published_opening_hours"] == "Mo-Su 11:00-23:00" and "simulated" in prepared["demo"]
    pending = (await client.get(f"/api/table-bookings/{booking_id}")).json()
    assert pending["status"] == "PENDING_CONFIRMATION" and pending["provider_reference"] is None
    assert pending["restaurant_name"] == "Majghar" and pending["party_size"] == 4 and pending["is_demo"] is True
    assert table_reservations.reserved == []

    confirmed = (await client.post(f"/api/table-bookings/{booking_id}/confirm")).json()

    assert confirmed["status"] == "CONFIRMED" and confirmed["provider_reference"] == "TD-0001"
    assert table_reservations.reserved[0][0] == "Majghar" and table_reservations.reserved[0][3] == 4
    assert (await client.post(f"/api/table-bookings/{booking_id}/confirm")).status_code == 409
    assert len(table_reservations.reserved) == 1

    # The outcome is in the conversation, and says the reservation is simulated.
    messages = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert "Reference TD-0001" in messages[-1]["content"] and "simulated reservation" in messages[-1]["content"]

    llm.queue(call("list_table_bookings", {}, "l"), say("It is reserved."))
    await chat(client, conversation_id, "Is my table booked?")
    assert tool_results(llm)[-1]["reservations"][0]["status"] == "CONFIRMED"


async def test_invalid_requests_are_refused(client, llm):
    conversation_id = await new_conversation(client)
    await _search(client, llm, conversation_id)
    restaurant_id = tool_results(llm)[-1]["restaurants"][0]["restaurant_id"]
    base = {"restaurant_id": restaurant_id, "date": DAY, "time": "19:00", "party_size": 2, "guest_name": "Asha"}
    past = (date.today() - timedelta(days=1)).isoformat()
    far = (date.today() + timedelta(days=200)).isoformat()
    llm.queue(
        call("prepare_table_booking", {**base, "date": past}, "a"),
        call("prepare_table_booking", {**base, "date": far}, "b"),
        call("prepare_table_booking", {**base, "restaurant_id": 9999}, "c"),
        call("prepare_table_booking", {**base, "time": "7pm"}, "d"),
        say("I could not prepare that."),
    )

    events = await chat(client, conversation_id, "Book it")

    errors = [r["error"] for r in tool_results(llm)[-4:]]
    assert "in the past" in errors[0] and "90 days ahead" in errors[1]
    assert "There is no restaurant 9999" in errors[2] and errors[3] == "Invalid arguments."
    assert all("Nothing was reserved" in e for e in errors[:3])
    assert not [e for e in events if e[0] == "card"]


async def test_cancellation_needs_the_travellers_confirmation(client, llm, table_reservations):
    booking_id, conversation_id = await _pending(client, llm)
    await client.post(f"/api/table-bookings/{booking_id}/confirm")

    llm.queue(call("prepare_table_cancellation", {"booking_id": booking_id}, "c"), say("Press confirm to cancel."))
    events = await chat(client, conversation_id, "Cancel my table")

    assert next(d for e, d in events if e == "card") == {"type": "table_cancel_confirm", "booking_id": booking_id}
    assert tool_results(llm)[-1]["status"].startswith("NOT CANCELLED YET")
    assert (await client.get(f"/api/table-bookings/{booking_id}")).json()["status"] == "CONFIRMED"
    assert table_reservations.cancelled == []

    cancelled = (await client.post(f"/api/table-bookings/{booking_id}/cancel")).json()
    assert cancelled["status"] == "CANCELLED" and table_reservations.cancelled == ["TD-0001"]
    assert (await client.post(f"/api/table-bookings/{booking_id}/cancel")).status_code == 409


async def test_provider_failures_are_not_recorded_as_done(client, llm, table_reservations):
    booking_id, _ = await _pending(client, llm)
    table_reservations.error = RestaurantsError("TableDemo (demo) did not respond in time.")

    failed = (await client.post(f"/api/table-bookings/{booking_id}/confirm")).json()
    assert failed["status"] == "FAILED" and failed["provider_reference"] is None
    assert failed["failure_reason"] == "TableDemo (demo) did not respond in time."

    table_reservations.error = None
    second, _ = await _pending(client, llm)
    await client.post(f"/api/table-bookings/{second}/confirm")
    table_reservations.error = RestaurantsError("TableDemo (demo) did not respond in time.")
    response = await client.post(f"/api/table-bookings/{second}/cancel")
    assert response.status_code == 409 and response.json()["detail"].endswith("The reservation has not been cancelled.")
    assert (await client.get(f"/api/table-bookings/{second}")).json()["status"] == "CONFIRMED"


async def test_expired_request_and_other_users_are_refused(client, other_client, anon, llm, session_factory, table_reservations):
    booking_id, _ = await _pending(client, llm)

    assert (await anon.post(f"/api/table-bookings/{booking_id}/confirm")).status_code == 401
    assert (await other_client.get(f"/api/table-bookings/{booking_id}")).status_code == 404
    assert (await other_client.post(f"/api/table-bookings/{booking_id}/confirm")).status_code == 404
    assert (await other_client.post(f"/api/table-bookings/{booking_id}/cancel")).status_code == 404
    assert (await other_client.get("/api/table-bookings")).json() == []

    async with session_factory() as db:
        await db.execute(update(TableBooking).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        await db.commit()
    assert (await client.get(f"/api/table-bookings/{booking_id}")).json()["status"] == "EXPIRED"
    response = await client.post(f"/api/table-bookings/{booking_id}/confirm")
    assert response.status_code == 409 and "expired" in response.json()["detail"]
    assert table_reservations.reserved == []


async def test_table_tools_appear_only_when_usable(client, other_client, llm):
    await _pending(client, llm)  # gives the first user a search result and a pending reservation

    conversation_id = await new_conversation(other_client)
    llm.queue(
        call("prepare_table_booking", {"restaurant_id": 1, "date": DAY, "time": "19:00", "party_size": 2, "guest_name": "Ravi"}),
        call("prepare_table_cancellation", {"booking_id": 1}, "c"),
        say("Not possible."),
    )
    await chat(other_client, conversation_id, "Book restaurant 1")

    offered = {s["function"]["name"] for s in llm.calls[-1]["tools"]}
    assert "find_restaurants" in offered and "prepare_table_booking" not in offered
    results = tool_results(llm)
    assert results[0]["error"].startswith("'prepare_table_booking' cannot be used yet. Run find_restaurants first")
    assert results[1]["error"] == "'prepare_table_cancellation' cannot be used yet. The traveller has no table reservations."


def test_restaurant_specialist_is_told_not_to_rank_by_quality():
    prompt = build_system_prompt(date(2026, 9, 30), RESTAURANTS, set(RESTAURANTS.tools))
    assert 'Never call a restaurant "the best"' in prompt and "## Planning a trip" not in prompt
    assert "`transport`:" in prompt and "{" not in prompt
