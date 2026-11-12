"""Weather, air quality and dated events for a destination, and what in them deserves a warning."""

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from app.providers.air.base import AirQualityError, AirQualityProvider, AirReport, DayAir, aqi_category
from app.providers.events.base import Event, EventsError, EventsProvider, EventsUnsupported
from app.providers.maps.base import DestinationFinder, MapsError
from app.providers.news.base import NewsError, NewsItem, NewsProvider
from app.providers.weather.base import City, DayWeather, WeatherError, WeatherProvider, WeatherReport

logger = logging.getLogger(__name__)

HEAVY_RAIN_MM = 10.0
LIKELY_RAIN_PERCENT = 60
VERY_HOT_C = 38.0
FREEZING_C = 0.0
NEWS_LOOKAHEAD_DAYS = 14
UNHEALTHY_AQI = 151  # US EPA: unhealthy for everyone from here
SENSITIVE_AQI = 101  # unhealthy for sensitive groups


class ConditionsError(Exception):
    """Conditions cannot be looked up at all. The message explains why."""


@dataclass
class Conditions:
    city: City
    weather: WeatherReport | None
    events: list[Event] | None  # None = could not be determined, which is not "no events"
    events_coverage: str
    # Recent headlines about disruptions. None = not looked up (trip too far ahead for
    # today's news to matter, or the source failed), which is not "nothing reported".
    news: list[NewsItem] | None = None
    air: AirReport | None = None
    problems: list[str] = field(default_factory=list)


def place_label(city: City) -> str:
    return ", ".join(part for part in (city.name, city.region, city.country) if part)


async def get_conditions(
    weather: WeatherProvider,
    events: EventsProvider,
    destination: str,
    start: date,
    end: date,
    today: date,
    news: NewsProvider | None = None,
    air: AirQualityProvider | None = None,
    places: DestinationFinder | None = None,
) -> Conditions:
    try:
        city = await places.find_destination(destination) if places else await weather.find_city(destination)
    except (WeatherError, MapsError) as exc:
        raise ConditionsError(f"{exc} Weather and events could not be checked.") from exc
    if city is None:
        raise ConditionsError(f"Could not find a place called '{destination}' to check weather and events for.")

    conditions = Conditions(city=city, weather=None, events=None, events_coverage=events.coverage)
    # One source failing should not hide what the others know.
    try:
        conditions.weather = await weather.daily(city, start, end, today)
    except WeatherError as exc:
        logger.warning("weather lookup failed: %s", exc)
        conditions.problems.append(f"Weather could not be retrieved: {exc}")
    try:
        conditions.events = await events.events(city.country_code, start, end)
    except EventsUnsupported as exc:
        conditions.problems.append(f"Holidays and events could not be checked: {exc}")
    except EventsError as exc:
        logger.warning("events lookup failed: %s", exc)
        conditions.problems.append(f"Holidays and events could not be checked: {exc}")
    # This week's headlines say nothing about a trip months away.
    if news is not None and start <= today + timedelta(days=NEWS_LOOKAHEAD_DAYS) and end >= today:
        try:
            conditions.news = await news.disruptions(city.name)
        except NewsError as exc:
            logger.warning("news lookup failed: %s", exc)
            conditions.problems.append(f"Local news could not be checked: {exc}")
    if air is not None:
        try:
            conditions.air = await air.daily(city, start, end, today)
        except AirQualityError as exc:
            logger.warning("air quality lookup failed: %s", exc)
            conditions.problems.append(f"Air quality could not be checked: {exc}")
    return conditions


NEWS_NOTE = (
    "Recent headlines that mention the place and a possible disruption. They are unverified and many will "
    "not matter to a visitor. Pass on only those that could affect the trip, naming the publication and date. "
    "The traveller is shown the links separately. This search is not exhaustive."
)


def news_for_model(items: list[NewsItem]) -> list[str]:
    # Links are left out: they are long, and the traveller gets them on the card.
    return [f"{item.published.date().isoformat()} {item.source}: {item.title}" for item in items]


def news_card(place: str, items: list[NewsItem]) -> dict[str, Any]:
    return {"type": "news", "place": place, "items": [_news_view(item) for item in items]}


def _news_view(item: NewsItem) -> dict[str, str]:
    return {
        "headline": item.title,
        "source": item.source,
        "date": item.published.date().isoformat(),
        "url": item.url,
    }


def _weather_line(day: DayWeather) -> str:
    line = f"{day.summary}, {round(day.temp_min_c)}–{round(day.temp_max_c)}°C"
    if day.precipitation_probability is not None:
        line += f", rain chance {day.precipitation_probability}%"
    elif day.precipitation_mm >= 1:
        line += f", about {round(day.precipitation_mm)} mm of rain"
    return line


def _air_line(day: DayAir) -> str:
    return f"US AQI peak {day.peak_aqi} ({aqi_category(day.peak_aqi)}), PM2.5 about {round(day.pm25)} µg/m³"


def _date_runs(days: list[date]) -> list[tuple[date, date]]:
    """Consecutive dates grouped into (first, last) runs."""
    runs: list[tuple[date, date]] = []
    for day in sorted(days):
        if runs and day - runs[-1][1] == timedelta(days=1):
            runs[-1] = (runs[-1][0], day)
        else:
            runs.append((day, day))
    return runs


def _label(day: date) -> str:
    return f"{day.day} {day.strftime('%b')}"


def _span(first: date, last: date) -> str:
    if first == last:
        return _label(first)
    if first.month == last.month:
        return f"{first.day}–{_label(last)}"
    return f"{_label(first)}–{_label(last)}"


def alerts(conditions: Conditions) -> list[str]:
    """Warnings decided by fixed thresholds, not by the model.

    The same warning on consecutive days is given once for the whole run of days
    ("1–15 Dec: ..."), with the worst value in it, so a long trip is not a wall of
    repeated lines.
    """
    # kind -> (date -> value), where value is what the message reports for that day
    flagged: dict[str, dict[date, float]] = {}

    def flag(kind: str, day: date, value: float) -> None:
        flagged.setdefault(kind, {})[day] = value

    typical_weather = bool(conditions.weather and conditions.weather.kind == "typical")
    if conditions.weather:
        for day in conditions.weather.days:
            if day.precipitation_mm >= HEAVY_RAIN_MM or (day.precipitation_probability or 0) >= LIKELY_RAIN_PERCENT:
                flag("wet", day.date, day.precipitation_mm)
            if day.temp_max_c >= VERY_HOT_C:
                flag("hot", day.date, day.temp_max_c)
            if day.temp_min_c <= FREEZING_C:
                flag("freezing", day.date, day.temp_min_c)
    usually = "is usually" if conditions.air and conditions.air.kind == "typical" else "is forecast to be"
    if conditions.air:
        for day in conditions.air.days:
            if day.peak_aqi >= UNHEALTHY_AQI:
                flag("air_unhealthy", day.date, day.peak_aqi)
            elif day.peak_aqi >= SENSITIVE_AQI:
                flag("air_sensitive", day.date, day.peak_aqi)

    def message(kind: str, span: str, values: list[float]) -> str:
        if kind == "wet":
            if typical_weather:
                return f"{span}: these dates are usually wet (up to about {round(max(values))} mm a day)."
            return f"{span}: rain is likely. Plan indoor stops or carry rain gear."
        if kind == "hot":
            return f"{span}: very hot, up to {round(max(values))}°C. Avoid outdoor stops around midday."
        if kind == "freezing":
            return f"{span}: freezing, down to {round(min(values))}°C. Pack warm layers."
        if kind == "air_unhealthy":
            return (
                f"{span}: air quality {usually} unhealthy (US AQI up to {round(max(values))}). Keep long outdoor "
                "stops short, prefer indoor sights at the worst times, and consider an N95 mask."
            )
        return (
            f"{span}: air quality {usually} unhealthy for sensitive groups (US AQI up to {round(max(values))}). "
            "Children, older travellers and anyone with asthma or heart conditions should limit time outdoors."
        )

    found: list[tuple[date, str]] = []
    for kind, by_day in flagged.items():
        for first, last in _date_runs(list(by_day)):
            values = [value for day, value in by_day.items() if first <= day <= last]
            found.append((first, message(kind, _span(first, last), values)))
    for event in conditions.events or []:
        if event.kind == "public holiday":
            found.append(
                (
                    event.date,
                    f"{_label(event.date)}: {event.name} is a public holiday. Museums, government-run "
                    "sites, banks and some shops may be closed and popular places crowded; check opening hours.",
                )
            )
    # Date order; on the same date, the order the checks were made in.
    return [text for _, text in sorted(found, key=lambda entry: entry[0])]


def for_model(conditions: Conditions) -> dict[str, Any]:
    data: dict[str, Any] = {
        "place": place_label(conditions.city),
        "place_check": (
            "Every figure below is for this place. If it is not where the traveller is going (wrong state or "
            "country), do not report the figures: say so and ask for the nearest city."
        ),
    }
    if conditions.weather:
        report = conditions.weather
        data["weather_kind"] = (
            "forecast for these dates"
            if report.kind == "forecast"
            else "NOT a forecast: the trip is too far ahead, so this is the average for these dates in recent years"
        )
        data["weather_source"] = report.source
        data["weather"] = [f"{day.date.isoformat()}: {_weather_line(day)}" for day in report.days]
    if conditions.air:
        data["air_quality_kind"] = (
            "forecast for these dates"
            if conditions.air.kind == "forecast"
            else "NOT a forecast: the average for these dates in recent years"
        )
        data["air_quality_source"] = f"{conditions.air.source}; modelled values on the US EPA AQI scale"
        data["air_quality"] = [f"{day.date.isoformat()}: {_air_line(day)}" for day in conditions.air.days]
    if conditions.events is not None:
        data["events"] = [f"{event.date.isoformat()}: {event.name} ({event.kind})" for event in conditions.events]
        data["events_coverage"] = conditions.events_coverage
    data["alerts"] = alerts(conditions)
    if conditions.news is not None:
        data["news"] = news_for_model(conditions.news)
        data["news_note"] = NEWS_NOTE
    if conditions.problems:
        data["could_not_check"] = conditions.problems
    return data


def for_card(conditions: Conditions) -> dict[str, Any]:
    """Conditions keyed by ISO date, for drawing next to each itinerary day."""
    days: dict[str, dict[str, Any]] = {}
    if conditions.weather:
        for day in conditions.weather.days:
            days.setdefault(day.date.isoformat(), {})["weather"] = {
                "summary": day.summary,
                "temp_max_c": round(day.temp_max_c),
                "temp_min_c": round(day.temp_min_c),
                "precipitation_mm": round(day.precipitation_mm, 1),
                "precipitation_probability": day.precipitation_probability,
            }
    if conditions.air:
        for day in conditions.air.days:
            days.setdefault(day.date.isoformat(), {})["air"] = {
                "peak_aqi": day.peak_aqi,
                "category": aqi_category(day.peak_aqi),
                "pm25": day.pm25,
            }
    for event in conditions.events or []:
        days.setdefault(event.date.isoformat(), {}).setdefault("events", []).append(
            {"name": event.name, "kind": event.kind}
        )
    return {
        "place": place_label(conditions.city),
        "weather_kind": conditions.weather.kind if conditions.weather else None,
        "weather_source": conditions.weather.source if conditions.weather else None,
        "air_kind": conditions.air.kind if conditions.air else None,
        "air_source": conditions.air.source if conditions.air else None,
        "events_checked": conditions.events is not None,
        "events_coverage": conditions.events_coverage,
        "alerts": alerts(conditions),
        "news": [_news_view(item) for item in conditions.news] if conditions.news is not None else None,
        "problems": conditions.problems,
        "days": days,
    }
