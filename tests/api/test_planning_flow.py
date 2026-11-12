from datetime import date, timedelta

from app.providers.knowledge.base import KnowledgeError
from tests.conftest import call, chat, new_conversation, say, tool_results

START = date.today() + timedelta(days=30)
DAYS = [(START + timedelta(days=offset)).isoformat() for offset in range(2)]
RED_FORT_URL = "https://en.wikipedia.org/wiki/Red_Fort"


def _itinerary(source_url: str = RED_FORT_URL, days: list[str] = DAYS) -> dict:
    return {
        "summary": "Old Delhi first, then the south.",
        "days": [
            {
                "date": day,
                "theme": f"Day {index + 1}",
                "items": [
                    {
                        "time_of_day": "morning",
                        "place": "Red Fort" if index == 0 else "Qutub Minar",
                        "activity": "Walk the ramparts.",
                        "why_visit": "Built by Shah Jahan in 1639.",
                        "source_url": source_url if index == 0 else None,
                    }
                ],
            }
            for index, day in enumerate(days)
        ],
        "tips": ["Carry water."],
    }


async def test_companion_is_told_what_to_ask_before_planning(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(
        call("save_trip_requirements", {"destination": "Delhi", "start_date": DAYS[0], "end_date": DAYS[1]}),
        say("How many of you are travelling, what is your budget, and what are you interested in?"),
    )

    events = await chat(client, conversation_id, "I am visiting Delhi, plan a trip for me")

    result = tool_results(llm)[0]
    assert result["ready_to_plan"] is False
    assert result["missing_before_planning"] == ["number of travellers", "budget", "interests"]
    assert ("status", {"text": "Noting your trip details…"}) in events
    assert not [event for event in events if event[0] == "card"]


async def test_full_planning_turn_saves_and_shows_itinerary(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(
        call(
            "save_trip_requirements",
            {
                "destination": "Delhi",
                "start_date": DAYS[0],
                "end_date": DAYS[1],
                "adults": 2,
                "budget_level": "mid-range",
                "interests": ["history"],
                "must_visit": ["Red Fort"],
            },
        ),
        call("get_travel_guide", {"destination": "Delhi"}),
        call("search_place_info", {"queries": ["Red Fort Delhi"]}),
        call("save_itinerary", _itinerary()),
        say("Your two days are planned."),
    )

    events = await chat(client, conversation_id, "Plan it")

    cards = [data for event, data in events if event == "card"]
    assert len(cards) == 1
    card = cards[0]
    assert card["type"] == "itinerary" and card["destination"] == "Delhi" and card["version"] == 1
    assert [day["date"] for day in card["days"]] == DAYS
    assert card["days"][0]["items"][0]["source_url"] == RED_FORT_URL
    assert tool_results(llm)[-1]["saved"] is True

    # The card survives a reload, between the user's message and the closing reply.
    stored = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert [item["role"] for item in stored] == ["user", "card", "assistant"]
    assert stored[1]["card"] == card


async def test_itinerary_with_invented_source_or_wrong_dates_is_rejected(client, llm):
    conversation_id = await new_conversation(client)
    requirements = {
        "destination": "Delhi",
        "start_date": DAYS[0],
        "end_date": DAYS[1],
        "adults": 2,
        "budget_level": "budget",
        "interests": ["history"],
    }
    llm.queue(
        call("save_trip_requirements", requirements),
        call("save_itinerary", _itinerary(source_url="https://example.com/invented")),
        call("save_itinerary", _itinerary(source_url=None, days=DAYS[:1])),
        say("I could not save the plan."),
    )

    events = await chat(client, conversation_id, "Plan it")

    results = tool_results(llm)
    assert "was not returned by a lookup" in results[1]["error"]
    # One day of a two-day trip is kept as a part, and the model is told what is missing.
    assert results[2]["saved_days"] == DAYS[:1] and results[2]["remaining_dates"] == DAYS[1:]
    assert not [event for event in events if event[0] == "card"]


async def test_save_itinerary_before_requirements_fails(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("save_itinerary", _itinerary()), say("I need your trip details first."))

    await chat(client, conversation_id, "Plan it")

    assert "save_trip_requirements first" in tool_results(llm)[0]["error"]


async def test_place_lookup_returns_sourced_facts(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("search_place_info", {"queries": ["Red Fort"]}), say("Shah Jahan built it in 1639."))

    await chat(client, conversation_id, "Tell me about the Red Fort")

    result = tool_results(llm)[0]["results"][0]
    assert result["url"] == RED_FORT_URL and result["source"] == "Wikipedia"
    assert "Shah Jahan" in result["summary"]


async def test_lookup_failures_are_reported_to_the_model_not_hidden(client, llm, knowledge):
    conversation_id = await new_conversation(client)
    llm.queue(call("search_place_info", {"queries": ["Atlantis"]}), say("I could not find a reliable source."))
    await chat(client, conversation_id, "Tell me about Atlantis")
    assert tool_results(llm)[0]["results"] == []
    assert "rather than answering from memory" in tool_results(llm)[0]["note"]

    knowledge.error = KnowledgeError("The reference source did not respond.")
    llm.queue(call("get_travel_guide", {"destination": "Delhi"}, "call_2"), say("The guide is unavailable."))
    await chat(client, conversation_id, "And a guide to Delhi?")
    assert tool_results(llm)[-1] == {"error": "The reference source did not respond. No guide was retrieved."}


async def test_old_tool_results_are_replayed_as_recaps_in_later_turns(client, llm, knowledge):
    knowledge.guide.sections["See"] = "Sights. " * 500
    conversation_id = await new_conversation(client)
    llm.queue(call("get_travel_guide", {"destination": "Delhi"}), say("Here is Delhi."), say("Sure."))

    await chat(client, conversation_id, "Guide to Delhi")
    full = next(m for m in llm.calls[1]["messages"] if m["role"] == "tool")
    await chat(client, conversation_id, "Thanks")
    replayed = next(m for m in llm.calls[2]["messages"] if m["role"] == "tool")

    assert len(full["content"]) > 3000
    assert replayed["content"].startswith("Read the Wikivoyage guide") and len(replayed["content"]) < 200
