from datetime import UTC, date, datetime, timedelta

import httpx
import pytest

from app.agent.specialists import (
    GENERALIST,
    GUIDE,
    HOTELS,
    TRIP_PLANNER,
    build_system_prompt,
    choose_specialist,
    hand_off_schema,
)
from app.providers.llm.base import LLMError
from app.providers.news.base import NewsError, NewsItem
from app.providers.news.google_news import GoogleNewsProvider, parse_feed
from app.services import conditions_service
from tests.conftest import FakeEvents, FakeLLM, FakeNews, FakeWeather, call, chat, new_conversation, say, tool_results

TODAY = date(2026, 9, 30)
STRIKE = NewsItem(
    "Transport strike called in Indore", "The Example Times", datetime(2026, 9, 29, 8, 0, tzinfo=UTC),
    "https://news.example/strike",
)


def _tool_names(llm_call) -> set[str]:
    return {schema["function"]["name"] for schema in llm_call["tools"] or []}


# ---------- prompts and schemas ----------


def test_each_specialist_gets_only_its_own_instructions():
    guide = build_system_prompt(TODAY, GUIDE, set(GUIDE.tools))
    planner = build_system_prompt(TODAY, TRIP_PLANNER, set(TRIP_PLANNER.tools))
    hotels = build_system_prompt(TODAY, HOTELS, {"compare_hotels", "list_bookings"})
    bookable = build_system_prompt(TODAY, HOTELS, set(HOTELS.tools))

    assert "Wednesday, 30 September 2026" in guide
    assert "## Answering questions about places" in guide and "## Planning a trip" not in guide
    assert "## Planning a trip" in planner and "## Hotels" not in planner and "## Booking" not in planner
    assert "## Hotels" in hotels and "nothing can be booked until" in hotels
    assert "## Booking and cancelling" in bookable and "nothing can be booked until" not in bookable
    # Each is told who else there is, and not about itself.
    assert "`hotels`" in guide and "`trip_planner`" in guide and "`guide`:" not in guide
    assert "you are its hotels specialist" in hotels
    assert len(planner) < len(build_system_prompt(TODAY, GENERALIST))
    for text in (guide, planner, hotels, bookable):
        assert "{" not in text  # no placeholder left unfilled


def test_generalist_has_every_section_and_no_team():
    text = build_system_prompt(TODAY, GENERALIST)
    for heading in ("## Answering questions about places", "## Planning a trip", "## Hotels", "## Booking and cancelling"):
        assert heading in text
    assert "hand_off" not in text and hand_off_schema(GENERALIST) is None


def test_hand_off_offers_only_the_other_specialists():
    schema = hand_off_schema(GUIDE)["function"]
    assert schema["name"] == "hand_off"
    assert schema["parameters"]["properties"]["specialist"]["enum"] == ["trip_planner", "hotels", "transport", "restaurants"]


# ---------- the router ----------


async def test_router_picks_the_named_specialist():
    llm = FakeLLM([say("hotels")])
    assert await choose_specialist(llm, "Compare hotels in Indore", None, None) == "hotels"
    sent = llm.calls[0]
    assert sent["tools"] is None
    assert "- trip_planner:" in sent["messages"][0]["content"]
    assert sent["messages"][1]["content"] == "Traveller's message: Compare hotels in Indore"

    wordy = FakeLLM([say("The right one is `trip_planner`.")])
    assert await choose_specialist(wordy, "Plan three days in Delhi", None, "guide") == "trip_planner"


async def test_router_is_told_who_was_handling_the_conversation():
    llm = FakeLLM([say("trip_planner")])
    await choose_specialist(llm, "yes, go ahead", "Shall I plan around these places?", "trip_planner")
    assert "choose the specialist that was handling it: trip_planner" in llm.calls[0]["messages"][0]["content"]
    assert llm.calls[0]["messages"][1]["content"].startswith("Companion's last message: Shall I plan")


async def test_router_failure_or_nonsense_falls_back_without_blocking_the_turn():
    assert await choose_specialist(FakeLLM([say("I am not sure")]), "hello", None, "hotels") == "hotels"
    assert await choose_specialist(FakeLLM([say("")]), "hello", None, None) == "guide"

    class Broken(FakeLLM):
        async def stream(self, messages, tools=None):
            raise LLMError("down")
            yield

    assert await choose_specialist(Broken(), "hello", None, "trip_planner") == "trip_planner"


# ---------- routed conversations ----------


@pytest.fixture
def multi_agent() -> bool:
    return True


async def test_message_goes_to_the_routed_specialist_with_only_its_tools(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("guide"), say("Rajwada is a Holkar palace."))

    await chat(client, conversation_id, "What is Rajwada?")

    agent_call = llm.calls[1]
    assert _tool_names(agent_call) == set(GUIDE.tools) | {"hand_off"}
    assert "you are its local guide specialist" in agent_call["messages"][0]["content"]
    assert "## Planning a trip" not in agent_call["messages"][0]["content"]


async def test_planner_sees_planning_tools_only_once_the_trip_is_ready(client, llm):
    conversation_id = await new_conversation(client)
    start = date.today() + timedelta(days=40)
    details = {
        "destination": "Delhi", "start_date": start.isoformat(), "end_date": (start + timedelta(days=1)).isoformat(),
        "adults": 2, "budget_level": "budget", "interests": ["history"],
    }
    llm.queue(say("trip_planner"), call("save_trip_requirements", details), say("Here is a shortlist."))

    await chat(client, conversation_id, "Plan two days in Delhi")

    before, after = _tool_names(llm.calls[1]), _tool_names(llm.calls[2])
    assert before == {"save_trip_requirements", "get_travel_guide", "search_place_info", "hand_off"}
    assert after == before | {"optimize_route", "save_itinerary"}
    assert "compare_hotels" not in after


async def test_specialist_can_hand_the_turn_to_another(client, llm):
    conversation_id = await new_conversation(client)
    search = {
        "destination": "Delhi", "check_in": (date.today() + timedelta(days=30)).isoformat(),
        "check_out": (date.today() + timedelta(days=32)).isoformat(), "adults": 2,
    }
    llm.queue(
        say("guide"),  # the router gets it wrong
        call("hand_off", {"specialist": "hotels"}, "h"),
        call("compare_hotels", search, "c"),
        say("Here are the options."),
        say("hotels"),
        say("The cheapest is Peepal Tree Inn."),
    )

    events = await chat(client, conversation_id, "Compare hotels in Delhi")

    assert "compare_hotels" not in _tool_names(llm.calls[1])
    hotels_call = llm.calls[2]
    assert "compare_hotels" in _tool_names(hotels_call) and "search_place_info" not in _tool_names(hotels_call)
    assert "you are its hotels specialist" in hotels_call["messages"][0]["content"]
    assert [data["type"] for event, data in events if event == "card"] == ["hotel_comparison"]

    # The follow-up is routed knowing who held the conversation.
    await chat(client, conversation_id, "Which is cheapest?")
    assert "was handling it: hotels" in llm.calls[4]["messages"][0]["content"]


async def test_a_specialist_cannot_use_another_specialists_tool_or_hand_off_nowhere(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(
        say("guide"),
        call("compare_hotels", {"destination": "Delhi"}, "a"),
        call("hand_off", {"specialist": "pilots"}, "b"),
        call("hand_off", {"specialist": "guide"}, "c"),
        say("I cannot do that."),
    )

    events = await chat(client, conversation_id, "Hotels?")

    results = tool_results(llm)
    assert results[0]["error"].startswith("'compare_hotels' cannot be used yet.")
    assert "not possible" in results[1]["error"] and "not possible" in results[2]["error"]
    assert not [event for event in events if event[0] == "card"]


async def test_hand_offs_are_limited_per_turn(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(
        say("guide"),
        call("hand_off", {"specialist": "hotels"}, "1"),
        call("hand_off", {"specialist": "trip_planner"}, "2"),
        call("hand_off", {"specialist": "guide"}, "3"),
        say("Let me answer directly."),
    )

    await chat(client, conversation_id, "Something")

    assert "hand_off" not in _tool_names(llm.calls[3])  # no longer offered after two
    assert "not possible" in tool_results(llm)[2]["error"]


# ---------- news ----------

FEED = """<?xml version="1.0"?><rss><channel>
<item><title>Older story about traffic - City Paper</title><link>https://news.example/a</link>
<pubDate>Mon, 21 Sep 2026 08:00:00 GMT</pubDate><source url="https://x">City Paper</source></item>
<item><title>Transport strike called in Indore - The Example Times</title><link>https://news.example/b</link>
<pubDate>Tue, 29 Sep 2026 08:00:00 GMT</pubDate><source url="https://y">The Example Times</source></item>
<item><title>No link</title><pubDate>Tue, 29 Sep 2026 08:00:00 GMT</pubDate></item>
</channel></rss>"""


def test_feed_is_parsed_and_the_publication_taken_off_the_title():
    items = parse_feed(FEED)
    assert [(i.title, i.source, i.url) for i in items] == [
        ("Older story about traffic", "City Paper", "https://news.example/a"),
        ("Transport strike called in Indore", "The Example Times", "https://news.example/b"),
    ]
    with pytest.raises(NewsError):
        parse_feed("<not xml")


async def test_google_news_asks_about_disruptions_newest_first_and_caches():
    seen = []

    def handler(request):
        seen.append(request.url.params["q"])
        return httpx.Response(200, text=FEED)

    provider = GoogleNewsProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    items = await provider.disruptions("Indore")
    await provider.disruptions("indore", limit=1)

    assert [item.title for item in items] == ["Transport strike called in Indore", "Older story about traffic"]
    assert len(seen) == 1 and seen[0].startswith('"Indore" (strike OR bandh') and seen[0].endswith("when:7d")

    down = GoogleNewsProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))))
    with pytest.raises(NewsError):
        await down.disruptions("Indore")


async def test_news_is_checked_only_for_trips_that_are_near():
    news = FakeNews()
    news.items = [STRIKE]

    async def conditions(start, end):
        return await conditions_service.get_conditions(FakeWeather(), FakeEvents(), "Indore", start, end, TODAY, news=news)

    near = await conditions(date(2026, 10, 1), date(2026, 10, 3))
    far = await conditions(date(2026, 12, 20), date(2026, 12, 22))

    assert near.news == [STRIKE] and far.news is None and news.asked == ["Delhi"]  # the fake city's name
    view = conditions_service.for_model(near)
    assert view["news"] == ["2026-09-29 The Example Times: Transport strike called in Indore"]
    assert "https://" not in str(view["news"])  # links go to the card, not the model
    assert conditions_service.for_card(near)["news"][0]["url"] == "https://news.example/strike"
    assert "news" not in conditions_service.for_model(far) and conditions_service.for_card(far)["news"] is None


async def test_news_failure_is_reported_as_not_checked():
    news = FakeNews()
    news.error = NewsError("The news source could not be reached.")
    found = await conditions_service.get_conditions(
        FakeWeather(), FakeEvents(), "Indore", date(2026, 10, 1), date(2026, 10, 3), TODAY, news=news
    )
    assert found.news is None
    assert found.problems == ["Local news could not be checked: The news source could not be reached."]


async def test_guide_answers_what_is_happening_with_headlines_and_links(client, llm, news):
    news.items = [STRIKE]
    conversation_id = await new_conversation(client)
    llm.queue(say("guide"), call("get_local_news", {"place": "Indore"}), say("A transport strike is reported."))

    events = await chat(client, conversation_id, "Is anything happening in Indore this week?")

    card = next(data for event, data in events if event == "card")
    assert card["type"] == "news" and card["place"] == "Indore"
    assert card["items"] == [
        {"headline": STRIKE.title, "source": "The Example Times", "date": "2026-09-29", "url": STRIKE.url}
    ]
    assert tool_results(llm)[0]["news"] == ["2026-09-29 The Example Times: Transport strike called in Indore"]

    news.items = []
    llm.queue(say("guide"), call("get_local_news", {"place": "Indore"}, "n2"), say("Nothing reported."))
    quiet = await chat(client, conversation_id, "And now?")
    assert not [e for e in quiet if e[0] == "card"] and "not exhaustive" in tool_results(llm)[-1]["note"]

    news.error = NewsError("The news source could not be reached.")
    llm.queue(say("guide"), call("get_local_news", {"place": "Indore"}, "n3"), say("I could not check."))
    await chat(client, conversation_id, "Again?")
    assert "do not describe current events from memory" in tool_results(llm)[-1]["error"]
