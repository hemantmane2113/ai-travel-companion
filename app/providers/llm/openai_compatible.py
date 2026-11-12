import openai

from app.providers.llm.chat_completions import ChatCompletionsProvider


class OpenAICompatibleProvider(ChatCompletionsProvider):
    """Any service with an OpenAI-style endpoint: Cerebras, OpenRouter, local Ollama, and others.

    Which one is a matter of configuration: the base URL, key and model name.
    """

    def __init__(
        self, base_url: str, api_key: str, model: str, timeout: float = 60.0, wait_on_rate_limit: bool = True
    ):
        client = openai.AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout, max_retries=0)
        # Ask for token counts on the final chunk; they are not sent by default when streaming.
        super().__init__(openai, client, model, {"stream_options": {"include_usage": True}}, wait_on_rate_limit)
