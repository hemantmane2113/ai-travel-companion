from datetime import date, timedelta

from app.providers.events.base import Event
from app.providers.maps.base import MapsError
from tests.conftest import call, chat, new_conversation, say, tool_results

START = date.today() + timedelta(days=30)
DAYS = [(START + timedelta(days=offset)).isoformat() for offset in range(2)]
REQUIREMENTS = {
    "destination": "Delhi",
    "start_date": DAYS[0],
    "end_date": DAYS[1],
    "adults": 2,
    "budget_level": "mid-range",
    "interests": ["history"],
    "pace": "packed",
}


def _itinerary(first_day: list[str], second_day: list[str]) -> dict:
    def stops(places):
        return [{"time_of_day": "morning", "place": place, "activity": "Visit."} for place in places]

    return {
        "summary": "Two days in Delhi.",
        "days": [
            {"date": DAYS[0], "theme": "North", "items": stops(first_day)},
            {"date": DAYS[1], "theme": "South", "items": stops(second_day)},
        ],
    }


async def test_saving_trip_details_returns_weather_holidays_and_alerts(client, llm, events):
    events.listed = [Event(START, "Test Festival", "public holiday", "test")]
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", REQUIREMENTS), say("Here is what to expect."))

    await chat(client, conversation_id, "Plan Delhi")

    conditions = tool_results(llm)[0]["conditions"]
    assert conditions["place"] == "Delhi, Delhi, India"
    assert conditions["weather"][0].startswith(f"{DAYS[0]}: Clear, 22–33°C")
    assert conditions["events"] == [f"{DAYS[0]}: Test Festival (public holiday)"]
    assert len(conditions["alerts"]) == 1 and "Test Festival is a public holiday" in conditions["alerts"][0]


async def test_conditions_are_not_looked_up_before_place_and_dates_are_known(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", {"destination": "Delhi"}), say("When are you going?"))
    await chat(client, conversation_id, "Plan Delhi")
    assert "conditions" not in tool_results(llm)[0]


async def test_get_trip_conditions_answers_a_direct_question(client, llm, weather):
    conversation_id = await new_conversation(client)
    arguments = {"destination": "Delhi", "start_date": DAYS[0], "end_date": DAYS[1]}
    llm.queue(call("get_trip_conditions", arguments), say("Clear and warm."))
    await chat(client, conversation_id, "What is the weather in Delhi then?")
    assert len(tool_results(llm)[0]["weather"]) == 2

    weather.city = None
    llm.queue(call("get_trip_conditions", {**arguments, "destination": "Nowhere"}, "b"), say("I could not find it."))
    await chat(client, conversation_id, "And Nowhere?")
    assert "Could not find a place called 'Nowhere'" in tool_results(llm)[-1]["error"]


async def test_optimize_route_returns_shortest_order_grouped_by_day(client, llm):
    conversation_id = await new_conversation(client)
    places = ["India Gate", "Qutub Minar", "Jama Masjid", "Atlantis", "Humayun's Tomb", "Red Fort"]
    llm.queue(
        call("save_trip_requirements", REQUIREMENTS),
        call("optimize_route", {"places": places}, "r"),
        say("Here is the route."),
    )

    await chat(client, conversation_id, "Plan Delhi")

    route = tool_results(llm)[-1]
    north, south = ["Jama Masjid", "Red Fort", "India Gate"], ["Humayun's Tomb", "Qutub Minar"]
    assert [day["stops_in_order"] for day in route["days"]] in (
        [north, south],
        [south[::-1] + north[::-1][:1], north[::-1][1:]],
    )
    assert route["days"][0]["km"] > 0 and route["distance_source"] == "Fake roads"
    assert route["could_not_locate"] == ["Atlantis"]


async def test_optimize_route_needs_a_destination_and_reports_map_failures(client, llm, geocoder):
    conversation_id = await new_conversation(client)
    llm.queue(call("optimize_route", {"places": ["Red Fort", "India Gate"]}), say("I need the destination."))
    await chat(client, conversation_id, "Route")
    assert "save_trip_requirements first" in tool_results(llm)[0]["error"]

    geocoder.error = MapsError("The map service could not locate places right now.")
    llm.queue(
        call("save_trip_requirements", REQUIREMENTS, "a"),
        call("optimize_route", {"places": ["Red Fort", "India Gate"]}, "b"),
        say("The map is unavailable."),
    )
    await chat(client, conversation_id, "Plan Delhi")
    assert "No route was computed" in tool_results(llm)[-1]["error"]


async def test_itinerary_card_carries_conditions_and_route_per_day(client, llm, events):
    events.listed = [Event(START + timedelta(days=1), "Test Festival", "public holiday", "test")]
    conversation_id = await new_conversation(client)
    llm.queue(
        call("save_trip_requirements", REQUIREMENTS),
        call("save_itinerary", _itinerary(["Jama Masjid", "Red Fort", "India Gate"], ["Humayun's Tomb", "Qutub Minar"]), "s"),
        say("Saved."),
    )

    chat_events = await chat(client, conversation_id, "Plan Delhi")

    card = next(data for event, data in chat_events if event == "card")
    assert card["conditions"]["days"][DAYS[0]]["weather"]["summary"] == "Clear"
    assert card["conditions"]["days"][DAYS[1]]["events"] == [{"name": "Test Festival", "kind": "public holiday"}]
    assert card["conditions"]["events_checked"] is True and len(card["conditions"]["alerts"]) == 1
    assert card["conditions"]["days"][DAYS[0]]["air"] == {"peak_aqi": 80, "category": "Moderate", "pm25": 30.0}
    first = card["days"][0]["route"]
    assert [leg["to"] for leg in first["legs"]] == ["Red Fort", "India Gate"]
    assert first["total_km"] > 0 and first["maps_url"].startswith("https://www.google.com/maps/dir/")
    assert card["route_source"] == "Fake roads"

    result = tool_results(llm)[-1]
    assert result["saved"] is True and len(result["alerts"]) == 1
    assert "route_warning" not in result


async def test_wasteful_stop_order_is_flagged_to_the_model(client, llm):
    conversation_id = await new_conversation(client)
    zigzag = ["Jama Masjid", "Qutub Minar", "Red Fort", "Humayun's Tomb"]
    llm.queue(
        call("save_trip_requirements", REQUIREMENTS),
        call("save_itinerary", _itinerary(zigzag, ["India Gate"]), "s"),
        say("Saved."),
    )

    await chat(client, conversation_id, "Plan Delhi")

    result = tool_results(llm)[-1]
    assert result["saved"] is True and "longer order than necessary" in result["route_warning"]
    assert result["wasteful_days"][0]["day"] == 1
    assert result["wasteful_days"][0]["better_order"][0] in ("Jama Masjid", "Qutub Minar")


async def test_map_failure_does_not_lose_the_saved_itinerary(client, llm, geocoder):
    geocoder.error = MapsError("The map service could not locate places right now.")
    conversation_id = await new_conversation(client)
    llm.queue(
        call("save_trip_requirements", REQUIREMENTS),
        call("save_itinerary", _itinerary(["Red Fort"], ["Qutub Minar"]), "s"),
        say("Saved, without distances."),
    )

    chat_events = await chat(client, conversation_id, "Plan Delhi")

    card = next(data for event, data in chat_events if event == "card")
    assert "route" not in card["days"][0] and card["conditions"]["days"]
    result = tool_results(llm)[-1]
    assert result["saved"] is True and "could not locate places" in result["route_unavailable"]
