from typing import Any

import groq

from app.providers.llm.chat_completions import ChatCompletionsProvider


def _request_options(model: str) -> dict[str, Any]:
    # Qwen models on Groq write their reasoning into the reply inside <think> tags
    # unless told to keep it out.
    if model.startswith("qwen/"):
        return {"reasoning_format": "hidden"}
    return {}


class GroqProvider(ChatCompletionsProvider):
    def __init__(self, api_key: str, model: str, timeout: float = 60.0, wait_on_rate_limit: bool = True):
        client = groq.AsyncGroq(api_key=api_key, timeout=timeout, max_retries=0)
        super().__init__(groq, client, model, _request_options(model), wait_on_rate_limit)
