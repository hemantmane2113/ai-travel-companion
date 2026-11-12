import json
from collections.abc import AsyncIterator
from datetime import date, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.config import Settings
from app.db import Base, create_session_factory
from app.main import create_app
from app.providers.air.base import AirQualityError, AirQualityProvider, AirReport, DayAir
from app.providers.events.base import Event, EventsError, EventsProvider
from app.providers.hotels.mock import build_mock_providers
from app.providers.maps.base import GeocodingProvider, GeoPoint, MapsError, RoutingProvider, TravelMatrix
from app.providers.news.base import NewsError, NewsItem, NewsProvider
from app.providers.restaurants.base import (
    Restaurant,
    RestaurantSearchProvider,
    RestaurantsError,
    TableReservationProvider,
)
from app.providers.weather.base import City, DayWeather, WeatherError, WeatherProvider, WeatherReport
from app.services.route_service import haversine_km
from app.providers.knowledge.base import KnowledgeError, KnowledgeProvider, PlaceInfo, TravelGuide
from app.providers.llm.base import Completion, LLMProvider, TextDelta, ToolCall
from sqlalchemy.ext.asyncio import create_async_engine


class FakeLLM(LLMProvider):
    """Replays scripted completions and records what it was sent."""

    model = "fake"

    def __init__(self, script: list[Completion] | None = None):
        self.script = list(script or [])
        self.calls: list[dict[str, Any]] = []

    def queue(self, *completions: Completion) -> None:
        self.script.extend(completions)

    async def stream(self, messages, tools=None) -> AsyncIterator[TextDelta | Completion]:
        self.calls.append({"messages": [dict(m) for m in messages], "tools": tools})
        completion = self.script.pop(0)
        if completion.content:
            yield TextDelta(completion.content)
        yield completion


def say(text: str) -> Completion:
    return Completion(content=text)


def call(name: str, arguments: dict[str, Any], call_id: str = "call_1") -> Completion:
    return Completion(content="", tool_calls=[ToolCall(call_id, name, json.dumps(arguments))])


def sse_events(body: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for frame in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


@pytest.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield create_session_factory(engine)
    await engine.dispose()


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM()


class FakeKnowledge(KnowledgeProvider):
    def __init__(self):
        self.places = {
            "red fort": PlaceInfo(
                "Red Fort",
                "The Red Fort is a Mughal fort in Old Delhi, built by Shah Jahan in 1639.",
                "https://en.wikipedia.org/wiki/Red_Fort",
                "Wikipedia",
            )
        }
        self.guide: TravelGuide | None = TravelGuide(
            "Delhi", "https://en.wikivoyage.org/wiki/Delhi", "Wikivoyage", {"See": "Red Fort, Qutub Minar."}
        )
        self.error: KnowledgeError | None = None

    async def search_places(self, query: str, limit: int = 3) -> list[PlaceInfo]:
        if self.error:
            raise self.error
        return [info for key, info in self.places.items() if key in query.lower()]

    async def travel_guide(self, destination: str) -> TravelGuide | None:
        if self.error:
            raise self.error
        return self.guide


class FakeWeather(WeatherProvider):
    def __init__(self):
        self.city: City | None = City("Delhi", "Delhi", "India", "IN", 28.61, 77.21)
        self.kind = "forecast"
        self.rain_probability = 5
        self.temp_max = 33.0
        self.error: WeatherError | None = None

    async def find_city(self, name: str) -> City | None:
        return self.city

    async def daily(self, city: City, start: date, end: date, today: date) -> WeatherReport:
        if self.error:
            raise self.error
        days = [
            DayWeather(start + timedelta(days=i), "Clear", self.temp_max, 22.0, 0.0, self.rain_probability)
            for i in range((end - start).days + 1)
        ]
        return WeatherReport(self.kind, "Fake forecast", days)


class FakeEvents(EventsProvider):
    coverage = "public holidays only"

    def __init__(self):
        self.listed: list[Event] = []
        self.error: EventsError | None = None

    async def events(self, country_code: str, start: date, end: date) -> list[Event]:
        if self.error:
            raise self.error
        return [event for event in self.listed if start <= event.date <= end]


class FakeGeocoder(GeocodingProvider):
    """Places sit on a north-south line, about 1.1 km apart per 0.01 degree."""

    def __init__(self):
        self.places = {
            "red fort": GeoPoint(28.65, 77.21),
            "jama masjid": GeoPoint(28.66, 77.21),
            "india gate": GeoPoint(28.61, 77.21),
            "humayun's tomb": GeoPoint(28.59, 77.21),
            "qutub minar": GeoPoint(28.52, 77.21),
            "kothrud": GeoPoint(28.60, 77.21),
            "pune": GeoPoint(28.55, 77.21),
        }
        self.queries: list[str] = []
        self.error: MapsError | None = None
        self.area_name: str | None = "Kothrud, Pune"
        self.described: list[GeoPoint] = []

    async def geocode(self, query: str) -> GeoPoint | None:
        self.queries.append(query)
        if self.error:
            raise self.error
        return self.places.get(query.split(",")[0].strip().lower())

    async def describe(self, point: GeoPoint) -> str | None:
        self.described.append(point)
        return self.area_name


class FakeRouter(RoutingProvider):
    def __init__(self):
        self.error: MapsError | None = None

    async def matrix(self, points: list[GeoPoint]) -> TravelMatrix:
        if self.error:
            raise self.error
        km = [[haversine_km(a, b) for b in points] for a in points]
        return TravelMatrix(km, [[value * 3 for value in row] for row in km], "Fake roads")


class FakeNews(NewsProvider):
    def __init__(self):
        self.items: list[NewsItem] = []
        self.error: NewsError | None = None
        self.asked: list[str] = []

    async def disruptions(self, place: str, days: int = 7, limit: int = 6) -> list[NewsItem]:
        self.asked.append(place)
        if self.error:
            raise self.error
        return self.items[:limit]


def eatery(name: str, cuisines: list[str], latitude: float, **extra) -> Restaurant:
    return Restaurant(
        source_id=f"node/{abs(hash(name)) % 10**6}", name=name, cuisines=cuisines, address=extra.pop("address", ""),
        latitude=latitude, longitude=77.21, source="OpenStreetMap",
        source_url="https://www.openstreetmap.org/node/1", **extra,
    )


class FakeRestaurants(RestaurantSearchProvider):
    """A few places north of the fake geocoder's "kothrud", about 1.1 km apart per 0.01 degree."""

    def __init__(self):
        self.places = [
            eatery("Udupi Bhavan", ["south indian"], 28.601),
            eatery("Fish Land", ["indian"], 28.602),
            eatery("Majghar", ["maharashtrian", "konkani"], 28.610, opening_hours="Mo-Su 11:00-23:00", phone="+91 20 0000"),
            eatery("Coastal Kitchen", ["seafood", "goan"], 28.605),
            eatery("Pizza Point", ["pizza"], 28.6005),
        ]
        self.error: RestaurantsError | None = None
        self.asked: list[tuple[GeoPoint, int]] = []

    async def nearby(self, center: GeoPoint, radius_m: int) -> list[Restaurant]:
        self.asked.append((center, radius_m))
        if self.error:
            raise self.error
        return self.places


class FakeReservations(TableReservationProvider):
    name = "TableDemo (demo)"
    is_demo = True

    def __init__(self):
        self.reserved: list[tuple] = []
        self.cancelled: list[str] = []
        self.error: RestaurantsError | None = None

    async def reserve(self, restaurant, day, at, party_size, guest_name) -> str:
        if self.error:
            raise self.error
        self.reserved.append((restaurant.name, day, at, party_size, guest_name))
        return f"TD-{len(self.reserved):04d}"

    async def cancel(self, reference: str) -> None:
        if self.error:
            raise self.error
        self.cancelled.append(reference)


@pytest.fixture
def restaurants() -> FakeRestaurants:
    return FakeRestaurants()


@pytest.fixture
def table_reservations() -> FakeReservations:
    return FakeReservations()


class FakeAir(AirQualityProvider):
    def __init__(self):
        self.peak_aqi = 80
        self.kind = "forecast"
        self.error: AirQualityError | None = None

    async def daily(self, city, start, end, today) -> AirReport:
        if self.error:
            raise self.error
        days = [DayAir(start + timedelta(days=i), self.peak_aqi, 30.0) for i in range((end - start).days + 1)]
        return AirReport(self.kind, "Fake air", days)


@pytest.fixture
def air() -> FakeAir:
    return FakeAir()


@pytest.fixture
def news() -> FakeNews:
    return FakeNews()


@pytest.fixture
def knowledge() -> FakeKnowledge:
    return FakeKnowledge()


@pytest.fixture
def weather() -> FakeWeather:
    return FakeWeather()


@pytest.fixture
def events() -> FakeEvents:
    return FakeEvents()


@pytest.fixture
def geocoder() -> FakeGeocoder:
    return FakeGeocoder()


@pytest.fixture
def router() -> FakeRouter:
    return FakeRouter()


@pytest.fixture
def hotel_providers(session_factory):
    return build_mock_providers(session_factory)


@pytest.fixture
def multi_agent() -> bool:
    """One agent with every tool by default; routing tests override this."""
    return False


@pytest.fixture
def app(
    session_factory, llm, knowledge, hotel_providers, weather, events, geocoder, router, news, multi_agent,
    restaurants, table_reservations, air,
):
    settings = Settings(
        _env_file=None, session_secret="test-secret", database_url="sqlite+aiosqlite://", multi_agent=multi_agent
    )
    return create_app(
        orchestrator_llm=llm,  # tests script every model call on the one fake, never a real server
        air=air,
        news=news,
        restaurants=restaurants,
        table_reservations=table_reservations,
        settings=settings,
        session_factory=session_factory,
        llm=llm,
        knowledge=knowledge,
        hotel_providers=hotel_providers,
        weather=weather,
        events=events,
        geocoder=geocoder,
        router=router,
    )


async def new_conversation(client: httpx.AsyncClient) -> int:
    response = await client.post("/api/conversations")
    assert response.status_code == 201
    return response.json()["id"]


async def chat(client: httpx.AsyncClient, conversation_id: int, text: str) -> list[tuple[str, dict[str, Any]]]:
    response = await client.post(f"/api/conversations/{conversation_id}/chat", json={"message": text})
    assert response.status_code == 200
    return sse_events(response.text)


def tool_results(llm: "FakeLLM") -> list[dict[str, Any]]:
    """Every full tool result the model has been shown, in order, from its latest call.

    Results from earlier turns are replayed as one-line recaps (plain text) and skipped.
    """
    return [
        json.loads(m["content"])
        for m in llm.calls[-1]["messages"]
        if m["role"] == "tool" and m["content"].startswith("{") and not m["content"].endswith("[truncated]")
    ]


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def anon(app):
    async with _client(app) as client:
        yield client


async def _register(client: httpx.AsyncClient, email: str) -> httpx.AsyncClient:
    response = await client.post("/register", data={"email": email, "password": "correct-horse"})
    assert response.status_code == 303
    return client


@pytest.fixture
async def client(app):
    async with _client(app) as client:
        yield await _register(client, "asha@example.com")


@pytest.fixture
async def other_client(app):
    async with _client(app) as client:
        yield await _register(client, "ravi@example.com")
