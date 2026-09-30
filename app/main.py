import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from app.agent.tools import ToolRegistry
from app.api import auth, chat
from app.api.deps import get_db, optional_user
from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.models import User
from app.providers.llm.base import LLMProvider
from app.providers.llm.groq_provider import GroqProvider

APP_DIR = Path(__file__).parent
SESSION_MAX_AGE = 60 * 60 * 24 * 14

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    llm: LLMProvider | None = None,
) -> FastAPI:
    """Build the application. Tests pass their own database and LLM."""
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    engine = None
    if session_factory is None:
        engine = create_engine(settings.database_url)
        session_factory = create_session_factory(engine)

    if llm is None and settings.groq_api_key:
        llm = GroqProvider(settings.groq_api_key, settings.groq_model, settings.llm_timeout_seconds)
    if llm is None:
        logger.warning("GROQ_API_KEY is not set; chat requests will return 503")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        if engine is not None:
            await engine.dispose()

    app = FastAPI(title="AI Travel Companion", lifespan=lifespan)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        max_age=SESSION_MAX_AGE,
        same_site="lax",
        https_only=settings.is_production,
    )
    app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")

    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.llm = llm
    app.state.tools = ToolRegistry()
    app.state.templates = Jinja2Templates(directory=APP_DIR / "templates")

    app.include_router(auth.router)
    app.include_router(chat.router)

    @app.get("/", response_class=HTMLResponse)
    async def home(request: Request, user: User | None = Depends(optional_user)):
        if user is None:
            return RedirectResponse("/login", status_code=303)
        return app.state.templates.TemplateResponse(request, "chat.html", {"user": user})

    @app.get("/health")
    async def health(db: AsyncSession = Depends(get_db)):
        try:
            await db.execute(text("SELECT 1"))
        except Exception:
            logger.exception("health check: database unreachable")
            return JSONResponse({"status": "error", "database": "unreachable"}, status_code=503)
        return {"status": "ok", "database": "ok", "llm_configured": app.state.llm is not None}

    return app
