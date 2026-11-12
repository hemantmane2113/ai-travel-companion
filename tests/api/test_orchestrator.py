import json
from datetime import date, timedelta

import pytest

from app.agent.orchestrator import MAX_STEPS, Step, parse_plan, plan_steps, step_directive
from app.agent.specialists import MULTI, choose_specialist
from app.config import Settings
from app.main import build_orchestrator_llm
from app.providers.llm.base import LLMError
from app.providers.llm.fallback import FallbackLLMProvider
from app.providers.llm.openai_compatible import OpenAICompatibleProvider
from tests.conftest import FakeLLM, call, chat, new_conversation, say, tool_results

DAY = (date.today() + timedelta(days=20)).isoformat()


def _plan(*steps: tuple[str, str]) -> str:
    return json.dumps({"steps": [{"specialist": s, "task": t} for s, t in steps]})


# ---------- reading the plan ----------


def test_plan_is_read_from_json_even_inside_prose():
    text = "Sure! Here is the plan:\n```json\n" + _plan(("trip_planner", "Plan 3 days in Indore"), ("hotels", "Hotels near the stops")) + "\n```"
    assert parse_plan(text) == [Step("trip_planner", "Plan 3 days in Indore"), Step("hotels", "Hotels near the stops")]


def test_unknown_repeated_and_excess_steps_are_dropped():
    text = _plan(
        ("pilots", "Fly the plane"),
        ("Hotels", "Find hotels"),
        ("hotels", "Find more hotels"),
        ("transport", "Trains"),
        ("guide", "Weather"),
        ("restaurants", "Dinner"),
        ("trip_planner", "Plan"),
    )
    steps = parse_plan(text)
    assert [s.specialist for s in steps] == ["hotels", "transport", "guide", "restaurants"]
    assert len(steps) == MAX_STEPS


@pytest.mark.parametrize("text", ["no json here", "{not json}", '{"steps": "hotels"}', '{"steps": [{"specialist": "hotels"}]}'])
def test_unusable_answers_give_no_plan(text):
    assert parse_plan(text) == []


async def test_planning_failure_gives_no_plan_instead_of_an_error():
    class Broken(FakeLLM):
        async def stream(self, messages, tools=None):
            raise LLMError("down")
            yield

    assert await plan_steps(Broken(), "Plan and book", None) == []


async def test_planner_is_shown_the_specialists_and_the_message():
    llm = FakeLLM([say(_plan(("guide", "Weather in Goa")))])
    await plan_steps(llm, "Weather in Goa and hotels", "Hello!")
    system, user = llm.calls[0]["messages"]
    assert "- transport:" in system["content"] and "At most 4 steps" in system["content"]
    assert user["content"].startswith("Companion's last message: Hello!") and llm.calls[0]["tools"] is None


def test_directives_tell_each_specialist_its_part_with_the_travellers_words():
    message = "Plan 3 days in Indore for me and 2 friends and find hotels."
    first = step_directive(Step("trip_planner", "Plan 3 days in Indore."), 1, 3, message)
    later = step_directive(Step("hotels", "Hotels near the stops"), 2, 3, message)
    assert first.startswith(f'The traveller wrote: "{message}"')
    assert "You handle part 1 only: Plan 3 days in Indore." in first
    assert "Earlier parts" not in first and "Earlier parts have been answered above" in later
    assert "do not hand off" in later and "Do not answer the other parts" in later


# ---------- the router's choice ----------


async def test_router_can_answer_multi_and_only_when_allowed():
    assert await choose_specialist(FakeLLM([say("multi")]), "Plan and book", None, None) == MULTI
    # "multiple" is not the word "multi".
    assert await choose_specialist(FakeLLM([say("multiple hotels")]), "x", None, None) == "hotels"

    llm = FakeLLM([say("multi")])
    assert await choose_specialist(llm, "Plan and book", None, "guide", allow_multi=False) == "guide"
    assert "- multi:" not in llm.calls[0]["messages"][0]["content"]


# ---------- building the orchestrator's model ----------


def test_orchestrator_model_is_configurable_and_falls_back_to_the_main_model():
    main = FakeLLM()
    settings = Settings(_env_file=None, session_secret="s")
    built = build_orchestrator_llm(settings, main)
    assert isinstance(built, FallbackLLMProvider)
    own, fallback = built._providers
    assert isinstance(own, OpenAICompatibleProvider) and own.model == "llama3.2:3b"
    assert str(own._client.base_url) == "http://localhost:11434/v1/" and fallback is main

    openai_settings = Settings(
        _env_file=None, session_secret="s", orchestrator_base_url="https://api.openai.com/v1",
        orchestrator_api_key="k", orchestrator_model="some-model",
    )
    assert build_orchestrator_llm(openai_settings, main)._providers[0].model == "some-model"
    assert build_orchestrator_llm(Settings(_env_file=None, session_secret="s", orchestrator_enabled=False), main) is None
    assert build_orchestrator_llm(settings, None) is None


# ---------- through the companion ----------


@pytest.fixture
def multi_agent() -> bool:
    return True


async def test_multi_part_message_runs_each_specialist_in_order(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(
        say("multi"),
        say(_plan(("guide", "Weather in Indore on " + DAY), ("transport", "Trains Pune to Indore on " + DAY))),
        say("Indore will be warm."),  # the guide's part
        call("transport_search_links", {"mode": "train", "origin": "Pune", "destination": "Indore", "date": DAY}),
        say("Here are the train searches."),
    )

    events = await chat(client, conversation_id, f"What is the weather in Indore on {DAY}, and find trains from Pune")

    statuses = [data["text"] for event, data in events if event == "status"]
    assert statuses[:2] == ["Working out the steps…", "Part 1 of 2: local guide…"]
    assert "Part 2 of 2: transport…" in statuses
    assert [data["type"] for event, data in events if event == "card"] == ["search_links"]

    guide_call, transport_call = llm.calls[2], llm.calls[3]
    assert "you are its local guide specialist" in guide_call["messages"][0]["content"]
    # Each specialist is given only its own part as the request, not the whole message.
    request = guide_call["messages"][-1]
    assert request["role"] == "user" and "You handle part 1 only: Weather in Indore" in request["content"]
    # The traveller's words are there, but only inside the part request, marked as context.
    assert sum("find trains from Pune" in m["content"] for m in guide_call["messages"]) == 1
    assert request["content"].startswith("The traveller wrote:")
    assert "hand_off" not in {s["function"]["name"] for s in guide_call["tools"]}
    assert "you are its transport specialist" in transport_call["messages"][0]["content"]
    # The transport part sees the guide's answer and its own instruction.
    sent = [(m["role"], m["content"][:30]) for m in transport_call["messages"][1:]]
    assert ("assistant", "Indore will be warm.") in sent
    assert "You handle part 2 only: Trains Pune to Indore" in transport_call["messages"][-1]["content"]

    # The traveller sees the two answers, not the hidden instructions.
    visible = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert [m["role"] for m in visible] == ["user", "assistant", "card", "assistant"]

    # A follow-up goes back to whoever handled the last part.
    llm.queue(say("transport"), say("Sure."))
    await chat(client, conversation_id, "Thanks")
    assert "was handling it: transport" in llm.calls[-2]["messages"][0]["content"]


async def test_one_step_plan_is_handled_like_a_routed_message(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("multi"), say(_plan(("hotels", "Hotels in Goa"))), say("Which dates?"))

    events = await chat(client, conversation_id, "Hotels in Goa")

    hotels_call = llm.calls[2]
    assert "you are its hotels specialist" in hotels_call["messages"][0]["content"]
    assert hotels_call["messages"][-1] == {"role": "user", "content": "Hotels in Goa"}  # no part instruction
    assert "Part 1" not in str([data for event, data in events if event == "status"])


async def test_unusable_plan_falls_back_to_a_single_specialist(client, llm):
    conversation_id = await new_conversation(client)
    llm.queue(say("multi"), say("I cannot make a plan"), say("Here is what I know."))

    await chat(client, conversation_id, "Do several things")

    assert "you are its local guide specialist" in llm.calls[2]["messages"][0]["content"]
