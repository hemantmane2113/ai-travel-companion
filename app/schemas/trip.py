from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class TripRequirementsArgs(BaseModel):
    """Only the fields that are provided are updated; omitted fields keep their stored value."""

    destination: str | None = Field(None, max_length=200, description="City or region being visited.")
    origin: str | None = Field(
        None, max_length=200, description="City the traveller sets out from; its travel cost then counts in the budget."
    )
    start_date: date | None = Field(None, description="First day of the trip, YYYY-MM-DD.")
    end_date: date | None = Field(None, description="Last day of the trip, YYYY-MM-DD.")
    year_confirmed: bool | None = Field(
        None,
        description="True only if the traveller stated the year of these dates, or confirmed it when you asked. "
        "Needed for dates far ahead.",
    )
    adults: int | None = Field(None, ge=1, le=20)
    children: int | None = Field(None, ge=0, le=20)
    budget_total: float | None = Field(
        None, gt=0, description="Total budget for the whole trip and all travellers, if an amount was given."
    )
    currency: str | None = Field(None, min_length=3, max_length=3, description="ISO code for budget_total, e.g. INR.")
    budget_level: Literal["budget", "mid-range", "luxury"] | None = Field(
        None, description="Use when the traveller describes a spending style instead of an amount."
    )
    interests: list[str] | None = Field(None, description="What they want to see or do, e.g. history, food, markets.")
    pace: Literal["relaxed", "moderate", "packed"] | None = None
    must_visit: list[str] | None = Field(None, description="Places the traveller said they definitely want to visit.")
    notes: str | None = Field(None, max_length=1000, description="Other constraints: dietary, mobility, etc.")


class ItineraryItem(BaseModel):
    time_of_day: Literal["morning", "afternoon", "evening", "night"]
    place: str = Field(max_length=200)
    activity: str = Field(max_length=500, description="What to do there.")
    why_visit: str | None = Field(
        None, max_length=600, description="The fact or story that makes it worth visiting, taken from a lookup."
    )
    source_url: str | None = Field(
        None, description="URL returned by search_place_info or get_travel_guide that supports why_visit."
    )


class ItineraryDay(BaseModel):
    date: date
    theme: str = Field(max_length=120)
    items: list[ItineraryItem] = Field(min_length=1, max_length=8)


class SaveItineraryArgs(BaseModel):
    summary: str = Field(
        "", max_length=600, description="Two or three sentences on the shape of the whole trip. No claims about cost."
    )
    days: list[ItineraryDay] = Field(
        min_length=1,
        description="Up to 5 days per call. For a longer trip, call again with the next days until every date is covered.",
    )
    tips: list[str] = Field(default_factory=list, max_length=8, description="Practical advice for this trip.")
