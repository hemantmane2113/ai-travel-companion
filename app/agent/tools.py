import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.client import SharedLocation

logger = logging.getLogger(__name__)


@dataclass
class ToolContext:
    db: AsyncSession
    user_id: int
    conversation_id: int
    today: date = field(default_factory=date.today)  # the traveller's date, from their timezone
    # Shared by the traveller's browser for this message only. Never stored, logged or
    # shown to the model; tools use it and report an area name instead.
    location: SharedLocation | None = None


@dataclass
class ToolResult:
    data: dict[str, Any]  # returned to the model
    card: dict[str, Any] | None = None  # rendered by the UI


class ToolFailure(Exception):
    """A tool could not do what was asked. The message is returned to the model."""


Handler = Callable[[ToolContext, Any], Awaitable[ToolResult]]


@dataclass
class Tool:
    name: str
    description: str
    args_model: type[BaseModel]
    handler: Handler
    status: str  # shown in the UI while the tool runs
    # Reference text the model has already written from. Its result is cut short when
    # replayed in later turns; results the model must keep acting on (ids, prices) are not.
    bulky_reference: bool = False
    # Told to the model if it calls the tool at a point where it is not on offer.
    unavailable_hint: str = ""
    # One line, written in code from the result, that stands in for the full result
    # when it is replayed in later turns. None keeps the result (ids, prices).
    recap: Callable[[dict[str, Any]], str] | None = None


# State the model always sees at the top of its instructions, read fresh from the database.
TripNote = Callable[[ToolContext], Awaitable[str | None]]


def tool_parameters(model: type[BaseModel]) -> dict[str, Any]:
    """JSON schema for a tool's arguments, in the plainest form a model can follow.

    Pydantic puts nested models under "$defs" and points at them with "$ref". Models
    tend not to follow the pointer and invent field names for nested objects, so the
    definitions are written out in place. Auto-generated titles are dropped as noise.
    """
    schema = model.model_json_schema()
    definitions = schema.pop("$defs", {})

    def expand(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                target = definitions[node["$ref"].rsplit("/", 1)[-1]]
                return expand({**target, **{k: v for k, v in node.items() if k != "$ref"}})
            # "X or null" is kept as it is for optional fields: models do send null for
            # them, and a provider that validates arguments would reject the whole call.
            return {
                key: expand(value)
                for key, value in node.items()
                if not (key == "title" and isinstance(value, str))
            }
        if isinstance(node, list):
            return [expand(item) for item in node]
        return node

    return expand(schema)


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None, trip_note: TripNote | None = None):
        self._tools: dict[str, Tool] = {tool.name: tool for tool in tools or []}
        self._trip_note = trip_note

    def is_bulky_reference(self, name: str) -> bool:
        tool = self._tools.get(name)
        return tool is not None and tool.bulky_reference

    def recap(self, name: str, content: str) -> str | None:
        """The short stand-in for a stored result, or None to replay the result itself."""
        try:
            data = json.loads(content)
        except (TypeError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        if "error" in data:
            return json.dumps({"error": str(data["error"])[:300]})
        tool = self._tools.get(name)
        if tool is None or tool.recap is None:
            return None
        try:
            return tool.recap(data)
        except (KeyError, TypeError, ValueError, AttributeError):
            logger.warning("recap for %s failed; replaying the result", name)
            return None

    async def trip_note(self, ctx: ToolContext) -> str | None:
        if self._trip_note is None:
            return None
        try:
            return await self._trip_note(ctx)
        except Exception:
            # The note helps; a turn must never fail for want of it.
            logger.exception("trip note failed conversation=%s", ctx.conversation_id)
            return None

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def schemas(self, names: set[str] | None = None) -> list[dict[str, Any]]:
        """Tool definitions for the model: all of them, or only those named."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool_parameters(tool.args_model),
                },
            }
            for tool in self._tools.values()
            if names is None or tool.name in names
        ]

    async def execute(self, name: str, raw_arguments: str, ctx: ToolContext) -> ToolResult:
        """Run a tool. Failures come back as an error result so the model can correct itself."""
        tool = self._tools.get(name)
        if tool is None:
            return ToolResult({"error": f"Unknown tool '{name}'."})
        try:
            args = tool.args_model.model_validate(json.loads(raw_arguments or "{}"))
        except json.JSONDecodeError:
            return ToolResult({"error": "Arguments were not valid JSON."})
        except ValidationError as exc:
            return ToolResult({"error": "Invalid arguments.", "details": exc.errors(include_url=False, include_input=False)})
        try:
            return await tool.handler(ctx, args)
        except ToolFailure as exc:
            return ToolResult({"error": str(exc)})
        except Exception:
            logger.exception("tool %s crashed", name)
            return ToolResult({"error": f"The {name} tool failed unexpectedly. Tell the user it did not work."})
