"""Streaming chat with tool calls over the chat-completions API shape.

Groq, Cerebras, OpenRouter, Ollama and others all speak it, and their Python SDKs
(`groq`, `openai`) expose the same client methods and error classes, so one
implementation serves them all.
"""

import asyncio
import logging
import math
from collections.abc import AsyncIterator
from types import ModuleType
from typing import Any

from app.providers.llm.base import (
    Completion,
    LLMError,
    LLMProvider,
    LLMRateLimited,
    LLMRequestTooLarge,
    LLMToolCallError,
    Notice,
    TextDelta,
    ToolCall,
)

logger = logging.getLogger(__name__)

MAX_RATE_LIMIT_WAITS = 4
MAX_RATE_LIMIT_WAIT_SECONDS = 60.0
DEFAULT_RATE_LIMIT_WAIT_SECONDS = 10.0

RATE_LIMITED = "The AI service is rate limited right now. Try again in a minute."
TOO_LARGE = (
    "This conversation is now too large for the AI service's tokens-per-minute limit. "
    "Start a new trip chat, or use a plan or model with a higher limit."
)


def allowance_used_up(wait_seconds: float) -> str:
    return (
        "The AI service's usage allowance is used up for now. It will accept this request again in about "
        f"{math.ceil(wait_seconds / 60)} minutes. A paid plan raises the allowance."
    )


def _retry_after(exc: Exception) -> float:
    try:
        return float(exc.response.headers["retry-after"])
    except (AttributeError, KeyError, ValueError):
        return DEFAULT_RATE_LIMIT_WAIT_SECONDS


def _usage(chunk: Any) -> dict[str, int] | None:
    # Standard servers put usage on the final chunk; Groq nests it under x_groq.
    usage = getattr(chunk, "usage", None) or getattr(getattr(chunk, "x_groq", None), "usage", None)
    if usage is None:
        return None
    return {"input_tokens": usage.prompt_tokens or 0, "output_tokens": usage.completion_tokens or 0}


class ChatCompletionsProvider(LLMProvider):
    def __init__(
        self,
        sdk: ModuleType,
        client: Any,
        model: str,
        request_options: dict[str, Any] | None = None,
        wait_on_rate_limit: bool = True,
    ):
        self.model = model
        self._sdk = sdk  # source of the error classes that `client` raises
        self._client = client  # must be created with max_retries=0; waits are handled here
        self._request_options = request_options or {}
        # When False, a rate limit is raised at once as LLMRateLimited so the caller
        # can try another model instead of waiting.
        self._wait_on_rate_limit = wait_on_rate_limit

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[TextDelta | Notice | Completion]:
        sdk = self._sdk
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.4,
            "stream": True,
            **self._request_options,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        text_parts: list[str] = []
        calls: dict[int, ToolCall] = {}
        usage: dict[str, int] = {}

        try:
            response = None
            for attempt in range(MAX_RATE_LIMIT_WAITS + 1):
                try:
                    response = await self._client.chat.completions.create(**kwargs)
                    break
                except sdk.RateLimitError as exc:
                    wait = _retry_after(exc)
                    logger.info(
                        "llm rate limited model=%s retry-after=%.0fs attempt=%d: %s", self.model, wait, attempt + 1, exc
                    )
                    if wait > MAX_RATE_LIMIT_WAIT_SECONDS:
                        # Too long to be the per-minute limit: a longer quota (per day) is used up.
                        raise LLMRateLimited(allowance_used_up(wait), wait) from exc
                    if not self._wait_on_rate_limit or attempt == MAX_RATE_LIMIT_WAITS:
                        raise LLMRateLimited(RATE_LIMITED, wait) from exc
                    yield Notice(f"The AI service is rate limited. Continuing in {math.ceil(wait)} seconds…")
                    await asyncio.sleep(wait)

            async for chunk in response:
                usage = _usage(chunk) or usage
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    text_parts.append(delta.content)
                    yield TextDelta(delta.content)
                for part in delta.tool_calls or []:
                    call = calls.setdefault(part.index or 0, ToolCall(id="", name="", arguments=""))
                    if part.id:
                        call.id = part.id
                    if part.function and part.function.name:
                        call.name = part.function.name
                    if part.function and part.function.arguments:
                        call.arguments += part.function.arguments
        except sdk.AuthenticationError as exc:
            raise LLMError("The AI service rejected the server's API key.") from exc
        except sdk.APITimeoutError as exc:
            raise LLMError("The AI service took too long to respond. Try again.") from exc
        except sdk.APIConnectionError as exc:
            raise LLMError("The AI service could not be reached. Check the connection and try again.") from exc
        except sdk.APIError as exc:
            body = getattr(exc, "body", None)
            error = body.get("error", body) if isinstance(body, dict) else {}
            error = error if isinstance(error, dict) else {}
            logger.warning("llm error: %s", exc)
            if error.get("code") == "tool_use_failed":
                raise LLMToolCallError(str(error.get("message", "")), str(error.get("failed_generation", ""))) from exc
            if getattr(exc, "status_code", None) == 413:
                raise LLMRequestTooLarge(TOO_LARGE) from exc
            raise LLMError("The AI service returned an error. Try again.") from exc

        yield Completion(
            content="".join(text_parts),
            tool_calls=[calls[index] for index in sorted(calls)],
            usage=usage,
        )
