from datetime import date, timedelta
from urllib.parse import parse_qs, unquote, urlparse

import pytest

from app.agent.specialists import HOTELS, TRANSPORT, build_system_prompt
from app.services import search_links
from app.services.search_links import SearchLinkError
from tests.conftest import call, chat, new_conversation, say, tool_results

TODAY = date(2026, 10, 1)
DAY = date(2026, 10, 15)
BACK = date(2026, 10, 18)


def _query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


# The formats below were checked by opening them in a browser; these tests pin them.


def test_flight_links_one_way_and_round_trip():
    one_way = search_links.flight_links("Pune", "New Delhi", DAY, None, 1, TODAY)
    google, ixigo = one_way.links
    assert unquote(google.url.split("q=")[1]) == "Flights from Pune to New Delhi on 2026-10-15 one way 1 adult"
    assert ixigo.url.startswith("https://www.ixigo.com/search/result/flight?")
    params = _query(ixigo.url)
    assert params["from"] == "PNQ" and params["to"] == "DEL" and params["date"] == "15102026" and params["adults"] == "1"
    assert "returnDate" not in params  # empty for one way

    round_trip = search_links.flight_links("Bombay", "Bengaluru", DAY, BACK, 2, TODAY)
    assert "returning 2026-10-18 2 adults" in unquote(round_trip.links[0].url)
    params = _query(round_trip.links[1].url)
    assert params["from"] == "BOM" and params["to"] == "BLR" and params["returnDate"] == "18102026"
    assert round_trip.subtitle == "15 Oct 2026, back 18 Oct 2026 · 2 adults"


def test_unknown_airport_falls_back_to_google_only():
    found = search_links.flight_links("Pune", "Shirdi", DAY, None, 1, TODAY)
    assert [l.provider for l in found.links] == ["Google Flights"]
    assert found.gaps == ["No airport code known for Shirdi, so only Google Flights is linked."]


def test_train_links_use_station_codes_and_always_offer_a_fallback():
    found = search_links.train_links("Pune", "Delhi", DAY, 2, TODAY)
    assert found.links[0].url == "https://www.ixigo.com/search/result/train/PUNE/NDLS/15102026//1/0/0/0/ALL"
    assert [l.provider for l in found.links] == ["ixigo Trains", "Google", "IRCTC"]

    unknown = search_links.train_links("Pune", "Lonavala", DAY, 1, TODAY)
    assert [l.provider for l in unknown.links] == ["Google", "IRCTC"]
    assert unknown.gaps == ["No station code known for Lonavala."]


def test_bus_links_use_redbus_city_slugs():
    found = search_links.bus_links("Bengaluru", "Mysuru", DAY, TODAY)
    url = found.links[0].url
    assert url.startswith("https://www.redbus.in/bus-tickets/bangalore-to-mysore?")
    assert _query(url) == {"fromCityName": "Bengaluru", "toCityName": "Mysuru", "onward": "15-Oct-2026"}


def test_hotel_links():
    found = search_links.hotel_links("Delhi", "Karol Bagh", DAY, BACK, 2, 1, TODAY)
    google, booking = found.links
    assert unquote(google.url.split("q=")[1]) == "hotels in Karol Bagh, Delhi from 15 October 2026 to 18 October 2026 for 2 adults"
    assert _query(booking.url) == {
        "ss": "Karol Bagh, Delhi", "checkin": "2026-10-15", "checkout": "2026-10-18",
        "group_adults": "2", "no_rooms": "1", "group_children": "0",
    }
    assert found.subtitle == "15 Oct to 18 Oct 2026 · 3 nights · 2 adults, 1 room"


def test_hotel_links_with_a_price_limit_filter_booking_com():
    found = search_links.hotel_links("Indore", None, DAY, BACK, 2, 1, TODAY, 4000)
    google, booking = found.links
    params = _query(booking.url)
    assert params["nflt"] == "price=INR-0-4000-1" and params["order"] == "price"
    assert "4000" not in unquote(google.url)  # Google Hotels ignores a price in its query
    assert found.subtitle.endswith("· up to ₹4,000 a night")


@pytest.mark.parametrize(
    "build, message",
    [
        (lambda: search_links.flight_links("Pune", "Delhi", date(2026, 9, 1), None, 1, TODAY), "in the past"),
        (lambda: search_links.flight_links("Pune", "Delhi", DAY, date(2026, 10, 10), 1, TODAY), "before the first date"),
        (lambda: search_links.flight_links("Pune", "Delhi", date(2027, 11, 1), None, 1, TODAY), "more than a year"),
        (lambda: search_links.bus_links("Bangalore", "Bengaluru", DAY, TODAY), "same place"),
        (lambda: search_links.hotel_links("Delhi", None, DAY, DAY, 2, 1, TODAY), "at least one night"),
    ],
)
def test_impossible_requests_are_refused(build, message):
    with pytest.raises(SearchLinkError, match=message):
        build()


def test_model_is_told_it_has_seen_no_prices():
    data = search_links.flight_links("Pune", "Delhi", DAY, None, 1, TODAY).for_model()
    assert data["links_shown_to_traveller"] == ["Google Flights", "ixigo"]
    assert "do not state or estimate any" in data["important"]
    assert "https://" not in str(data)  # links go to the card only


# ---------- through the companion ----------


async def test_transport_links_reach_the_traveller_as_a_card(client, llm):
    conversation_id = await new_conversation(client)
    day = (date.today() + timedelta(days=14)).isoformat()
    llm.queue(
        call("transport_search_links", {"mode": "train", "origin": "Pune", "destination": "Indore", "date": day, "travellers": 2}),
        say("Here are the train searches."),
    )

    events = await chat(client, conversation_id, "Trains from Pune to Indore in two weeks for two of us")

    card = next(data for event, data in events if event == "card")
    assert card["type"] == "search_links" and card["kind"] == "train" and card["title"] == "Trains: Pune to Indore"
    assert card["links"][0]["url"].startswith("https://www.ixigo.com/search/result/train/PUNE/INDB/")
    assert "do not state or estimate" in tool_results(llm)[0]["important"]

    llm.queue(call("transport_search_links", {"mode": "bus", "origin": "Pune", "destination": "Pune", "date": day}, "b"), say("Same city."))
    await chat(client, conversation_id, "Bus?")
    assert tool_results(llm)[-1] == {"error": "The origin and destination are the same place."}


async def test_hotel_links_default_to_one_room_per_two_adults(client, llm):
    conversation_id = await new_conversation(client)
    start = date.today() + timedelta(days=20)
    llm.queue(
        call("hotel_search_links", {"city": "Indore", "check_in": start.isoformat(),
                                    "check_out": (start + timedelta(days=2)).isoformat(), "adults": 3}),
        say("Here are the hotel searches."),
    )

    events = await chat(client, conversation_id, "Hotels in Indore")

    card = next(data for event, data in events if event == "card")
    assert card["kind"] == "hotel" and _query(card["links"][1]["url"])["no_rooms"] == "2"


async def test_hotel_links_follow_the_trip_budget(client, llm):
    conversation_id = await new_conversation(client)
    start = date.today() + timedelta(days=20)
    end = start + timedelta(days=2)
    llm.queue(
        call("save_trip_requirements", {"destination": "Indore", "start_date": start.isoformat(),
                                        "end_date": end.isoformat(), "adults": 2, "budget_total": 25000,
                                        "currency": "INR", "interests": ["food"]}),
        say("Noted."),
    )
    await chat(client, conversation_id, "Indore, 3 days, 2 of us, 25000 rupees, food")
    plan = tool_results(llm)[0]["budget_plan"]
    # No starting city, so 20,000 for mid-range fits and comfort (44,400) does not.
    assert plan["level"] == "mid-range" and plan["estimated_total"] == 20000 and plan["fits_budget"] is True

    llm.queue(
        call("hotel_search_links", {"city": "Indore", "check_in": start.isoformat(),
                                    "check_out": end.isoformat(), "adults": 2}, "h"),
        say("Here are hotels within your budget."),
    )
    events = await chat(client, conversation_id, "Find me a hotel")
    card = next(data for event, data in events if event == "card")
    assert _query(card["links"][1]["url"])["nflt"] == "price=INR-0-4000-1"
    assert "mid-range" in tool_results(llm)[-1]["price_limit"]


def test_transport_and_hotel_specialists_are_told_they_see_no_prices():
    transport = build_system_prompt(TODAY, TRANSPORT, set(TRANSPORT.tools))
    assert "Never state or guess departure times" in transport and "{" not in transport
    hotels = build_system_prompt(TODAY, HOTELS, {"hotel_search_links", "compare_hotels", "list_bookings"})
    assert "never name hotels or state prices for them" in hotels and "in-app booking demo" in hotels
