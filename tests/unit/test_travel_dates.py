from datetime import date, timedelta

import pytest

from app.schemas.trip import TripRequirementsArgs
from app.services import travel_dates, trip_service
from app.services.trip_service import TripError
from tests.conftest import call, chat, new_conversation, say, tool_results

TODAY = date(2026, 10, 2)


def test_past_dates_ask_about_next_year_instead_of_assuming_it():
    message = travel_dates.past_dates_message(date(2026, 9, 21), date(2026, 9, 25), TODAY)
    assert message.startswith("21–25 September 2026 starts in the past (today is 2 October 2026).")
    assert "Do not choose a year yourself" in message
    assert "whether they meant 21–25 September 2027 or gave the wrong dates" in message


def test_describe_spans_months_and_years():
    assert travel_dates.describe(date(2026, 12, 30), date(2027, 1, 2)) == "30 December 2026 – 2 January 2027"
    assert travel_dates.describe(date(2026, 10, 30), date(2026, 11, 2)) == "30 October – 2 November 2026"
    assert travel_dates.describe(date(2026, 10, 5)) == "5 October 2026"


def test_leap_day_moves_to_the_28th():
    assert "28 February 2029" in travel_dates.past_dates_message(date(2028, 2, 29), None, date(2028, 3, 1))


def test_far_ahead_means_more_than_about_eight_months():
    assert not travel_dates.is_far_ahead(date(2027, 1, 5), TODAY)  # "5 Jan" in October: plainly next January
    assert travel_dates.is_far_ahead(date(2027, 9, 21), TODAY)  # "21 Sept" in October: maybe a slip


class _Db:
    """Enough of a session for save_requirements to fail before touching it."""

    async def scalar(self, *_):
        return None


@pytest.mark.parametrize(
    "args, expected",
    [
        ({"start_date": date(2026, 9, 21), "end_date": date(2026, 9, 25)}, "starts in the past"),
        ({"start_date": date(2027, 9, 21), "end_date": date(2027, 9, 25)}, "ask which year they meant"),
    ],
)
async def test_trip_dates_are_held_back_until_the_year_is_clear(args, expected):
    with pytest.raises(TripError, match=expected):
        await trip_service.save_requirements(_Db(), 1, 1, TripRequirementsArgs(**args), TODAY)


async def test_a_confirmed_year_far_ahead_is_saved(client, llm):
    start = date.today() + timedelta(days=travel_dates.FAR_AHEAD_DAYS + 30)
    dates = {"destination": "Delhi", "start_date": start.isoformat(), "end_date": start.isoformat()}
    conversation_id = await new_conversation(client)
    llm.queue(call("save_trip_requirements", dates), say("Which year did you mean?"))
    await chat(client, conversation_id, "Delhi on that date")
    assert "ask which year they meant" in tool_results(llm)[0]["error"]

    llm.queue(call("save_trip_requirements", {**dates, "year_confirmed": True}, "c2"), say("Saved."))
    await chat(client, conversation_id, "Yes, next year")
    assert tool_results(llm)[-1]["start_date"] == start.isoformat()
