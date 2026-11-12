"""Splitting a request that spans several specialists into ordered steps.

The router sends a message here only when it covers more than one area ("plan the
trip, find a hotel and trains"). The orchestrator model writes the plan; code checks
it; each step then runs with its specialist, in order, so later steps can build on
earlier ones. Joining the answers needs no model: each step's reply is shown as it
comes.
"""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from app.agent.specialists import PROMPT_VERSION, SPECIALISTS
from app.providers.llm.base import Completion, LLMError, LLMProvider

logger = logging.getLogger(__name__)

MAX_STEPS = 4
_PROMPT_PATH = Path(__file__).parent / "prompts" / f"orchestrator_{PROMPT_VERSION}.md"


@dataclass(frozen=True)
class Step:
    specialist: str
    task: str


class _PlannedStep(BaseModel):
    specialist: str
    task: str = Field(min_length=3, max_length=600)


class _Plan(BaseModel):
    steps: list[_PlannedStep]


def parse_plan(text: str) -> list[Step]:
    """The steps in a model's answer that can actually be run.

    Small models wrap JSON in prose or code fences, so the first JSON object in the
    text is used. Unknown specialists are dropped, as are repeats of the same
    specialist, and the plan is cut to MAX_STEPS.
    """
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return []
    try:
        plan = _Plan.model_validate(json.loads(match.group(0)))
    except (json.JSONDecodeError, ValidationError):
        return []
    steps: list[Step] = []
    seen: set[str] = set()
    for planned in plan.steps:
        name = planned.specialist.strip().lower()
        if name not in SPECIALISTS or name in seen:
            continue
        seen.add(name)
        steps.append(Step(name, planned.task.strip()))
    return steps[:MAX_STEPS]


async def plan_steps(llm: LLMProvider, message: str, last_reply: str | None) -> list[Step]:
    """Ask the orchestrator model for the steps. An unusable answer gives no steps."""
    listing = "\n".join(f"- {s.name}: {s.description}" for s in SPECIALISTS.values())
    system = _PROMPT_PATH.read_text(encoding="utf-8").replace("{specialists}", listing).replace("{max_steps}", str(MAX_STEPS))
    content = f"Traveller's message: {message[:1500]}"
    if last_reply:
        content = f"Companion's last message: {last_reply[:500]}\n\n{content}"
    try:
        answer = ""
        async for chunk in llm.stream([{"role": "system", "content": system}, {"role": "user", "content": content}]):
            if isinstance(chunk, Completion):
                answer = chunk.content
    except LLMError as exc:
        logger.warning("orchestrator planning failed: %s", exc)
        return []
    steps = parse_plan(answer)
    if not steps:
        logger.warning("orchestrator gave no usable plan: %r", answer[:200])
    return steps


def step_directive(step: Step, number: int, total: int, message: str) -> str:
    """What the specialist is given as the request for its part of a multi-part message.

    The traveller's own words are included because planner models drop details
    (dates, numbers of people) when they restate a task; they are marked as context
    so the specialist does not answer the other parts.
    """
    earlier = (
        " Earlier parts have been answered above; use what they established (dates, places, choices) and do "
        "not repeat them."
        if number > 1
        else ""
    )
    return (
        f'The traveller wrote: "{message[:1500]}"\n\n'
        f"That message has {total} parts, each handled separately. You handle part {number} only: "
        f"{step.task.rstrip('.')}.{earlier} Take dates, places and the number of people from the traveller's "
        "words above. Do not answer the other parts, and do not hand off."
    )
