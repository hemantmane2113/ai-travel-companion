from datetime import date

import httpx
import pytest

from app.providers.events.base import Event, EventsError, EventsUnsupported
from app.providers.events.holidays import HolidayEventsProvider, parse_ics
from app.providers.weather.base import City, WeatherError
from app.providers.weather.open_meteo import OpenMeteoWeatherProvider
from app.services import conditions_service
from app.services.conditions_service import ConditionsError
from tests.conftest import FakeEvents, FakeWeather

START, END, TODAY = date(2026, 10, 1), date(2026, 10, 3), date(2026, 9, 30)
INDORE = City("Indore", "Madhya Pradesh", "India", "IN", 22.72, 75.86)

ICS = (
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261002\r\nDESCRIPTION:Public holiday\r\n"
    "SUMMARY:Mahatma Gandhi Jayanti\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261003\r\n"
    "DESCRIPTION:Observance\\nTo hide observances\\, go to Google Calendar Setting\r\n s > Holidays in India\r\n"
    "SUMMARY:Some Observance\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20250101\r\n"
    "DESCRIPTION:Public holiday\r\nSUMMARY:Last Year\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


async def _conditions(weather=None, events=None):
    return await conditions_service.get_conditions(
        weather or FakeWeather(), events or FakeEvents(), "Indore", START, END, TODAY
    )


async def test_quiet_dates_raise_no_alerts_and_say_what_was_checked():
    conditions = await _conditions()
    view = conditions_service.for_model(conditions)

    assert conditions_service.alerts(conditions) == []
    assert view["weather_kind"] == "forecast for these dates"
    assert view["weather"][0] == "2026-10-01: Clear, 22–33°C, rain chance 5%"
    assert view["events"] == [] and view["events_coverage"] == "public holidays only"
    assert "could_not_check" not in view


async def test_rain_heat_and_public_holidays_raise_alerts():
    weather, events = FakeWeather(), FakeEvents()
    weather.rain_probability, weather.temp_max = 80, 41.0
    events.listed = [
        Event(date(2026, 10, 2), "Mahatma Gandhi Jayanti", "public holiday", "test"),
        Event(date(2026, 10, 3), "Some Observance", "observance", "test"),
    ]

    conditions = await _conditions(weather, events)
    alerts = conditions_service.alerts(conditions)

    # Three wet, hot days are one alert each for the whole run, not three each.
    assert [a for a in alerts if "rain is likely" in a] == ["1–3 Oct: rain is likely. Plan indoor stops or carry rain gear."]
    assert [a for a in alerts if "very hot" in a] == [
        "1–3 Oct: very hot, up to 41°C. Avoid outdoor stops around midday."
    ]
    holiday = [alert for alert in alerts if "public holiday" in alert]
    assert len(holiday) == 1 and holiday[0].startswith("2 Oct: Mahatma Gandhi Jayanti")
    assert alerts.index(holiday[0]) == len(alerts) - 1  # sorted by date: the runs start on 1 Oct
    card = conditions_service.for_card(conditions)
    assert card["days"]["2026-10-02"]["events"] == [{"name": "Mahatma Gandhi Jayanti", "kind": "public holiday"}]
    assert card["days"]["2026-10-03"]["weather"]["temp_max_c"] == 41
    assert "2026-10-03: Some Observance (observance)" in conditions_service.for_model(conditions)["events"]


async def test_typical_weather_is_labelled_as_not_a_forecast():
    weather = FakeWeather()
    weather.kind = "typical"
    view = conditions_service.for_model(await _conditions(weather))
    assert view["weather_kind"].startswith("NOT a forecast")


async def test_one_source_failing_keeps_the_other_and_is_reported():
    weather, events = FakeWeather(), FakeEvents()
    weather.error = WeatherError("The weather service did not return data.")
    events.listed = [Event(date(2026, 10, 2), "Holiday", "public holiday", "test")]
    view = conditions_service.for_model(await _conditions(weather, events))
    assert "weather" not in view and len(view["events"]) == 1
    assert view["could_not_check"] == ["Weather could not be retrieved: The weather service did not return data."]

    events = FakeEvents()
    events.error = EventsUnsupported("No holiday calendar is available for country ZZ.")
    conditions = await _conditions(events=events)
    view = conditions_service.for_model(conditions)
    # Unknown is not the same as "nothing happening".
    assert "events" not in view and "could not be checked" in view["could_not_check"][0]
    assert conditions_service.for_card(conditions)["events_checked"] is False


async def test_unknown_place_is_an_error():
    weather = FakeWeather()
    weather.city = None
    with pytest.raises(ConditionsError, match="Could not find a place"):
        await _conditions(weather)


# ---------- Open-Meteo ----------


def _open_meteo(handler) -> OpenMeteoWeatherProvider:
    return OpenMeteoWeatherProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_find_city_normalises_the_geocoding_result():
    def handler(request):
        return httpx.Response(
            200,
            json={"results": [{"name": "Indore", "admin1": "Madhya Pradesh", "country": "India", "country_code": "IN",
                               "latitude": 22.72, "longitude": 75.86}]},
        )

    assert await _open_meteo(handler).find_city("indore") == INDORE
    assert await _open_meteo(lambda request: httpx.Response(200, json={})).find_city("zzz") is None
    with pytest.raises(WeatherError):
        await _open_meteo(lambda request: httpx.Response(500)).find_city("x")


async def test_near_dates_use_the_forecast():
    seen = []

    def handler(request):
        seen.append(request.url)
        return httpx.Response(
            200,
            json={"daily": {"time": ["2026-10-01", "2026-10-02"], "weather_code": [0, 63],
                            "temperature_2m_max": [33.1, 29.0], "temperature_2m_min": [22.1, 21.0],
                            "precipitation_probability_max": [2, 85], "precipitation_sum": [0.0, 14.2]}},
        )

    report = await _open_meteo(handler).daily(INDORE, date(2026, 10, 1), date(2026, 10, 2), TODAY)

    assert seen[0].host == "api.open-meteo.com" and len(seen) == 1
    assert report.kind == "forecast"
    assert [(d.summary, d.precipitation_probability, d.precipitation_mm) for d in report.days] == [
        ("Clear", 2, 0.0),
        ("Rain", 85, 14.2),
    ]


async def test_far_dates_average_recent_years_from_the_archive():
    asked = []

    def handler(request):
        asked.append(request.url.params["start_date"])
        year = int(request.url.params["start_date"][:4])
        return httpx.Response(
            200,
            json={"daily": {"time": ["a", "b"], "temperature_2m_max": [20.0 + year - 2023, 30.0],
                            "temperature_2m_min": [10.0, 12.0], "precipitation_sum": [0.0, 9.0 if year == 2025 else 12.0]}},
        )

    report = await _open_meteo(handler).daily(INDORE, date(2026, 12, 20), date(2026, 12, 21), TODAY)

    assert sorted(asked) == ["2023-12-20", "2024-12-20", "2025-12-20"]
    assert report.kind == "typical" and "2023–2025" in report.source
    first, second = report.days
    assert first.temp_max_c == 21.0 and first.summary == "Usually dry" and first.precipitation_probability is None
    assert second.precipitation_mm == 11.0 and second.summary == "Usually wet"
    assert [d.date for d in report.days] == [date(2026, 12, 20), date(2026, 12, 21)]


# ---------- holiday calendars ----------


async def test_separate_runs_of_days_get_separate_alerts():
    weather = FakeWeather()
    original = weather.daily

    async def patchy(city, start, end, today):
        report = await original(city, start, end, today)
        for day in report.days:
            day.precipitation_probability = 0 if day.date == date(2026, 10, 2) else 90
        return report

    weather.daily = patchy
    alerts = conditions_service.alerts(await _conditions(weather))
    assert [a.split(":")[0] for a in alerts if "rain" in a] == ["1 Oct", "3 Oct"]


def test_parse_ics_unfolds_lines_and_unescapes():
    events = parse_ics(ICS)
    assert [event["SUMMARY"] for event in events] == ["Mahatma Gandhi Jayanti", "Some Observance", "Last Year"]
    assert events[0]["DTSTART"] == "20261002"
    assert events[1]["DESCRIPTION"].endswith("go to Google Calendar Settings > Holidays in India")


def _holidays(handler) -> HolidayEventsProvider:
    return HolidayEventsProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_india_falls_back_to_the_google_calendar():
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "date.nager.at":
            return httpx.Response(204)
        return httpx.Response(200, text=ICS)

    provider = _holidays(handler)
    events = await provider.events("in", START, END)

    assert [(e.date, e.name, e.kind) for e in events] == [
        (date(2026, 10, 2), "Mahatma Gandhi Jayanti", "public holiday"),
        (date(2026, 10, 3), "Some Observance", "observance"),
    ]
    await provider.events("IN", START, END)
    assert calls == ["date.nager.at", "calendar.google.com"]  # cached afterwards


async def test_nager_countries_and_unsupported_countries():
    def nager(request):
        return httpx.Response(200, json=[{"date": "2026-10-03", "name": "German Unity Day"}, {"date": "2026-12-25", "name": "Christmas Day"}])

    events = await _holidays(nager).events("DE", START, END)
    assert [(e.name, e.kind, e.source) for e in events] == [("German Unity Day", "public holiday", "Nager.Date")]

    with pytest.raises(EventsUnsupported):
        await _holidays(lambda request: httpx.Response(204)).events("ZZ", START, END)
    with pytest.raises(EventsError):
        await _holidays(lambda request: httpx.Response(500)).events("DE", START, END)
