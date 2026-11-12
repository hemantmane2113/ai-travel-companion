from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from typing import Literal

from app.providers.weather.base import City


class AirQualityError(Exception):
    """The air-quality source could not be reached or has no data for these dates."""


@dataclass
class DayAir:
    date: date
    peak_aqi: int  # highest hourly AQI of the day, US EPA scale
    pm25: float  # daily mean PM2.5, µg/m³


@dataclass
class AirReport:
    # "forecast" is a prediction for the actual dates. "typical" is what those calendar
    # dates were like in recent years, used when the trip is too far off to forecast.
    kind: Literal["forecast", "typical"]
    source: str
    days: list[DayAir]


# US EPA AQI bands. The scale differs from India's CPCB AQI; the label says which is used.
AQI_BANDS = (
    (50, "Good"),
    (100, "Moderate"),
    (150, "Unhealthy for sensitive groups"),
    (200, "Unhealthy"),
    (300, "Very unhealthy"),
)


def aqi_category(aqi: int) -> str:
    for upper, label in AQI_BANDS:
        if aqi <= upper:
            return label
    return "Hazardous"


class AirQualityProvider(ABC):
    @abstractmethod
    async def daily(self, city: City, start: date, end: date, today: date) -> AirReport: ...
