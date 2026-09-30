import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import date
from pathlib import Path
from typing import Any

from app.agent.tools import ToolContext, ToolRegistry
from app.providers.llm.base import Completion, LLMProvider, TextDelta

logger = logging.getLogger(__name__)

PROMPT_VERSION = "system_v1"
_PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_VERSION}.md"

STEP_LIMIT_MESSAGE = (
    "I could not finish that in a reasonable number of steps. "
    "Tell me which part to continue with and I will pick it up from there."
)


def build_system_prompt(today: date | None = None) -> str:
    today = today or date.today()
    return _PROMPT_PATH.read_text(encoding="utf-8").replace("{today}", today.strftime("%A, %d %B %Y"))


class CompanionAgent:
    """Tool-calling loop. It decides and talks; the tools do the work.

    run() yields events for the caller to stream and persist:
      {"type": "text", "delta": str}                 assistant text as it arrives
      {"type": "status", "text": str}                a tool started
      {"type": "message", "message": dict, "card": dict | None}
                                                     a transcript entry to store
    """

    def __init__(self, llm: LLMProvider, tools: ToolRegistry, max_steps: int = 8):
        self._llm = llm
        self._tools = tools
        self._max_steps = max_steps

    async def run(
        self, messages: list[dict[str, Any]], ctx: ToolContext
    ) -> AsyncIterator[dict[str, Any]]:
        started = time.monotonic()
        tools_called: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0}
        schemas = self._tools.schemas() or None

        for _ in range(self._max_steps):
            completion: Completion | None = None
            async for chunk in self._llm.stream(messages, schemas):
                if isinstance(chunk, TextDelta):
                    yield {"type": "text", "delta": chunk.text}
                else:
                    completion = chunk
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
                yield {"type": "status", "text": tool.status if tool else "Working…"}
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
            "agent turn conversation=%s model=%s tools=%s input_tokens=%s output_tokens=%s seconds=%.2f",
            ctx.conversation_id,
            self._llm.model,
            tools_called,
            usage["input_tokens"],
            usage["output_tokens"],
            time.monotonic() - started,
        )
