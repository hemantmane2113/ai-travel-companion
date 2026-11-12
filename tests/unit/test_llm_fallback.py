import pytest

from app.config import Settings
from app.main import build_llm
from app.providers.llm.base import (
    Completion,
    LLMError,
    LLMProvider,
    LLMRateLimited,
    LLMRequestTooLarge,
    LLMToolCallError,
    Notice,
    TextDelta,
)
from app.providers.llm.fallback import FallbackLLMProvider
from app.providers.llm.groq_provider import GroqProvider

MESSAGES = [{"role": "user", "content": "hi"}]


class Scripted(LLMProvider):
    """Answers with its own name, or raises whatever is queued first."""

    def __init__(self, model: str, outcomes: list | None = None):
        self.model = model
        self.outcomes = list(outcomes or [])
        self.calls = 0

    async def stream(self, messages, tools=None):
        self.calls += 1
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, Exception):
            raise outcome
        yield TextDelta(f"from {self.model}")
        if outcome == "break mid-answer":
            raise LLMError("connection dropped")
        yield Completion(content=f"from {self.model}")


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _fallback(*providers):
    clock = Clock()
    return FallbackLLMProvider(list(providers), clock=clock, sleep=clock.sleep), clock


async def _answer(llm) -> tuple[str, list[Notice]]:
    chunks = [chunk async for chunk in llm.stream(MESSAGES)]
    return chunks[-1].content, [chunk for chunk in chunks if isinstance(chunk, Notice)]


def limited(seconds: float) -> LLMRateLimited:
    return LLMRateLimited("limited", seconds)


async def test_primary_is_used_while_it_is_available():
    primary, backup = Scripted("big"), Scripted("small")
    llm, _ = _fallback(primary, backup)

    assert await _answer(llm) == ("from big", [])
    assert backup.calls == 0 and llm.model == "big"


async def test_rate_limited_primary_is_set_aside_until_due_back():
    primary, backup = Scripted("big", [limited(30)]), Scripted("small")
    llm, clock = _fallback(primary, backup)

    assert await _answer(llm) == ("from small", [])  # no waiting: the next model takes it
    assert llm.model == "small" and clock.slept == []

    clock.now += 10
    assert (await _answer(llm))[0] == "from small"
    assert primary.calls == 1  # not asked again while set aside

    clock.now += 25
    assert (await _answer(llm))[0] == "from big"  # back as soon as it is due


async def test_waits_only_when_every_model_is_limited_and_for_the_soonest():
    primary, backup = Scripted("big", [limited(40)]), Scripted("small", [limited(15)])
    llm, clock = _fallback(primary, backup)

    answer, notices = await _answer(llm)

    assert answer == "from small" and clock.slept == [15]
    assert notices[0].text == "The AI service is rate limited. Continuing in 15 seconds…"


async def test_all_allowances_used_up_says_how_long_instead_of_waiting():
    primary, backup = Scripted("big", [limited(2400)]), Scripted("small", [limited(1500)])
    llm, clock = _fallback(primary, backup)

    with pytest.raises(LLMError, match="again in about 25 minutes"):
        await _answer(llm)
    assert clock.slept == []


async def test_daily_limit_on_primary_falls_back_without_telling_the_traveller_to_wait():
    primary, backup = Scripted("big", [limited(2400)]), Scripted("small")
    llm, clock = _fallback(primary, backup)

    assert await _answer(llm) == ("from small", [])
    clock.now += 600
    assert (await _answer(llm))[0] == "from small" and primary.calls == 1


async def test_failing_model_is_skipped_for_that_request_only():
    primary, backup = Scripted("big", [LLMError("The AI service returned an error.")]), Scripted("small")
    llm, _ = _fallback(primary, backup)

    assert (await _answer(llm))[0] == "from small"
    assert (await _answer(llm))[0] == "from big"  # not set aside: tried again next time


async def test_when_every_free_model_fails_the_error_is_raised_not_waited_on():
    primary, backup = Scripted("big", [LLMError("first")]), Scripted("small", [LLMError("second")])
    llm, clock = _fallback(primary, backup)
    with pytest.raises(LLMError, match="second"):
        await _answer(llm)
    assert clock.slept == []


async def test_malformed_tool_call_is_passed_up_for_the_agent_to_correct():
    primary, backup = Scripted("big", [LLMToolCallError("bad arguments")]), Scripted("small")
    llm, _ = _fallback(primary, backup)
    with pytest.raises(LLMToolCallError):
        await _answer(llm)
    assert backup.calls == 0


async def test_request_too_large_for_one_model_is_offered_to_the_others():
    # Models count tokens differently, so one refusing does not settle it.
    primary, backup = Scripted("big", [LLMRequestTooLarge("too large")]), Scripted("small")
    llm, _ = _fallback(primary, backup)
    assert (await _answer(llm))[0] == "from small"

    everyone = _fallback(Scripted("big", [LLMRequestTooLarge("too large")]), Scripted("small", [LLMRequestTooLarge("too large")]))[0]
    with pytest.raises(LLMRequestTooLarge):
        await _answer(everyone)


async def test_waits_for_a_limited_model_when_the_only_free_one_refuses():
    primary, backup = Scripted("big", [limited(20)]), Scripted("small", [LLMRequestTooLarge("too large")])
    llm, clock = _fallback(primary, backup)

    answer, notices = await _answer(llm)

    assert answer == "from big" and clock.slept == [20] and len(notices) == 1
    assert backup.calls == 1  # not asked again for the request it refused


async def test_no_second_answer_is_started_once_text_has_been_shown():
    primary, backup = Scripted("big", ["break mid-answer"]), Scripted("small")
    llm, _ = _fallback(primary, backup)
    with pytest.raises(LLMError, match="connection dropped"):
        await _answer(llm)
    assert backup.calls == 0


async def test_gives_up_after_repeated_short_limits():
    always = [limited(5) for _ in range(10)]
    llm, clock = _fallback(Scripted("big", always))
    with pytest.raises(LLMError, match="Try again in a minute"):
        await _answer(llm)
    assert clock.slept == [5, 5, 5, 5]


def test_build_llm_chains_groq_models_and_can_turn_fallback_off():
    def settings(**values):
        return Settings(_env_file=None, session_secret="s", groq_api_key="g", **values)

    chained = build_llm(settings())
    assert isinstance(chained, FallbackLLMProvider)
    assert [p.model for p in chained._providers] == ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
    assert all(p._wait_on_rate_limit is False for p in chained._providers)
    assert chained._providers[2]._request_options == {"reasoning_format": "hidden"}

    assert isinstance(build_llm(settings(groq_fallback_models="")), GroqProvider)
    same = build_llm(settings(groq_fallback_models="openai/gpt-oss-120b"))
    assert isinstance(same, GroqProvider)  # a fallback equal to the primary adds nothing
