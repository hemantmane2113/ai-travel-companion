from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


class LLMError(Exception):
    """The LLM provider failed. The message is safe to show to the user."""


class LLMToolCallError(LLMError):
    """The model produced a tool call the provider rejected as malformed."""

    def __init__(self, reason: str, failed_generation: str = ""):
        super().__init__("The AI service could not complete that step. Try again.")
        self.reason = reason
        self.failed_generation = failed_generation


class LLMRequestTooLarge(LLMError):
    """The request is bigger than the service accepts at once."""


class LLMRateLimited(LLMError):
    """The service will not take this request until `retry_after` seconds have passed."""

    def __init__(self, message: str, retry_after: float):
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # raw JSON string as produced by the model


@dataclass
class TextDelta:
    text: str


@dataclass
class Notice:
    """Something the traveller should see while waiting, e.g. a rate-limit pause."""

    text: str


@dataclass
class Completion:
    """Final result of one LLM call, emitted after all TextDeltas."""

    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)

    def to_message(self) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in self.tool_calls
            ]
        return message


class LLMProvider(ABC):
    """Chat model with tool calling.

    Messages and tool schemas use the OpenAI chat-completions shape, which is the
    application's internal transcript format.
    """

    model: str

    @abstractmethod
    def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[TextDelta | Notice | Completion]:
        """Yield TextDeltas (and any Notices) as they arrive, then exactly one Completion."""
