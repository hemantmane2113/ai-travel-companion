import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from app.agent.specialists import (
    GENERALIST,
    HAND_OFF,
    SPECIALISTS,
    Specialist,
    build_system_prompt,
    hand_off_schema,
)
from app.agent.tools import ToolContext, ToolRegistry, ToolResult
from app.providers.llm.base import Completion, LLMProvider, LLMToolCallError, Notice, TextDelta

logger = logging.getLogger(__name__)

MAX_MALFORMED_CALLS = 2
MAX_HAND_OFFS = 2

STEP_LIMIT_MESSAGE = (
    "I could not finish that in a reasonable number of steps. "
    "Tell me which part to continue with and I will pick it up from there."
)

SelectTools = Callable[[ToolContext], Awaitable[set[str]]]


class CompanionAgent:
    """Tool-calling loop. It decides and talks; the tools do the work.

    A turn is run by one specialist, which may hand it to another. run() yields
    events for the caller to stream and persist:
      {"type": "text", "delta": str}                 assistant text as it arrives
      {"type": "status", "text": str}                a tool started
      {"type": "message", "message": dict, "card": dict | None}
                                                     a transcript entry to store
      {"type": "specialist", "name": str}            who holds the turn now

    Every model call is kept as small as it can be, because the provider limits
    tokens per minute: only the current specialist's instructions and the tools
    usable right now are sent, and reference text from earlier steps is cut down
    once the model has acted on it.
    """

    def __init__(
        self,
        llm: LLMProvider,
        tools: ToolRegistry,
        max_steps: int = 8,
        select_tools: SelectTools | None = None,
        consumed_result_chars: int = 700,
    ):
        self._llm = llm
        self._tools = tools
        self._max_steps = max_steps
        self._select_tools = select_tools
        self._consumed_result_chars = consumed_result_chars

    def _for_model(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Copy of the transcript with already-used reference results shortened.

        Results of the most recent tool step are left whole: the model has not
        answered from them yet.
        """
        last_step = max(
            (index for index, message in enumerate(messages) if message.get("tool_calls")), default=len(messages)
        )
        compact = []
        for index, message in enumerate(messages):
            if (
                index < last_step
                and message["role"] == "tool"
                and self._tools.is_bulky_reference(message["name"])
                and len(message["content"]) > self._consumed_result_chars
            ):
                message = {**message, "content": message["content"][: self._consumed_result_chars] + "… [truncated]"}
            compact.append(message)
        return compact

    async def _usable(self, ctx: ToolContext, specialist: Specialist) -> set[str] | None:
        """Tools on offer at this step: this specialist's, narrowed to what can be used now."""
        names = await self._select_tools(ctx) if self._select_tools else None
        if specialist.tools is None:
            return names
        return set(specialist.tools) if names is None else names & specialist.tools

    async def run(
        self,
        messages: list[dict[str, Any]],
        ctx: ToolContext,
        specialist: Specialist = GENERALIST,
        allow_hand_off: bool = True,
    ) -> AsyncIterator[dict[str, Any]]:
        started = time.monotonic()
        tools_called: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0}
        malformed_calls = 0
        hand_offs = 0

        for _ in range(self._max_steps):
            # What can be done changes as the turn goes on (a trip becomes ready to
            # plan, an offer becomes bookable, the turn is handed over), so this is
            # worked out afresh each step.
            names = await self._usable(ctx, specialist)
            schemas = self._tools.schemas(names)
            if allow_hand_off and hand_offs < MAX_HAND_OFFS and (hand_off := hand_off_schema(specialist)):
                schemas.append(hand_off)
            prompt = build_system_prompt(ctx.today, specialist, names)
            # Read afresh each step: a tool in this turn may just have changed the trip.
            if note := await self._tools.trip_note(ctx):
                prompt += "\n\n" + note
            if ctx.location is not None:
                prompt += (
                    "\n\nThe traveller's browser shared their position with this message. For anything near them, "
                    "search with near_traveller true; do not ask where they are."
                )
            system = {"role": "system", "content": prompt}

            completion: Completion | None = None
            try:
                async for chunk in self._llm.stream([system, *self._for_model(messages)], schemas or None):
                    if isinstance(chunk, TextDelta):
                        yield {"type": "text", "delta": chunk.text}
                    elif isinstance(chunk, Notice):
                        yield {"type": "status", "text": chunk.text}
                    else:
                        completion = chunk
            except LLMToolCallError as exc:
                malformed_calls += 1
                if malformed_calls > MAX_MALFORMED_CALLS:
                    raise
                logger.warning("malformed tool call conversation=%s reason=%s", ctx.conversation_id, exc.reason)
                # Tell the model what was wrong and let it try again. Not stored: it is
                # scaffolding for this turn, not part of the conversation.
                messages.append(
                    {
                        "role": "system",
                        "content": "Your last tool call was rejected as malformed and did not run: "
                        f"{exc.reason} Make the call again with arguments that match the tool's schema exactly.",
                    }
                )
                continue
            assert completion is not None, "LLMProvider.stream must end with a Completion"

            for key in usage:
                usage[key] += completion.usage.get(key, 0)
            assistant_message = completion.to_message()
            messages.append(assistant_message)
            yield {"type": "message", "message": assistant_message, "card": None}

            if not completion.tool_calls:
                break

            for call in completion.tool_calls:
                tool = self._tools.get(call.name)
                yield {"type": "status", "text": tool.status if tool else "Working on it…"}
                if call.name == HAND_OFF:
                    target = self._hand_off_target(call.arguments, specialist)
                    if target is None or hand_offs >= MAX_HAND_OFFS:
                        result = ToolResult({"error": "That hand-off is not possible. Answer the traveller yourself."})
                    else:
                        hand_offs += 1
                        logger.info("hand-off conversation=%s %s -> %s", ctx.conversation_id, specialist.name, target.name)
                        specialist = target
                        yield {"type": "specialist", "name": specialist.name}
                        result = ToolResult({"ok": True, "note": "You now hold this request. Carry on with it."})
                elif names is not None and call.name not in names:
                    # The model reached for a tool it was not offered at this step.
                    hint = tool.unavailable_hint if tool else ""
                    result = ToolResult({"error": f"'{call.name}' cannot be used yet. {hint}".strip()})
                else:
                    result = await self._tools.execute(call.name, call.arguments, ctx)
                tools_called.append(call.name)
                tool_message = {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": call.name,
                    "content": json.dumps(result.data, default=str),
                }
                messages.append(tool_message)
                yield {"type": "message", "message": tool_message, "card": result.card}
        else:
            fallback = {"role": "assistant", "content": STEP_LIMIT_MESSAGE}
            messages.append(fallback)
            yield {"type": "text", "delta": STEP_LIMIT_MESSAGE}
            yield {"type": "message", "message": fallback, "card": None}

        logger.info(
            "agent turn conversation=%s specialist=%s model=%s tools=%s input_tokens=%s output_tokens=%s seconds=%.2f",
            ctx.conversation_id,
            specialist.name,
            self._llm.model,
            tools_called,
            usage["input_tokens"],
            usage["output_tokens"],
            time.monotonic() - started,
        )

    @staticmethod
    def _hand_off_target(raw_arguments: str, current: Specialist) -> Specialist | None:
        try:
            name = json.loads(raw_arguments or "{}").get("specialist")
        except (json.JSONDecodeError, AttributeError):
            return None
        target = SPECIALISTS.get(name)
        return target if target is not None and target.name != current.name else None
