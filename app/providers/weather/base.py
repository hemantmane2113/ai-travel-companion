from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from typing import Literal


class WeatherError(Exception):
    """The weather source could not be reached or returned something unusable."""


@dataclass(frozen=True)
class City:
    """A destination: a city, or a larger area such as a state when that is what was named."""

    name: str
    region: str | None
    country: str
    country_code: str
    latitude: float
    longitude: float
    radius_km: float = 40.0  # how far from the centre the destination reaches


@dataclass
class DayWeather:
    date: date
    summary: str
    temp_max_c: float
    temp_min_c: float
    precipitation_mm: float
    precipitation_probability: int | None  # only known for a forecast


@dataclass
class WeatherReport:
    # "forecast" is a prediction for the actual dates. "typical" is what those calendar
    # dates were like in recent years, used when the trip is too far off to forecast.
    kind: Literal["forecast", "typical"]
    source: str
    days: list[DayWeather]


class WeatherProvider(ABC):
    @abstractmethod
    async def find_city(self, name: str) -> City | None: ...

    @abstractmethod
    async def daily(self, city: City, start: date, end: date, today: date) -> WeatherReport: ...
