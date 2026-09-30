import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass
class ToolContext:
    db: AsyncSession
    user_id: int
    conversation_id: int


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


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None):
        self._tools: dict[str, Tool] = {tool.name: tool for tool in tools or []}

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.args_model.model_json_schema(),
                },
            }
            for tool in self._tools.values()
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
