import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.config import Settings
from app.db import Base, create_session_factory
from app.main import create_app
from app.providers.llm.base import Completion, LLMProvider, TextDelta, ToolCall
from sqlalchemy.ext.asyncio import create_async_engine


class FakeLLM(LLMProvider):
    """Replays scripted completions and records what it was sent."""

    model = "fake"

    def __init__(self, script: list[Completion] | None = None):
        self.script = list(script or [])
        self.calls: list[dict[str, Any]] = []

    def queue(self, *completions: Completion) -> None:
        self.script.extend(completions)

    async def stream(self, messages, tools=None) -> AsyncIterator[TextDelta | Completion]:
        self.calls.append({"messages": [dict(m) for m in messages], "tools": tools})
        completion = self.script.pop(0)
        if completion.content:
            yield TextDelta(completion.content)
        yield completion


def say(text: str) -> Completion:
    return Completion(content=text)


def call(name: str, arguments: dict[str, Any], call_id: str = "call_1") -> Completion:
    return Completion(content="", tool_calls=[ToolCall(call_id, name, json.dumps(arguments))])


def sse_events(body: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for frame in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


@pytest.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield create_session_factory(engine)
    await engine.dispose()


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def app(session_factory, llm):
    settings = Settings(_env_file=None, session_secret="test-secret", database_url="sqlite+aiosqlite://")
    return create_app(settings=settings, session_factory=session_factory, llm=llm)


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def anon(app):
    async with _client(app) as client:
        yield client


async def _register(client: httpx.AsyncClient, email: str) -> httpx.AsyncClient:
    response = await client.post("/register", data={"email": email, "password": "correct-horse"})
    assert response.status_code == 303
    return client


@pytest.fixture
async def client(app):
    async with _client(app) as client:
        yield await _register(client, "asha@example.com")


@pytest.fixture
async def other_client(app):
    async with _client(app) as client:
        yield await _register(client, "ravi@example.com")
