from types import SimpleNamespace

import groq
import httpx
import openai
import pytest

from app.config import Settings
from app.main import build_llm
from app.providers.llm import chat_completions
from app.providers.llm.base import Completion, LLMError, LLMToolCallError, Notice, TextDelta
from app.providers.llm.groq_provider import GroqProvider
from app.providers.llm.openai_compatible import OpenAICompatibleProvider

REQUEST = httpx.Request("POST", "https://example.test/v1/chat/completions")
MESSAGES = [{"role": "user", "content": "hi"}]


def _providers():
    return [
        (groq, GroqProvider("test-key", "test-model")),
        (openai, OpenAICompatibleProvider("https://example.test/v1", "test-key", "test-model")),
    ]


def _script(monkeypatch, provider, outcomes: list):
    """Make the SDK client return or raise the scripted outcomes, one per call."""
    seen = []

    async def create(**kwargs):
        seen.append(kwargs)
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def no_sleep(seconds):
        pass

    monkeypatch.setattr(provider._client.chat.completions, "create", create)
    monkeypatch.setattr(chat_completions.asyncio, "sleep", no_sleep)
    return seen


def _rate_limited(sdk, retry_after: str):
    response = httpx.Response(429, headers={"retry-after": retry_after}, request=REQUEST)
    return sdk.RateLimitError("rate limited", response=response, body=None)


def _chunk(content=None, tool_calls=None, usage=None):
    delta = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=usage, x_groq=None)


def _tool_part(index, id=None, name=None, arguments=None):
    return SimpleNamespace(index=index, id=id, function=SimpleNamespace(name=name, arguments=arguments))


async def _stream(chunks):
    for chunk in chunks:
        yield chunk


async def _collect(provider, tools=None):
    return [chunk async for chunk in provider.stream(MESSAGES, tools)]


@pytest.mark.parametrize("sdk,provider", _providers())
async def test_text_and_split_tool_calls_are_assembled(monkeypatch, sdk, provider):
    usage = SimpleNamespace(prompt_tokens=120, completion_tokens=30)
    chunks = [
        _chunk(content="Let me "),
        _chunk(content="check."),
        _chunk(tool_calls=[_tool_part(0, id="call_a", name="get_travel_guide", arguments='{"destina')]),
        _chunk(tool_calls=[_tool_part(0, arguments='tion": "Indore"}'), _tool_part(1, id="call_b", name="list_bookings", arguments="{}")]),
        SimpleNamespace(choices=[], usage=usage, x_groq=None),
    ]
    tools = [{"type": "function", "function": {"name": "get_travel_guide"}}]
    seen = _script(monkeypatch, provider, [_stream(chunks)])

    out = await _collect(provider, tools)

    assert out[:2] == [TextDelta("Let me "), TextDelta("check.")]
    final = out[-1]
    assert isinstance(final, Completion) and final.content == "Let me check."
    assert [(c.id, c.name, c.arguments) for c in final.tool_calls] == [
        ("call_a", "get_travel_guide", '{"destination": "Indore"}'),
        ("call_b", "list_bookings", "{}"),
    ]
    assert final.usage == {"input_tokens": 120, "output_tokens": 30}
    assert seen[0]["model"] == "test-model" and seen[0]["tools"] == tools and seen[0]["stream"] is True


@pytest.mark.parametrize("sdk,provider", _providers())
async def test_short_rate_limit_waits_are_announced_then_given_up_on(monkeypatch, sdk, provider):
    _script(monkeypatch, provider, [_rate_limited(sdk, "12") for _ in range(5)])

    notices = []
    with pytest.raises(LLMError, match="Try again in a minute"):
        async for chunk in provider.stream(MESSAGES):
            notices.append(chunk)

    assert len(notices) == 4 and all(isinstance(notice, Notice) for notice in notices)
    assert notices[0].text == "The AI service is rate limited. Continuing in 12 seconds…"


@pytest.mark.parametrize("sdk,provider", _providers())
async def test_request_goes_through_after_a_wait(monkeypatch, sdk, provider):
    _script(monkeypatch, provider, [_rate_limited(sdk, "3"), _stream([_chunk(content="Hello")])])
    out = await _collect(provider)
    assert isinstance(out[0], Notice) and out[1] == TextDelta("Hello") and out[-1].content == "Hello"


@pytest.mark.parametrize("sdk,provider", _providers())
async def test_exhausted_allowance_says_how_long_instead_of_waiting(monkeypatch, sdk, provider):
    _script(monkeypatch, provider, [_rate_limited(sdk, "2389")])
    with pytest.raises(LLMError, match="again in about 40 minutes"):
        await _collect(provider)


@pytest.mark.parametrize("sdk,provider", _providers())
async def test_errors_become_messages_safe_to_show(monkeypatch, sdk, provider):
    def status_error(code, body=None):
        return sdk.APIStatusError("boom", response=httpx.Response(code, request=REQUEST), body=body)

    cases = [
        (sdk.AuthenticationError("no", response=httpx.Response(401, request=REQUEST), body=None), "rejected the server's API key"),
        (sdk.APITimeoutError(request=REQUEST), "took too long"),
        (sdk.APIConnectionError(request=REQUEST), "could not be reached"),
        (status_error(413), "too large"),
        (status_error(500), "returned an error"),
    ]
    for error, expected in cases:
        _script(monkeypatch, provider, [error])
        with pytest.raises(LLMError, match=expected):
            await _collect(provider)

    rejected = status_error(400, {"error": {"code": "tool_use_failed", "message": "did not match schema"}})
    _script(monkeypatch, provider, [rejected])
    with pytest.raises(LLMToolCallError) as caught:
        await _collect(provider)
    assert caught.value.reason == "did not match schema"


def test_openai_compatible_provider_asks_for_usage_and_uses_the_base_url():
    provider = OpenAICompatibleProvider("https://api.cerebras.ai/v1", "k", "some-model")
    assert str(provider._client.base_url) == "https://api.cerebras.ai/v1/"
    assert provider._request_options == {"stream_options": {"include_usage": True}}
    assert provider._client.max_retries == 0


def test_build_llm_follows_the_configured_provider():
    def settings(**values):
        return Settings(_env_file=None, session_secret="s", **values)

    assert build_llm(settings()) is None
    assert isinstance(build_llm(settings(groq_api_key="g", groq_fallback_models="")), GroqProvider)

    # Choosing the compatible provider ignores the Groq key, and needs a key and a model.
    assert build_llm(settings(llm_provider="openai_compatible", groq_api_key="g")) is None
    assert build_llm(settings(llm_provider="openai_compatible", llm_api_key="k")) is None
    cerebras = build_llm(settings(llm_provider="openai_compatible", llm_api_key="k", llm_model="m"))
    assert isinstance(cerebras, OpenAICompatibleProvider) and cerebras.model == "m"
    assert str(cerebras._client.base_url) == "https://api.cerebras.ai/v1/"
