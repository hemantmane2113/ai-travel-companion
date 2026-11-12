import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.companion import CompanionAgent
from app.agent.orchestrator import Step, plan_steps, step_directive
from app.agent.specialists import (
    DEFAULT_SPECIALIST,
    GENERALIST,
    MULTI,
    SPECIALISTS,
    Specialist,
    choose_specialist,
)
from app.agent.tools import ToolContext, ToolRegistry
from app.agent.travel_tools import available_tools
from app.api.deps import current_user, get_db
from app.models import Conversation, Message, User
from app.providers.llm.base import LLMError
from app.schemas.client import ClientInfo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

TITLE_LENGTH = 60


def _title(text: str) -> str:
    """The first message as a title, cut at a whole word."""
    text = " ".join(text.split())
    if len(text) <= TITLE_LENGTH:
        return text
    cut = text[: TITLE_LENGTH - 1].rsplit(" ", 1)[0].rstrip(",.;:-")
    return cut + "…"


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    client: ClientInfo = Field(default_factory=ClientInfo)


async def _owned_conversation(db: AsyncSession, conversation_id: int, user: User) -> Conversation:
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(404, "Conversation not found.")
    return conversation


def _to_row(conversation_id: int, message: dict[str, Any], card: dict[str, Any] | None) -> Message:
    meta: dict[str, Any] = {}
    if message.get("tool_calls"):
        meta["tool_calls"] = message["tool_calls"]
    if message["role"] == "tool":
        meta["tool_call_id"] = message["tool_call_id"]
        meta["name"] = message["name"]
    if card:
        meta["card"] = card
    return Message(
        conversation_id=conversation_id,
        role=message["role"],
        content=message.get("content") or "",
        meta=meta or None,
    )


def _to_llm_message(row: Message) -> dict[str, Any]:
    meta = row.meta or {}
    message: dict[str, Any] = {"role": row.role, "content": row.content}
    if row.role == "assistant" and meta.get("tool_calls"):
        message["tool_calls"] = meta["tool_calls"]
    if row.role == "tool":
        message["tool_call_id"] = meta["tool_call_id"]
        message["name"] = meta["name"]
    return message


async def _load_history(
    db: AsyncSession,
    conversation_id: int,
    limit: int,
    tools: ToolRegistry,
    tool_result_chars: int,
    char_budget: int,
) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.id.desc())
        .limit(limit)
    )
    history = [_to_llm_message(row) for row in reversed(rows.all())]
    # The model already acted on these results. Later turns get a one-line recap
    # written in code; the saved trip itself reaches the model through the trip note.
    for message in history:
        if message["role"] != "tool":
            continue
        if (recap := tools.recap(message["name"], message["content"])) is not None:
            message["content"] = recap
        elif tools.is_bulky_reference(message["name"]) and len(message["content"]) > tool_result_chars:
            message["content"] = message["content"][:tool_result_chars] + "… [truncated]"

    # Whole turns only, each opening with the traveller's message: a window must not
    # open with a tool result or a dangling tool call.
    turns: list[list[dict[str, Any]]] = []
    for message in history:
        if message["role"] == "user":
            turns.append([message])
        elif turns:
            turns[-1].append(message)
    # Keep the newest turns that fit the budget (the model's rate limit is per request),
    # and always the latest one, so the conversation is never cut to nothing.
    kept: list[list[dict[str, Any]]] = []
    used = 0
    for turn in reversed(turns):
        used += sum(len(json.dumps(message, ensure_ascii=False)) for message in turn)
        if kept and used > char_budget:
            break
        kept.append(turn)
    return [message for turn in reversed(kept) for message in turn]


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get("/conversations")
async def list_conversations(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(
        select(Conversation).where(Conversation.user_id == user.id).order_by(Conversation.id.desc())
    )
    return [{"id": row.id, "title": row.title} for row in rows]


@router.post("/conversations", status_code=201)
async def create_conversation(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    conversation = Conversation(user_id=user.id)
    db.add(conversation)
    await db.commit()
    return {"id": conversation.id, "title": conversation.title}


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    await _owned_conversation(db, conversation_id, user)
    rows = await db.scalars(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.id)
    )
    visible = []
    for row in rows:
        card = (row.meta or {}).get("card")
        if row.role == "tool":
            if card:
                visible.append({"role": "card", "card": card})
        elif row.role in ("user", "assistant") and row.content:
            visible.append({"role": row.role, "content": row.content})
    return visible


@router.post("/conversations/{conversation_id}/chat")
async def chat(
    conversation_id: int,
    body: ChatRequest,
    request: Request,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    state = request.app.state
    if state.llm is None:
        raise HTTPException(503, "The server has no AI model service configured. Set its key in .env and restart.")
    await _owned_conversation(db, conversation_id, user)

    return StreamingResponse(
        _run_turn(state, conversation_id, user.id, body.message.strip(), body.client),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_turn(
    state, conversation_id: int, user_id: int, text: str, client: ClientInfo | None = None
) -> AsyncIterator[str]:
    client = client or ClientInfo()
    # The request-scoped session is gone by the time the stream runs, so open one here.
    async with state.session_factory() as db:
        conversation = await db.get(Conversation, conversation_id)
        history = await _load_history(
            db,
            conversation_id,
            state.settings.max_history_messages,
            state.tools,
            state.settings.history_tool_result_chars,
            state.settings.history_char_budget,
        )
        is_new = await db.scalar(select(Message.id).where(Message.conversation_id == conversation_id).limit(1)) is None
        if is_new:
            conversation.title = _title(text)
            yield _sse("title", {"id": conversation_id, "title": conversation.title})
        user_message = {"role": "user", "content": text}
        db.add(_to_row(conversation_id, user_message, None))
        await db.commit()

        messages = [*history, user_message]
        agent = CompanionAgent(
            state.llm,
            state.tools,
            state.settings.max_agent_steps,
            select_tools=available_tools,
            consumed_result_chars=state.settings.history_tool_result_chars,
        )
        ctx = ToolContext(
            db=db, user_id=user_id, conversation_id=conversation_id, today=client.today(), location=client.location
        )

        try:
            # Who handles the message: one specialist (most messages), or an ordered
            # list of them when the message asks for several things at once.
            parts: list[tuple[Specialist, str | None]] = [(GENERALIST, None)]
            if state.settings.multi_agent:
                last_reply = next(
                    (m["content"] for m in reversed(history) if m["role"] == "assistant" and m["content"]), None
                )
                orchestrator = state.orchestrator_llm
                chosen = await choose_specialist(
                    state.llm,
                    text,
                    last_reply,
                    conversation.last_agent,
                    allow_multi=orchestrator is not None,
                    trip_note=await state.tools.trip_note(ctx),
                )
                if chosen == MULTI:
                    yield _sse("status", {"text": "Working out the steps…"})
                    steps = await plan_steps(orchestrator, text, last_reply)
                    if not steps:
                        steps = [Step(conversation.last_agent or DEFAULT_SPECIALIST, text)]
                    parts = [
                        (
                            SPECIALISTS[step.specialist],
                            step_directive(step, number, len(steps), text) if len(steps) > 1 else None,
                        )
                        for number, step in enumerate(steps, start=1)
                    ]
                    logger.info(
                        "orchestrated conversation=%s steps=%s", conversation_id, [s.specialist for s in steps]
                    )
                else:
                    parts = [(SPECIALISTS[chosen], None)]
                    logger.info("routed conversation=%s to %s", conversation_id, chosen)

            answered: list[dict] = []  # what earlier parts of this message produced
            for number, (specialist, directive) in enumerate(parts, start=1):
                conversation.last_agent = specialist.name if specialist.name in SPECIALISTS else None
                if directive:
                    yield _sse("status", {"text": f"Part {number} of {len(parts)}: {specialist.title}…"})
                    # Kept in the transcript (hidden from the traveller) so later turns
                    # see why each part was answered the way it was.
                    db.add(_to_row(conversation_id, {"role": "system", "content": directive}, None))
                    # The specialist is given only its own part as the request. Shown the
                    # whole message, models tend to answer all of it, including the parts
                    # that belong to other specialists.
                    turn = [*history, *answered, {"role": "user", "content": directive}]
                else:
                    turn = messages
                await db.commit()

                async for event in agent.run(turn, ctx, specialist, allow_hand_off=directive is None):
                    if event["type"] == "specialist":
                        conversation.last_agent = event["name"]
                        await db.commit()
                    elif event["type"] == "message":
                        answered.append(event["message"])
                        # Stored as each step finishes, so a later failure keeps earlier work.
                        db.add(_to_row(conversation_id, event["message"], event["card"]))
                        await db.commit()
                        if event["card"]:
                            yield _sse("card", event["card"])
                    elif event["type"] == "text":
                        yield _sse("text", {"delta": event["delta"]})
                    else:
                        yield _sse("status", {"text": event["text"]})
        except LLMError as exc:
            logger.warning("llm error conversation=%s: %s", conversation_id, exc)
            yield _sse("error", {"message": str(exc)})
        except Exception:
            logger.exception("chat turn failed conversation=%s", conversation_id)
            yield _sse("error", {"message": "Something went wrong on the server. Try again."})
        yield _sse("done", {})
