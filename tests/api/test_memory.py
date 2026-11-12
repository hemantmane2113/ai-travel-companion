"""What the companion remembers between messages.

Replays a real chat that went wrong: one long turn used up the history budget, the
trimmed history came out empty, and the next message was answered with no idea of
the trip ("Which city are you planning to visit?").
"""

from datetime import date, timedelta

import pytest

from tests.conftest import call, chat, new_conversation, say

DAY = (date.today() + timedelta(days=10)).isoformat()
TRIP = {
    "destination": "Mumbai", "start_date": DAY, "end_date": DAY, "adults": 2,
    "budget_total": 1000, "currency": "INR", "interests": ["mixed places"], "pace": "moderate",
}


def _system(request) -> str:
    return request["messages"][0]["content"]


async def test_the_saved_trip_is_in_every_prompt(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", TRIP), say("Noted."))
    await chat(client, conversation_id, "One day in Mumbai for two, 1000 rupees")

    llm.queue(say("Here are some free places."))
    await chat(client, conversation_id, "suggest the places which would be in our budget only")

    prompt = _system(llm.calls[-1])
    assert "## Current trip" in prompt
    assert "- Destination: Mumbai" in prompt and "- Travellers: 2 adults" in prompt
    assert "- Budget: INR 1,000 in total" in prompt
    # One day for two at the cheapest level: ₹900 food + ₹300 transport + ₹200 sights.
    assert "budget level, about ₹1,400, ₹400 OVER budget" in prompt
    assert "- Itinerary: not saved yet" in prompt


async def test_a_turn_too_big_for_the_budget_never_empties_the_history(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", TRIP), say("Noted."))
    await chat(client, conversation_id, "One day in Mumbai for two, 1000 rupees")
    llm.queue(say("A very long answer. " * 500))  # about 10,000 characters: over the budget on its own
    await chat(client, conversation_id, "1 day, i want to look mix of activities")

    llm.queue(say("Here are some free places."))
    await chat(client, conversation_id, "suggest the places which would be in our budget only")

    sent = llm.calls[-1]["messages"]
    users = [m["content"] for m in sent if m["role"] == "user"]
    # The oversized turn is kept whole; only the older turn is dropped.
    assert users == ["1 day, i want to look mix of activities", "suggest the places which would be in our budget only"]
    assert "- Destination: Mumbai" in _system(llm.calls[-1])


async def test_earlier_tool_results_come_back_as_recaps(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", TRIP), say("Noted."))
    await chat(client, conversation_id, "One day in Mumbai for two, 1000 rupees")
    llm.queue(say("Sure."))
    await chat(client, conversation_id, "Thanks")

    replayed = next(m for m in llm.calls[-1]["messages"] if m["role"] == "tool")
    assert replayed["content"].startswith("Saved the trip details; the current trip note")
    assert "budget_plan" not in replayed["content"]


async def test_a_long_chat_keeps_its_title(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("A very long answer. " * 500))
    await chat(client, conversation_id, "Plan Mumbai")
    llm.queue(say("Sure."))
    await chat(client, conversation_id, "Something else entirely")

    conversations = (await client.get("/api/conversations")).json()
    assert next(c for c in conversations if c["id"] == conversation_id)["title"] == "Plan Mumbai"


def test_long_titles_are_cut_at_a_whole_word():
    from app.api.chat import _title

    assert _title("Plan a 3-day trip to Jaipur next month for two of us. We love history and food.") == (
        "Plan a 3-day trip to Jaipur next month for two of us. We…"
    )
    assert _title("  Short   question  ") == "Short question"


@pytest.mark.parametrize("multi_agent", [True])
async def test_the_router_sees_the_trip_in_progress(client, llm, multi_agent):
    conversation_id = await new_conversation(client)
    llm.queue(say("trip_planner"), call("save_trip_requirements", TRIP), say("Noted."))
    await chat(client, conversation_id, "One day in Mumbai for two, 1000 rupees")
    llm.queue(say("trip_planner"), say("Here are some free places."))
    await chat(client, conversation_id, "suggest the places which would be in our budget only")

    routing = [c for c in llm.calls if _system(c).startswith("Decide which specialist")]
    assert "## Current trip" not in routing[0]["messages"][1]["content"]  # nothing saved yet
    assert "- Destination: Mumbai" in routing[-1]["messages"][1]["content"]
    assert "belongs to trip_planner" in _system(routing[-1])
