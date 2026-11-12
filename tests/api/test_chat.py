from app.main import create_app
from app.config import Settings
from app.providers.llm.base import LLMError
from tests.conftest import say, sse_events

import httpx


async def _new_conversation(client) -> int:
    response = await client.post("/api/conversations")
    assert response.status_code == 201
    return response.json()["id"]


async def test_chat_streams_reply_and_stores_transcript(client, llm):
    llm.queue(say("Try the parathas at Paranthe Wali Gali."))
    conversation_id = await _new_conversation(client)

    response = await client.post(
        f"/api/conversations/{conversation_id}/chat", json={"message": "What should I eat in Chandni Chowk?"}
    )

    assert response.status_code == 200
    events = sse_events(response.text)
    assert ("text", {"delta": "Try the parathas at Paranthe Wali Gali."}) in events
    assert events[0] == ("title", {"id": conversation_id, "title": "What should I eat in Chandni Chowk?"})
    assert events[-1] == ("done", {})

    messages = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert messages == [
        {"role": "user", "content": "What should I eat in Chandni Chowk?"},
        {"role": "assistant", "content": "Try the parathas at Paranthe Wali Gali."},
    ]
    assert (await client.get("/api/conversations")).json()[0]["title"] == "What should I eat in Chandni Chowk?"


async def test_second_turn_sends_history_to_the_model(client, llm):
    llm.queue(say("Four days is a good length."), say("October to March."))
    conversation_id = await _new_conversation(client)
    await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": "How long for Delhi?"})
    await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": "Best season?"})

    sent = llm.calls[1]["messages"]
    assert sent[0]["role"] == "system"
    assert [(m["role"], m["content"]) for m in sent[1:]] == [
        ("user", "How long for Delhi?"),
        ("assistant", "Four days is a good length."),
        ("user", "Best season?"),
    ]


async def test_history_is_trimmed_to_the_character_budget(client, llm, app):
    app.state.settings.history_char_budget = 300
    conversation_id = await _new_conversation(client)
    for index in range(4):
        llm.queue(say(f"Answer {index} " + "x" * 80))
        await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": f"Question {index}"})

    sent = llm.calls[-1]["messages"]
    # Oldest turns are dropped whole, and the window still opens on a user message.
    assert [m["content"] for m in sent if m["role"] == "user"] == ["Question 2", "Question 3"]
    assert sent[1] == {"role": "user", "content": "Question 2"}


async def test_cannot_read_or_post_to_another_users_conversation(client, other_client, llm):
    conversation_id = await _new_conversation(client)

    assert (await other_client.get(f"/api/conversations/{conversation_id}/messages")).status_code == 404
    response = await other_client.post(f"/api/conversations/{conversation_id}/chat", json={"message": "hi"})
    assert response.status_code == 404
    assert llm.calls == []
    assert (await other_client.get("/api/conversations")).json() == []


async def test_empty_message_is_rejected(client):
    conversation_id = await _new_conversation(client)
    response = await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": ""})
    assert response.status_code == 422


async def test_llm_failure_is_reported_not_hidden(client, llm):
    async def failing_stream(messages, tools=None):
        raise LLMError("The AI service is rate limited right now. Try again in a minute.")
        yield  # pragma: no cover

    llm.stream = failing_stream
    conversation_id = await _new_conversation(client)

    response = await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": "hello"})

    events = sse_events(response.text)
    assert ("error", {"message": "The AI service is rate limited right now. Try again in a minute."}) in events
    messages = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert messages == [{"role": "user", "content": "hello"}]


async def test_chat_returns_503_without_llm_key(session_factory):
    settings = Settings(_env_file=None, session_secret="test-secret", groq_api_key="")
    app = create_app(settings=settings, session_factory=session_factory, llm=None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/register", data={"email": "asha@example.com", "password": "correct-horse"})
        conversation_id = (await client.post("/api/conversations")).json()["id"]
        response = await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": "hello"})
    assert response.status_code == 503
