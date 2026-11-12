from datetime import date, timedelta

import httpx
import pytest

from app.providers.air.base import AirQualityError, aqi_category
from app.providers.air.open_meteo import OpenMeteoAirQualityProvider, daily_from_hourly
from app.providers.weather.base import City
from app.services import conditions_service
from tests.conftest import FakeAir, FakeEvents, FakeWeather

TODAY = date(2026, 10, 1)
DELHI = City("Delhi", "Delhi", "India", "IN", 28.61, 77.21)


def _hours(day: date, aqi: list, pm: list) -> dict:
    return {
        "time": [f"{day.isoformat()}T{h:02d}:00" for h in range(len(aqi))],
        "us_aqi": aqi,
        "pm2_5": pm,
    }


def test_aqi_categories_follow_the_us_epa_bands():
    assert [aqi_category(v) for v in (0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301)] == [
        "Good", "Good", "Moderate", "Moderate", "Unhealthy for sensitive groups", "Unhealthy for sensitive groups",
        "Unhealthy", "Unhealthy", "Very unhealthy", "Very unhealthy", "Hazardous",
    ]


def test_daily_values_are_the_peak_aqi_and_mean_pm25_skipping_gaps():
    start = date(2026, 10, 1)
    first, second = _hours(start, [40, 120, None], [10, 30, None]), _hours(start + timedelta(days=1), [None], [None])
    data = {"hourly": {key: first[key] + second[key] for key in first}}
    assert daily_from_hourly(data, start) == {0: (120, 20.0)}  # day 2 has no data at all


def _provider(handler) -> OpenMeteoAirQualityProvider:
    return OpenMeteoAirQualityProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_near_dates_use_the_forecast():
    asked = []

    def handler(request):
        asked.append(dict(request.url.params))
        start = date.fromisoformat(request.url.params["start_date"])
        return httpx.Response(200, json={"hourly": _hours(start, [55, 140], [20, 60])})

    report = await _provider(handler).daily(DELHI, TODAY, TODAY + timedelta(days=2), TODAY)

    assert report.kind == "forecast" and len(asked) == 1
    assert asked[0]["hourly"] == "us_aqi,pm2_5" and asked[0]["latitude"] == "28.61"
    assert [(d.date, d.peak_aqi, d.pm25) for d in report.days] == [(TODAY, 140, 40.0)]


async def test_far_dates_average_the_same_days_in_recent_years():
    asked = []

    def handler(request):
        start = date.fromisoformat(request.url.params["start_date"])
        asked.append(start.year)
        peak = {2025: 170, 2024: 150, 2023: 130}[start.year]
        return httpx.Response(200, json={"hourly": _hours(start, [peak], [peak / 2])})

    report = await _provider(handler).daily(DELHI, date(2026, 11, 10), date(2026, 11, 10), TODAY)

    assert sorted(asked) == [2023, 2024, 2025]
    assert report.kind == "typical" and "2023–2025" in report.source
    assert [(d.date, d.peak_aqi, d.pm25) for d in report.days] == [(date(2026, 11, 10), 150, 75.0)]


async def test_history_before_the_dataset_starts_is_not_requested():
    asked = []

    def handler(request):
        start = date.fromisoformat(request.url.params["start_date"])
        asked.append(start.year)
        return httpx.Response(200, json={"hourly": _hours(start, [90], [30])})

    # Only 2025, 2024 and 2023 exist for October; earlier years are before August 2022.
    report = await _provider(handler).daily(DELHI, date(2026, 10, 20), date(2026, 10, 20), TODAY)
    assert sorted(asked) == [2023, 2024, 2025] and report.days[0].peak_aqi == 90

    # A trip in spring 2027 can only draw on 2026, 2025, 2024 (all after the start).
    asked.clear()
    await _provider(handler).daily(DELHI, date(2027, 3, 1), date(2027, 3, 1), TODAY)
    assert sorted(asked) == [2024, 2025, 2026]


async def test_missing_or_failing_data_is_an_error_not_a_guess():
    empty = _provider(lambda r: httpx.Response(200, json={"hourly": {"time": [], "us_aqi": [], "pm2_5": []}}))
    with pytest.raises(AirQualityError, match="no air-quality history"):
        await empty.daily(DELHI, date(2026, 11, 10), date(2026, 11, 10), TODAY)
    with pytest.raises(AirQualityError, match="No air-quality forecast"):
        await empty.daily(DELHI, TODAY, TODAY, TODAY)
    with pytest.raises(AirQualityError, match="did not return data"):
        await _provider(lambda r: httpx.Response(500)).daily(DELHI, TODAY, TODAY, TODAY)


async def _conditions(air):
    return await conditions_service.get_conditions(
        FakeWeather(), FakeEvents(), "Delhi", TODAY + timedelta(days=1), TODAY + timedelta(days=2), TODAY, air=air
    )


async def test_air_quality_alerts_and_output():
    air = FakeAir()
    air.peak_aqi = 175
    conditions = await _conditions(air)

    alerts = conditions_service.alerts(conditions)
    # Two consecutive bad days are one alert for the run of days.
    first, second = TODAY + timedelta(days=1), TODAY + timedelta(days=2)
    assert alerts == [
        f"{first.day}–{second.day} {second.strftime('%b')}: air quality is forecast to be unhealthy (US AQI up to 175). "
        "Keep long outdoor stops short, prefer indoor sights at the worst times, and consider an N95 mask."
    ]
    view = conditions_service.for_model(conditions)
    assert view["air_quality"][0].endswith("US AQI peak 175 (Unhealthy), PM2.5 about 30 µg/m³")
    assert "US EPA AQI scale" in view["air_quality_source"]
    card = conditions_service.for_card(conditions)
    day = (TODAY + timedelta(days=1)).isoformat()
    assert card["days"][day]["air"] == {"peak_aqi": 175, "category": "Unhealthy", "pm25": 30.0}
    assert card["air_kind"] == "forecast"


async def test_sensitive_band_and_typical_wording():
    air = FakeAir()
    air.peak_aqi, air.kind = 120, "typical"
    conditions = await _conditions(air)
    assert "air quality is usually unhealthy for sensitive groups" in conditions_service.alerts(conditions)[0]
    assert conditions_service.for_model(conditions)["air_quality_kind"].startswith("NOT a forecast")

    air.peak_aqi = 90
    assert conditions_service.alerts(await _conditions(air)) == []


async def test_air_failure_is_reported_and_does_not_hide_the_weather():
    air = FakeAir()
    air.error = AirQualityError("The air-quality service did not return data.")
    conditions = await _conditions(air)
    assert conditions.air is None and conditions.weather is not None
    assert conditions.problems == ["Air quality could not be checked: The air-quality service did not return data."]
