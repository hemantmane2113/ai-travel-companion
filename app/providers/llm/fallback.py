import asyncio
import logging
import math
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from app.providers.llm.base import (
    Completion,
    LLMError,
    LLMProvider,
    LLMRateLimited,
    LLMToolCallError,
    Notice,
    TextDelta,
)
from app.providers.llm.chat_completions import MAX_RATE_LIMIT_WAIT_SECONDS, RATE_LIMITED, allowance_used_up

logger = logging.getLogger(__name__)

MAX_WAITS = 4


class FallbackLLMProvider(LLMProvider):
    """Several models in order of preference, each with its own usage allowance.

    A model that is rate limited or out of allowance is set aside until it is due
    back, and the next one takes the request. A model that fails for another reason
    is skipped for that request. Only when every model is rate limited does the
    traveller wait, and then only for the one due back soonest.

    The providers must raise LLMRateLimited rather than wait themselves.
    """

    def __init__(
        self,
        providers: list[LLMProvider],
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        if not providers:
            raise ValueError("FallbackLLMProvider needs at least one provider")
        self._providers = providers
        self._clock = clock
        self._sleep = sleep
        self._due_back = [0.0] * len(providers)
        self.model = providers[0].model  # the model that served the latest request

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[TextDelta | Notice | Completion]:
        last_limit: LLMRateLimited | None = None
        failure: LLMError | None = None
        failed: set[int] = set()  # models that cannot take this particular request

        for attempt in range(MAX_WAITS + 1):
            for index, provider in enumerate(self._providers):
                if index in failed or self._due_back[index] > self._clock():
                    continue
                started = False
                try:
                    async for chunk in provider.stream(messages, tools):
                        started = True
                        yield chunk
                    if index:
                        logger.info("served by fallback model %s", provider.model)
                    self.model = provider.model
                    return
                except LLMToolCallError:
                    raise  # the model answered badly; the agent loop handles that
                except LLMRateLimited as exc:
                    self._due_back[index] = self._clock() + exc.retry_after
                    last_limit = exc
                    logger.info("model %s set aside for %.0fs (rate limit)", provider.model, exc.retry_after)
                except LLMError as exc:
                    if started:
                        raise  # part of an answer is already on screen; do not start another
                    # Includes "request too large": models count tokens differently, so
                    # one that refuses a request does not speak for the others.
                    failed.add(index)
                    failure = exc
                    logger.warning("model %s cannot take this request, trying the next: %s", provider.model, exc)

            waiting_on = [self._due_back[i] for i in range(len(self._providers)) if i not in failed]
            if not waiting_on:
                raise failure  # every model refused or failed; there is nothing to wait for

            # The models still in play are all rate limited. Wait for the first one back, if that is soon.
            wait = min(waiting_on) - self._clock()
            if wait > MAX_RATE_LIMIT_WAIT_SECONDS:
                raise LLMError(allowance_used_up(wait)) from last_limit
            if attempt == MAX_WAITS:
                break
            if wait > 0:
                yield Notice(f"The AI service is rate limited. Continuing in {math.ceil(wait)} seconds…")
                await self._sleep(wait)

        raise LLMError(RATE_LIMITED) from last_limit
