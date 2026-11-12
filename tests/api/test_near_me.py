"""'Near me': the traveller's position, shared from their browser for one message."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select

from app.models import Message
from app.providers.maps.base import GeoPoint
from app.providers.maps.nominatim import NominatimGeocoder, area_name
from app.schemas.client import ClientInfo
from tests.conftest import call, new_conversation, say, sse_events, tool_results

# A precise position just south of the fake restaurants (see FakeRestaurants).
HERE = {"latitude": 28.598765, "longitude": 77.211234, "accuracy_m": 25}
NEAR_ME = {"near_traveller": True, "cuisine_keywords": []}


async def _chat(client, conversation_id, text, **client_info):
    response = await client.post(
        f"/api/conversations/{conversation_id}/chat", json={"message": text, "client": client_info}
    )
    assert response.status_code == 200
    return sse_events(response.text)


async def test_without_a_shared_location_the_traveller_gets_a_share_button(client, llm, restaurants):
    conversation_id = await new_conversation(client)
    llm.queue(call("find_restaurants", NEAR_ME), say("Press the button to share your location."))

    events = await _chat(client, conversation_id, "find good restaurants near me")

    card = next(data for event, data in events if event == "card")
    assert card == {"type": "location_request", "purpose": "find places to eat near you"}
    result = tool_results(llm)[0]
    assert "has not been shared" in result["error"] and "Do not guess" in result["reply_instructions"]
    assert restaurants.asked == []  # nothing searched without a position


async def test_a_shared_location_is_searched_and_never_kept(client, llm, restaurants, geocoder, session_factory):
    conversation_id = await new_conversation(client)
    llm.queue(call("find_restaurants", NEAR_ME), say("Here are the nearest places."))

    events = await _chat(client, conversation_id, "Here is my location.", location=HERE)

    card = next(data for event, data in events if event == "card")
    assert card["type"] == "restaurants" and card["near_traveller"] is True and card["area"] == "Kothrud, Pune"
    assert card["restaurants"][0]["name"] == "Pizza Point"  # nearest first when no dish was asked for
    assert card["restaurants"][0]["distance_km"] == 0.23  # from the exact position, to 10 m

    # Outside services get the position rounded to about 100 m.
    searched_from, _ = restaurants.asked[0]
    assert (searched_from.latitude, searched_from.longitude) == (28.599, 77.211)
    assert geocoder.described[0].latitude == HERE["latitude"]  # the provider itself rounds (tested below)

    result = tool_results(llm)[0]
    assert result["area"] == "Kothrud, Pune" and "Refer to it by the area name only" in result["location_note"]
    assert "28.598" not in str(result)  # the model never sees the coordinates

    async with session_factory() as db:
        stored = " ".join(f"{row.content} {row.meta}" for row in await db.scalars(select(Message)))
    assert "28.5987" not in stored and "77.2112" not in stored


async def test_the_model_is_told_when_a_position_came_with_the_message(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("Hi."), say("Hi again."))
    await _chat(client, conversation_id, "find a good restaurants near me", location=HERE)
    assert "shared their position with this message" in llm.calls[-1]["messages"][0]["content"]
    await _chat(client, conversation_id, "thanks")
    assert "shared their position" not in llm.calls[-1]["messages"][0]["content"]  # for that message only


async def test_a_rough_position_is_flagged(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("find_restaurants", NEAR_ME), say("Here."))
    await _chat(client, conversation_id, "Here is my location.", location={**HERE, "accuracy_m": 4000})
    assert "only approximate (within about 4.0 km)" in tool_results(llm)[0]["location_note"]


async def test_a_named_place_still_needs_a_city(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("find_restaurants", {"cuisine_keywords": []}), say("Which city?"))
    await _chat(client, conversation_id, "restaurants please")
    assert "near_traveller" in tool_results(llm)[0]["error"]


async def test_today_is_the_travellers_own_date(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("Hello."))
    await _chat(client, conversation_id, "Hi", timezone="Pacific/Kiritimati")  # UTC+14: often a day ahead
    their_today = datetime.now(ZoneInfo("Pacific/Kiritimati")).strftime("%d %B %Y")
    assert f"Today is {datetime.now(ZoneInfo('Pacific/Kiritimati')).strftime('%A')}, {their_today}" in (
        llm.calls[-1]["messages"][0]["content"]
    )


def test_unknown_timezones_fall_back_to_the_server_date():
    info = ClientInfo(timezone="Mars/Olympus_Mons")
    assert info.timezone is None and info.today() == date.today()


def test_area_names_come_from_the_finest_named_part_of_the_address():
    assert area_name({"suburb": "Shivajinagar", "city": "Pune", "state": "Maharashtra"}) == "Shivajinagar, Pune"
    assert area_name({"neighbourhood": "Deccan", "suburb": "Shivajinagar", "city": "Pune"}) == "Deccan, Pune"
    assert area_name({"town": "Lonavala"}) == "Lonavala"
    assert area_name({"village": "Ambi", "county": "Ambi"}) == "Ambi"
    assert area_name({"country": "India"}) is None


async def test_nominatim_reverse_lookup_sends_a_rounded_point_to_the_configured_server():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"address": {"suburb": "Kothrud", "city": "Pune"}})

    geocoder = NominatimGeocoder(
        "test",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        min_interval=0,
        base_url="https://nominatim.example.org/",
    )
    assert await geocoder.describe(GeoPoint(18.507654, 73.807321)) == "Kothrud, Pune"
    assert seen["url"].startswith("https://nominatim.example.org/reverse?")
    assert "lat=18.508" in seen["url"] and "lon=73.807" in seen["url"] and "18.5076" not in seen["url"]
