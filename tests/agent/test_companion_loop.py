import json

from pydantic import BaseModel

from app.agent.companion import STEP_LIMIT_MESSAGE, CompanionAgent
from app.agent.tools import Tool, ToolContext, ToolFailure, ToolRegistry, ToolResult
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


async def test_loop_stops_at_step_limit():
    llm = FakeLLM([call("echo", {"text": "again"}) for _ in range(3)])

    events, messages = await _run(llm, max_steps=3)

    assert len(llm.calls) == 3
    assert messages[-1] == {"role": "assistant", "content": STEP_LIMIT_MESSAGE}
    assert {"type": "text", "delta": STEP_LIMIT_MESSAGE} in events
