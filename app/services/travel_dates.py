"""Dates a traveller gives without a year.

"21 to 25 Sept", said on 2 Oct, is either a slip or a trip a year away. Only the
traveller knows which, so the model is told to ask, never to pick a year itself.
"""

from datetime import date, timedelta

# A trip starting further ahead than this is unusual enough that the year is checked
# with the traveller, unless they stated it. It is also where a past date lands when
# a year is quietly added to it.
FAR_AHEAD_DAYS = 240


def _next_year(day: date) -> date:
    try:
        return day.replace(year=day.year + 1)
    except ValueError:  # 29 February
        return day.replace(year=day.year + 1, day=28)


def describe(first: date, last: date | None = None) -> str:
    if last is None or last == first:
        return first.strftime("%d %B %Y").lstrip("0")
    if (first.year, first.month) == (last.year, last.month):
        return f"{first.day}–{last.day} {last.strftime('%B %Y')}"
    if first.year == last.year:
        return f"{first.strftime('%d %B').lstrip('0')} – {last.strftime('%d %B %Y').lstrip('0')}"
    return f"{describe(first)} – {describe(last)}"


def past_dates_message(first: date, last: date | None, today: date) -> str:
    """Why past dates were refused, and the question the model should put to the traveller."""
    later_first = _next_year(first)
    later_last = _next_year(last) if last else None
    while later_first < today:  # dates more than a year back
        later_first = _next_year(later_first)
        later_last = _next_year(later_last) if later_last else None
    return (
        f"{describe(first, last)} starts in the past (today is {describe(today)}). Nothing was saved. Do not "
        f"choose a year yourself: ask the traveller whether they meant {describe(later_first, later_last)} or "
        "gave the wrong dates."
    )


def far_ahead_message(first: date, last: date | None, today: date) -> str:
    """Why a date far ahead was held back until the traveller confirms the year."""
    return (
        f"{describe(first, last)} is {(first - today).days} days away. Nothing was saved. If the traveller gave "
        "these dates without a year, they may have meant dates that have already passed: ask which year they "
        "meant, and do not choose one yourself. Call again with year_confirmed true only once they have stated "
        "or confirmed the year."
    )


def is_far_ahead(first: date, today: date) -> bool:
    return first - today > timedelta(days=FAR_AHEAD_DAYS)
