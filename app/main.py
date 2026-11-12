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

from app.agent.travel_tools import Providers, build_tools
from app.api import auth, bookings, chat, table_bookings
from app.api.deps import get_db, optional_user
from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.models import User
from app.providers.air.base import AirQualityProvider
from app.providers.air.open_meteo import OpenMeteoAirQualityProvider
from app.providers.events.base import EventsProvider
from app.providers.events.holidays import HolidayEventsProvider
from app.providers.hotels.base import HotelProvider
from app.providers.maps.base import DestinationFinder, GeocodingProvider, RoutingProvider
from app.providers.maps.nominatim import NominatimGeocoder
from app.providers.sign_in import build_oauth
from app.providers.maps.osrm import OsrmRouter
from app.providers.maps.wikipedia_geocoder import FallbackGeocoder, WikipediaGeocoder
from app.providers.news.base import NewsProvider
from app.providers.news.google_news import GoogleNewsProvider
from app.providers.restaurants.base import RestaurantSearchProvider, TableReservationProvider
from app.providers.restaurants.mock_reservations import MockTableReservations
from app.providers.restaurants.overpass import build_restaurant_provider
from app.providers.weather.base import WeatherProvider
from app.providers.weather.open_meteo import OpenMeteoWeatherProvider
from app.providers.hotels.mock import build_mock_providers
from app.providers.knowledge.base import KnowledgeProvider
from app.providers.knowledge.wikimedia import WikimediaKnowledgeProvider
from app.providers.llm.base import LLMProvider
from app.providers.llm.fallback import FallbackLLMProvider
from app.providers.llm.groq_provider import GroqProvider
from app.providers.llm.openai_compatible import OpenAICompatibleProvider

APP_DIR = Path(__file__).parent
SESSION_MAX_AGE = 60 * 60 * 24 * 14

logger = logging.getLogger(__name__)


def build_llm(settings: Settings) -> LLMProvider | None:
    """The configured model service, or None if its key or model is missing."""
    if settings.llm_provider == "openai_compatible":
        if not (settings.llm_api_key and settings.llm_model and settings.llm_base_url):
            return None
        return OpenAICompatibleProvider(
            settings.llm_base_url, settings.llm_api_key, settings.llm_model, settings.llm_timeout_seconds
        )
    if not settings.groq_api_key:
        return None
    fallbacks = [name.strip() for name in settings.groq_fallback_models.split(",") if name.strip()]
    models = list(dict.fromkeys([settings.groq_model, *fallbacks]))
    if len(models) == 1:
        return GroqProvider(settings.groq_api_key, settings.groq_model, settings.llm_timeout_seconds)
    return FallbackLLMProvider(
        [
            GroqProvider(settings.groq_api_key, model, settings.llm_timeout_seconds, wait_on_rate_limit=False)
            for model in models
        ]
    )


def build_orchestrator_llm(settings: Settings, main_llm: LLMProvider | None) -> LLMProvider | None:
    """The model that plans multi-part messages, falling back to the main model."""
    if not settings.orchestrator_enabled or main_llm is None:
        return None
    if not (settings.orchestrator_base_url and settings.orchestrator_model):
        return main_llm
    own = OpenAICompatibleProvider(
        settings.orchestrator_base_url,
        settings.orchestrator_api_key or "none",
        settings.orchestrator_model,
        settings.orchestrator_timeout_seconds,
        wait_on_rate_limit=False,
    )
    return FallbackLLMProvider([own, main_llm])


class RevalidatedStaticFiles(StaticFiles):
    """Static files the browser must check are current before reusing.

    Without this, browsers guess a cache lifetime and keep running old scripts
    after an update.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(
    settings: Settings | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    llm: LLMProvider | None = None,
    knowledge: KnowledgeProvider | None = None,
    hotel_providers: dict[str, HotelProvider] | None = None,
    weather: WeatherProvider | None = None,
    events: EventsProvider | None = None,
    geocoder: GeocodingProvider | None = None,
    router: RoutingProvider | None = None,
    news: NewsProvider | None = None,
    restaurants: RestaurantSearchProvider | None = None,
    table_reservations: TableReservationProvider | None = None,
    air: AirQualityProvider | None = None,
    orchestrator_llm: LLMProvider | None = None,
    places: DestinationFinder | None = None,
) -> FastAPI:
    """Build the application. Tests pass their own database and providers."""
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    engine = None
    if session_factory is None:
        engine = create_engine(settings.database_url)
        session_factory = create_session_factory(engine)

    if llm is None:
        llm = build_llm(settings)
    if llm is None:
        logger.warning("No model service is configured (%s); chat requests will return 503", settings.llm_provider)
    else:
        logger.info("model service: %s, model: %s", settings.llm_provider, llm.model)
    if orchestrator_llm is None:
        orchestrator_llm = build_orchestrator_llm(settings, llm)
    if orchestrator_llm is not None:
        logger.info("orchestrator model: %s (falls back to the main model)", settings.orchestrator_model)

    # Providers created here hold HTTP clients that must be closed on shutdown.
    owned: list = []

    def default(provider, factory):
        if provider is None:
            provider = factory(settings.http_user_agent)
            owned.append(provider)
        return provider

    knowledge = default(knowledge, WikimediaKnowledgeProvider)
    weather = default(weather, OpenMeteoWeatherProvider)
    events = default(events, HolidayEventsProvider)
    if geocoder is None:
        # One Nominatim client for every lookup, so they share its rate limit. It also
        # resolves destination names ("Kashmir" means the region, not a village of that name).
        nominatim = NominatimGeocoder(settings.http_user_agent, base_url=settings.nominatim_url)
        geocoder = default(None, lambda agent: FallbackGeocoder([nominatim, WikipediaGeocoder(agent)]))
        places = places or nominatim
    router = default(router, lambda agent: OsrmRouter(agent, base_url=settings.osrm_url))
    news = default(news, GoogleNewsProvider)
    restaurants = default(
        restaurants,
        lambda agent: build_restaurant_provider(
            agent,
            overpass_servers=tuple(url.strip() for url in settings.overpass_urls.split(",") if url.strip()),
            nominatim_url=settings.nominatim_url,
        ),
    )
    air = default(air, OpenMeteoAirQualityProvider)
    # Only a simulated reservation service exists so far.
    table_reservations = table_reservations or MockTableReservations()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        for provider in owned:
            await provider.aclose()
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
    app.mount("/static", RevalidatedStaticFiles(directory=APP_DIR / "static"), name="static")

    app.state.settings = settings
    app.state.oauth, app.state.sign_in_providers = build_oauth(settings)
    app.state.session_factory = session_factory
    app.state.llm = llm
    app.state.orchestrator_llm = orchestrator_llm
    # Only simulated providers exist so far; real ones are added as HotelProvider adapters.
    if hotel_providers is None:
        hotel_providers = build_mock_providers(session_factory)
    app.state.hotel_providers = hotel_providers
    app.state.tools = build_tools(
        Providers(
            knowledge=knowledge,
            hotels=hotel_providers,
            weather=weather,
            events=events,
            geocoder=geocoder,
            router=router,
            news=news,
            restaurants=restaurants,
            table_reservations=table_reservations,
            air=air,
            places=places,
        )
    )
    app.state.table_reservations = table_reservations
    app.state.templates = Jinja2Templates(directory=APP_DIR / "templates")

    app.include_router(auth.router)
    app.include_router(chat.router)
    app.include_router(bookings.router)
    app.include_router(table_bookings.router)

    @app.get("/", response_class=HTMLResponse)
    async def home(request: Request, user: User | None = Depends(optional_user)):
        if user is None:
            return RedirectResponse("/login", status_code=303)
        return app.state.templates.TemplateResponse(
            request,
            "chat.html",
            {
                "user": user,
                "map_tiles_url": settings.map_tiles_url,
                "map_tiles_attribution": settings.map_tiles_attribution,
            },
        )

    @app.get("/health")
    async def health(db: AsyncSession = Depends(get_db)):
        try:
            await db.execute(text("SELECT 1"))
        except Exception:
            logger.exception("health check: database unreachable")
            return JSONResponse({"status": "error", "database": "unreachable"}, status_code=503)
        return {"status": "ok", "database": "ok", "llm_configured": app.state.llm is not None}

    return app
