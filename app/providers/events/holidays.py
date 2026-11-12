import time
from datetime import date, datetime
from typing import Any

import httpx

from app.providers.events.base import Event, EventsError, EventsProvider, EventsUnsupported

NAGER_API = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"
# Countries Nager.Date does not cover, served from Google's public holiday calendars.
GOOGLE_CALENDARS = {
    "IN": "https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics",
}
CACHE_SECONDS = 24 * 60 * 60


def parse_ics(text: str) -> list[dict[str, str]]:
    """Events of an iCalendar file as dicts of their properties (name before any ';')."""
    unfolded = text.replace("\r\n", "\n").replace("\n ", "")
    events: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in unfolded.split("\n"):
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            name, value = line.split(":", 1)
            current[name.split(";", 1)[0]] = value.replace("\\n", "\n").replace("\\,", ",")
    return events


class HolidayEventsProvider(EventsProvider):
    """Public holidays and festivals from open calendars.

    It knows nothing about strikes, rallies, concerts, sports fixtures or local closures.
    """

    coverage = (
        "national public holidays and major festivals only; strikes, rallies, concerts, "
        "sports events and local closures are not covered"
    )

    def __init__(self, user_agent: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": user_agent}, follow_redirects=True
        )
        self._cache: dict[tuple[str, int], tuple[float, list[Event]]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, url: str) -> httpx.Response:
        try:
            response = await self._client.get(url)
            response.raise_for_status()
            return response
        except httpx.HTTPError as exc:
            raise EventsError("The holiday calendar could not be reached.") from exc

    async def _nager(self, country_code: str, year: int) -> list[Event] | None:
        response = await self._get(NAGER_API.format(year=year, country=country_code))
        if response.status_code == 204:  # country not covered
            return None
        try:
            rows: list[dict[str, Any]] = response.json()
            return [
                Event(date.fromisoformat(row["date"]), row["name"], "public holiday", "Nager.Date") for row in rows
            ]
        except (ValueError, KeyError, TypeError) as exc:
            raise EventsError("The holiday calendar returned an unexpected response.") from exc

    async def _google(self, country_code: str, year: int) -> list[Event]:
        response = await self._get(GOOGLE_CALENDARS[country_code])
        events = []
        for entry in parse_ics(response.text):
            try:
                day = datetime.strptime(entry["DTSTART"], "%Y%m%d").date()
                name = entry["SUMMARY"]
            except (KeyError, ValueError):
                continue
            if day.year != year:
                continue
            public = entry.get("DESCRIPTION", "").lower().startswith("public holiday")
            events.append(Event(day, name, "public holiday" if public else "observance", "Google public holiday calendar"))
        return events

    async def _year(self, country_code: str, year: int) -> list[Event]:
        key = (country_code, year)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
        events = await self._nager(country_code, year)
        if events is None:
            if country_code not in GOOGLE_CALENDARS:
                raise EventsUnsupported(f"No holiday calendar is available for country {country_code}.")
            events = await self._google(country_code, year)
        self._cache[key] = (time.monotonic(), events)
        return events

    async def events(self, country_code: str, start: date, end: date) -> list[Event]:
        country_code = country_code.upper()
        found: list[Event] = []
        for year in range(start.year, end.year + 1):
            found.extend(await self._year(country_code, year))
        return sorted((event for event in found if start <= event.date <= end), key=lambda e: (e.date, e.name))
