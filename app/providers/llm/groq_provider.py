from collections.abc import AsyncIterator
from typing import Any

import groq

from app.providers.llm.base import Completion, LLMError, LLMProvider, TextDelta, ToolCall


class GroqProvider(LLMProvider):
    def __init__(self, api_key: str, model: str, timeout: float = 60.0):
        self.model = model
        self._client = groq.AsyncGroq(api_key=api_key, timeout=timeout, max_retries=2)

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[TextDelta | Completion]:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.4,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        text_parts: list[str] = []
        calls: dict[int, ToolCall] = {}
        usage: dict[str, int] = {}

        try:
            response = await self._client.chat.completions.create(**kwargs)
            async for chunk in response:
                chunk_usage = getattr(getattr(chunk, "x_groq", None), "usage", None)
                if chunk_usage is not None:
                    usage = {
                        "input_tokens": chunk_usage.prompt_tokens,
                        "output_tokens": chunk_usage.completion_tokens,
                    }
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    text_parts.append(delta.content)
                    yield TextDelta(delta.content)
                for part in delta.tool_calls or []:
                    call = calls.setdefault(part.index, ToolCall(id="", name="", arguments=""))
                    if part.id:
                        call.id = part.id
                    if part.function and part.function.name:
                        call.name = part.function.name
                    if part.function and part.function.arguments:
                        call.arguments += part.function.arguments
        except groq.AuthenticationError as exc:
            raise LLMError("The AI service rejected the server's API key.") from exc
        except groq.RateLimitError as exc:
            raise LLMError("The AI service is rate limited right now. Try again in a minute.") from exc
        except groq.APITimeoutError as exc:
            raise LLMError("The AI service took too long to respond. Try again.") from exc
        except groq.APIError as exc:
            raise LLMError("The AI service returned an error. Try again.") from exc

        yield Completion(
            content="".join(text_parts),
            tool_calls=[calls[index] for index in sorted(calls)],
            usage=usage,
        )
