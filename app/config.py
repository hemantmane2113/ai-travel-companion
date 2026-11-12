from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    database_url: str = "sqlite+aiosqlite:///./travel.db"
    session_secret: str

    # Which model service to use. "groq" reads the GROQ_* settings; "openai_compatible"
    # reads the LLM_* settings and works with any OpenAI-style endpoint (Cerebras,
    # OpenRouter, a local Ollama, ...).
    llm_provider: Literal["groq", "openai_compatible"] = "groq"

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    # Comma-separated models to use, in order, while GROQ_MODEL is rate limited or out of
    # its daily allowance. Groq counts both limits per model. Empty turns fallback off.
    groq_fallback_models: str = "openai/gpt-oss-20b,qwen/qwen3.8-27b"

    llm_base_url: str = "https://api.cerebras.ai/v1"
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: float = 60.0

    # Wikimedia and OpenStreetMap ask API clients to identify themselves.
    http_user_agent: str = "AITravelCompanion/0.1 (local development)"

    # True: a supervisor step routes each message to a specialist (guide, trip planner,
    # hotels) that carries only its own tools. False: one agent carries everything.
    multi_agent: bool = True

    # The orchestrator splits messages that need several specialists into steps. It can
    # use a different model from the rest (any OpenAI-style endpoint: a local Ollama
    # now, OpenAI later); if that model fails or is too slow, the main model plans.
    orchestrator_enabled: bool = True
    orchestrator_base_url: str = "http://localhost:11434/v1"
    orchestrator_api_key: str = "ollama"  # Ollama ignores it; OpenAI needs a real key
    orchestrator_model: str = "llama3.2:3b"
    orchestrator_timeout_seconds: float = 180.0

    # Sign in with Google / GitHub. Each button appears only when both its values are set.
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""
    # The address people reach the app at, for sign-in callbacks. Empty: taken from
    # each request, which is right for localhost. Set it behind a proxy or domain.
    public_base_url: str = ""

    # OpenStreetMap services. The public servers suit one person testing; their usage
    # policies forbid app-scale traffic, so a public launch points these at hosted or
    # self-hosted servers. Nothing else changes.
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    osrm_url: str = "https://router.project-osrm.org"
    overpass_urls: str = (
        "https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter"
    )
    map_tiles_url: str = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    map_tiles_attribution: str = "© OpenStreetMap contributors"

    max_history_messages: int = 40
    # Tool results from earlier turns are cut to this length when replayed to the model.
    history_tool_result_chars: int = 700
    # Upper bound on replayed history, in characters (roughly four per token).
    history_char_budget: int = 7000
    max_agent_steps: int = 12

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
