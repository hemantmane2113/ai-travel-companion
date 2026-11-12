import asyncio
import time
from datetime import date, timedelta
from typing import Any

import httpx

from app.providers.air.base import AirQualityError, AirQualityProvider, AirReport, DayAir
from app.providers.weather.base import City

AIR_QUALITY_API = "https://air-quality-api.open-meteo.com/v1/air-quality"

FORECAST_HORIZON_DAYS = 4  # today plus four days
HISTORY_STARTS = date(2022, 8, 1)  # the free global dataset has nothing earlier
ARCHIVE_LAG_DAYS = 3
TYPICAL_YEARS = 3
CACHE_SECONDS = 60 * 60


def _shift_year(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # 29 February
        return day.replace(year=day.year - years, day=28)


def daily_from_hourly(data: dict[str, Any], start: date) -> dict[int, tuple[float, float]]:
    """Day offset from `start` -> (peak hourly AQI, mean PM2.5), for days with data."""
    hourly = data.get("hourly") or {}
    by_day: dict[int, tuple[list[float], list[float]]] = {}
    for stamp, aqi, pm in zip(hourly.get("time", []), hourly.get("us_aqi", []), hourly.get("pm2_5", [])):
        offset = (date.fromisoformat(stamp[:10]) - start).days
        aqis, pms = by_day.setdefault(offset, ([], []))
        if aqi is not None:
            aqis.append(aqi)
        if pm is not None:
            pms.append(pm)
    return {
        offset: (max(aqis), sum(pms) / len(pms))
        for offset, (aqis, pms) in by_day.items()
        if aqis and pms
    }


class OpenMeteoAirQualityProvider(AirQualityProvider):
    """Modelled air quality (CAMS) from Open-Meteo: free, no key.

    Values are model estimates for the city area, not readings from a monitoring station.
    """

    def __init__(self, user_agent: str, timeout: float = 15.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})
        self._cache: dict[tuple, tuple[float, AirReport]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _hourly(self, city: City, start: date, end: date) -> dict[str, Any]:
        try:
            response = await self._client.get(
                AIR_QUALITY_API,
                params={
                    "latitude": city.latitude,
                    "longitude": city.longitude,
                    "hourly": "us_aqi,pm2_5",
                    "timezone": "auto",
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                },
            )
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise AirQualityError("The air-quality service did not return data.") from exc

    async def daily(self, city: City, start: date, end: date, today: date) -> AirReport:
        key = (city.latitude, city.longitude, start, end, today)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
        if end <= today + timedelta(days=FORECAST_HORIZON_DAYS):
            report = await self._forecast(city, start, end)
        else:
            report = await self._typical(city, start, end, today)
        self._cache[key] = (time.monotonic(), report)
        return report

    async def _forecast(self, city: City, start: date, end: date) -> AirReport:
        found = daily_from_hourly(await self._hourly(city, start, end), start)
        days = [
            DayAir(start + timedelta(days=offset), round(aqi), round(pm, 1))
            for offset, (aqi, pm) in sorted(found.items())
        ]
        if not days:
            raise AirQualityError("No air-quality forecast is available for these dates.")
        return AirReport(kind="forecast", source="Open-Meteo air-quality forecast (CAMS)", days=days)

    async def _typical(self, city: City, start: date, end: date, today: date) -> AirReport:
        """Average of the same calendar dates over the most recent years that have data."""
        offsets = []
        years_back = 1
        while len(offsets) < TYPICAL_YEARS:
            shifted_start, shifted_end = _shift_year(start, years_back), _shift_year(end, years_back)
            if shifted_start < HISTORY_STARTS:
                break
            if shifted_end <= today - timedelta(days=ARCHIVE_LAG_DAYS):
                offsets.append(years_back)
            years_back += 1
        if not offsets:
            raise AirQualityError("There is no air-quality history for these dates yet.")

        years = await asyncio.gather(
            *(self._hourly(city, _shift_year(start, k), _shift_year(end, k)) for k in offsets)
        )
        per_year = [daily_from_hourly(data, _shift_year(start, k)) for data, k in zip(years, offsets)]
        used = [k for k, found in zip(offsets, per_year) if found]

        days = []
        for offset in range((end - start).days + 1):
            values = [found[offset] for found in per_year if offset in found]
            if not values:
                continue
            days.append(
                DayAir(
                    start + timedelta(days=offset),
                    round(sum(aqi for aqi, _ in values) / len(values)),
                    round(sum(pm for _, pm in values) / len(values), 1),
                )
            )
        if not days:
            raise AirQualityError("There is no air-quality history for these dates yet.")
        first, last = _shift_year(start, max(used)).year, _shift_year(start, min(used)).year
        span = str(first) if first == last else f"{first}–{last}"
        return AirReport(kind="typical", source=f"Open-Meteo air-quality history (CAMS), {span}", days=days)
