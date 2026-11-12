import asyncio
import time
from datetime import date, timedelta
from typing import Any

import httpx

from app.providers.weather.base import City, DayWeather, WeatherError, WeatherProvider, WeatherReport

GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_API = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"

FORECAST_HORIZON_DAYS = 15
ARCHIVE_LAG_DAYS = 7  # the archive trails the present by a few days
TYPICAL_YEARS = 3
CACHE_SECONDS = 60 * 60

# WMO weather interpretation codes, grouped.
_WMO = {
    0: "Clear",
    1: "Mostly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Violent rain showers",
    85: "Snow showers",
    86: "Snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with hail",
}


def _typical_summary(precipitation_mm: float) -> str:
    if precipitation_mm < 1:
        return "Usually dry"
    if precipitation_mm < 8:
        return "Some rain is usual"
    return "Usually wet"


def _shift_year(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # 29 February
        return day.replace(year=day.year - years, day=28)


class OpenMeteoWeatherProvider(WeatherProvider):
    def __init__(self, user_agent: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})
        self._cache: dict[tuple, tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WeatherError("The weather service did not return data.") from exc

    async def find_city(self, name: str) -> City | None:
        key = ("city", name.lower())
        if key in self._cache:
            return self._cache[key][1]
        data = await self._get(GEOCODING_API, {"name": name, "count": 1})
        results = data.get("results") or []
        city = None
        if results:
            hit = results[0]
            city = City(
                name=hit["name"],
                region=hit.get("admin1"),
                country=hit.get("country", ""),
                country_code=hit.get("country_code", ""),
                latitude=hit["latitude"],
                longitude=hit["longitude"],
            )
        self._cache[key] = (time.monotonic(), city)
        return city

    async def daily(self, city: City, start: date, end: date, today: date) -> WeatherReport:
        key = ("daily", city.latitude, city.longitude, start, end, today)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
        if end <= today + timedelta(days=FORECAST_HORIZON_DAYS):
            report = await self._forecast(city, start, end)
        else:
            report = await self._typical(city, start, end, today)
        self._cache[key] = (time.monotonic(), report)
        return report

    async def _forecast(self, city: City, start: date, end: date) -> WeatherReport:
        data = await self._get(
            FORECAST_API,
            {
                "latitude": city.latitude,
                "longitude": city.longitude,
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
                "timezone": "auto",
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
            },
        )
        try:
            daily = data["daily"]
            days = [
                DayWeather(
                    date=date.fromisoformat(day),
                    summary=_WMO.get(daily["weather_code"][i], "Mixed conditions"),
                    temp_max_c=daily["temperature_2m_max"][i],
                    temp_min_c=daily["temperature_2m_min"][i],
                    precipitation_mm=daily["precipitation_sum"][i] or 0.0,
                    precipitation_probability=daily["precipitation_probability_max"][i],
                )
                for i, day in enumerate(daily["time"])
            ]
        except (KeyError, IndexError, TypeError) as exc:
            raise WeatherError("The weather service returned an unexpected response.") from exc
        return WeatherReport(kind="forecast", source="Open-Meteo forecast", days=days)

    async def _typical(self, city: City, start: date, end: date, today: date) -> WeatherReport:
        """Average of the same calendar dates over the most recent complete years."""
        first = 1
        while _shift_year(end, first) > today - timedelta(days=ARCHIVE_LAG_DAYS):
            first += 1
        offsets = range(first, first + TYPICAL_YEARS)
        years = await asyncio.gather(
            *(
                self._get(
                    ARCHIVE_API,
                    {
                        "latitude": city.latitude,
                        "longitude": city.longitude,
                        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
                        "timezone": "auto",
                        "start_date": _shift_year(start, offset).isoformat(),
                        "end_date": _shift_year(end, offset).isoformat(),
                    },
                )
                for offset in offsets
            )
        )
        length = (end - start).days + 1

        def mean(field: str, index: int) -> float:
            values = [
                year["daily"][field][index]
                for year in years
                if index < len(year.get("daily", {}).get(field, [])) and year["daily"][field][index] is not None
            ]
            if not values:
                raise WeatherError("The weather archive has no data for these dates.")
            return round(sum(values) / len(values), 1)

        days = []
        for index in range(length):
            rain = mean("precipitation_sum", index)
            days.append(
                DayWeather(
                    date=start + timedelta(days=index),
                    summary=_typical_summary(rain),
                    temp_max_c=mean("temperature_2m_max", index),
                    temp_min_c=mean("temperature_2m_min", index),
                    precipitation_mm=rain,
                    precipitation_probability=None,
                )
            )
        span = f"{_shift_year(start, offsets[-1]).year}–{_shift_year(start, offsets[0]).year}"
        return WeatherReport(kind="typical", source=f"Open-Meteo historical average, {span}", days=days)
