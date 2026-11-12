import json

import pytest
from pydantic import BaseModel

from app.agent.companion import STEP_LIMIT_MESSAGE, CompanionAgent
from app.providers.llm.base import LLMToolCallError
from app.agent.tools import Tool, ToolContext, ToolFailure, ToolRegistry, ToolResult, tool_parameters
from tests.conftest import FakeLLM, call, say


class EchoArgs(BaseModel):
    text: str


async def _echo(ctx: ToolContext, args: EchoArgs) -> ToolResult:
    if args.text == "boom":
        raise ToolFailure("Nothing found for boom.")
    return ToolResult({"echo": args.text}, card={"type": "echo", "text": args.text})


def _registry() -> ToolRegistry:
    return ToolRegistry([Tool("echo", "Echo text back.", EchoArgs, _echo, status="Echoing…")])


async def _run(llm: FakeLLM, max_steps: int = 8):
    agent = CompanionAgent(llm, _registry(), max_steps=max_steps)
    ctx = ToolContext(db=None, user_id=1, conversation_id=1)
    messages = [{"role": "user", "content": "hi"}]
    events = [event async for event in agent.run(messages, ctx)]
    return events, messages


async def test_tool_result_is_fed_back_and_card_emitted():
    llm = FakeLLM([call("echo", {"text": "hello"}), say("Done.")])

    events, messages = await _run(llm)

    assert [m["role"] for m in messages] == ["user", "assistant", "tool", "assistant"]
    assert json.loads(messages[2]["content"]) == {"echo": "hello"}
    assert messages[2]["tool_call_id"] == "call_1"
    cards = [e["card"] for e in events if e["type"] == "message" and e["card"]]
    assert cards == [{"type": "echo", "text": "hello"}]
    assert {"type": "status", "text": "Echoing…"} in events
    # The second model call saw the tool result.
    assert llm.calls[1]["messages"][-1]["role"] == "tool"


async def test_invalid_arguments_and_tool_failures_return_errors_to_the_model():
    llm = FakeLLM(
        [
            call("echo", {"wrong": 1}, "a"),
            call("echo", {"text": "boom"}, "b"),
            call("missing_tool", {}, "c"),
            say("Sorry, that did not work."),
        ]
    )

    _, messages = await _run(llm)

    results = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
    assert results[0]["error"] == "Invalid arguments."
    assert results[1] == {"error": "Nothing found for boom."}
    assert results[2] == {"error": "Unknown tool 'missing_tool'."}


async def test_malformed_tool_call_is_retried_with_the_reason_then_gives_up():
    class Flaky(FakeLLM):
        failures = 1

        async def stream(self, messages, tools=None):
            if self.failures:
                self.failures -= 1
                self.calls.append({"messages": [dict(m) for m in messages], "tools": tools})
                raise LLMToolCallError("parameters did not match schema")
            async for chunk in super().stream(messages, tools):
                yield chunk

    llm = Flaky([say("Recovered.")])
    events, messages = await _run(llm)

    assert messages[-1] == {"role": "assistant", "content": "Recovered."}
    assert "parameters did not match schema" in llm.calls[1]["messages"][-1]["content"]
    # The correction note is scaffolding, not a transcript entry to store.
    assert [e["message"]["role"] for e in events if e["type"] == "message"] == ["assistant"]

    always = Flaky()
    always.failures = 5
    with pytest.raises(LLMToolCallError):
        await _run(always)
    assert len(always.calls) == 3


async def test_only_selected_tools_are_offered_and_others_are_refused():
    llm = FakeLLM([call("echo", {"text": "hello"}), say("Not possible yet.")])

    async def nothing_available(ctx):
        return set()

    agent = CompanionAgent(llm, _registry(), select_tools=nothing_available)
    messages = [{"role": "user", "content": "hi"}]
    events = [e async for e in agent.run(messages, ToolContext(db=None, user_id=1, conversation_id=1))]

    assert llm.calls[0]["tools"] is None
    assert json.loads(messages[2]["content"]) == {"error": "'echo' cannot be used yet."}
    assert not [e for e in events if e["type"] == "message" and e["card"]]
    assert "nothing can be booked until" in llm.calls[0]["messages"][0]["content"]


async def test_reference_results_are_shortened_once_the_model_has_used_them():
    async def _lookup(ctx, args):
        return ToolResult({"text": "x" * 2000})

    registry = ToolRegistry(
        [Tool("lookup", "Look up.", EchoArgs, _lookup, status="…", bulky_reference=True)]
    )
    llm = FakeLLM([call("lookup", {"text": "a"}, "1"), call("lookup", {"text": "b"}, "2"), say("Done.")])
    agent = CompanionAgent(llm, registry, consumed_result_chars=100)
    messages = [{"role": "user", "content": "hi"}]
    [e async for e in agent.run(messages, ToolContext(db=None, user_id=1, conversation_id=1))]

    second_call, third_call = llm.calls[1]["messages"], llm.calls[2]["messages"]
    # Fresh results arrive whole; the step before last is cut down.
    assert len(second_call[-1]["content"]) > 2000
    assert third_call[-3]["content"].endswith("[truncated]") and len(third_call[-3]["content"]) < 130
    assert len(third_call[-1]["content"]) > 2000
    # What is stored keeps the full text.
    assert all(len(m["content"]) > 2000 for m in messages if m["role"] == "tool")


def test_no_tool_uses_the_time_format_that_providers_reject():
    # Groq validates "format": "time" as RFC 3339, which needs a timezone; models send "19:00".
    from app.agent import travel_tools

    registry = travel_tools.build_tools(travel_tools.Providers(*[None] * 9))
    assert '"format": "time"' not in json.dumps(registry.schemas())
    table = next(s for s in registry.schemas() if s["function"]["name"] == "prepare_table_booking")
    assert table["function"]["parameters"]["properties"]["time"]["pattern"] == r"^([01]\d|2[0-3]):[0-5]\d$"


def test_tool_schemas_spell_out_nested_objects():
    from app.schemas.trip import SaveItineraryArgs

    schema = tool_parameters(SaveItineraryArgs)

    text = json.dumps(schema)
    assert "$ref" not in text and "$defs" not in text and '"title"' not in text
    day = schema["properties"]["days"]["items"]
    assert set(day["required"]) == {"date", "theme", "items"}
    stop = day["properties"]["items"]["items"]
    assert set(stop["properties"]) == {"time_of_day", "place", "activity", "why_visit", "source_url"}


async def test_loop_stops_at_step_limit():
    llm = FakeLLM([call("echo", {"text": "again"}) for _ in range(3)])

    events, messages = await _run(llm, max_steps=3)

    assert len(llm.calls) == 3
    assert messages[-1] == {"role": "assistant", "content": STEP_LIMIT_MESSAGE}
    assert {"type": "text", "delta": STEP_LIMIT_MESSAGE} in events
