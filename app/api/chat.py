import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.companion import CompanionAgent, build_system_prompt
from app.agent.tools import ToolContext
from app.api.deps import current_user, get_db
from app.models import Conversation, Message, User
from app.providers.llm.base import LLMError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

TITLE_LENGTH = 60


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


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


async def _load_history(db: AsyncSession, conversation_id: int, limit: int) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.id.desc())
        .limit(limit)
    )
    history = [_to_llm_message(row) for row in reversed(rows.all())]
    # A truncated window must not open with a tool result or a dangling tool call.
    while history and history[0]["role"] != "user":
        history.pop(0)
    return history


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
        elif row.content:
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
        raise HTTPException(503, "The server has no GROQ_API_KEY configured.")
    await _owned_conversation(db, conversation_id, user)

    return StreamingResponse(
        _run_turn(state, conversation_id, user.id, body.message.strip()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_turn(state, conversation_id: int, user_id: int, text: str) -> AsyncIterator[str]:
    # The request-scoped session is gone by the time the stream runs, so open one here.
    async with state.session_factory() as db:
        conversation = await db.get(Conversation, conversation_id)
        history = await _load_history(db, conversation_id, state.settings.max_history_messages)
        if not history:
            conversation.title = text[:TITLE_LENGTH]
            yield _sse("title", {"id": conversation_id, "title": conversation.title})
        user_message = {"role": "user", "content": text}
        db.add(_to_row(conversation_id, user_message, None))
        await db.commit()

        messages = [{"role": "system", "content": build_system_prompt()}, *history, user_message]
        agent = CompanionAgent(state.llm, state.tools, state.settings.max_agent_steps)
        ctx = ToolContext(db=db, user_id=user_id, conversation_id=conversation_id)

        try:
            async for event in agent.run(messages, ctx):
                if event["type"] == "message":
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
