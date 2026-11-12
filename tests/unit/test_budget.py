from datetime import date
from decimal import Decimal

from app.models import Trip
from app.services import budget_service

# Indore, 3 days, 2 adults; Pune is about 500 km away in a straight line (625 by road).
DISTANCE = 500.0


def _trip(**overrides) -> Trip:
    fields = dict(
        destination="Indore", origin="Pune", start_date=date(2026, 10, 15), end_date=date(2026, 10, 17),
        adults=2, children=0, budget_total=Decimal(25000), currency="INR",
    )
    fields.update(overrides)
    return Trip(**fields)


def test_every_level_is_costed_from_the_table():
    plan = budget_service.plan(_trip(), DISTANCE)
    assert (plan.people, plan.rooms, plan.nights, plan.days, plan.distance_km) == (2, 1, 2, 3, 625)
    assert [level.total for level in plan.all_levels] == [8600, 23500, 53900]
    budget, mid, comfort = plan.all_levels
    assert (budget.travel_mode, mid.travel_mode, comfort.travel_mode) == ("train_sleeper", "train_3a", "train_2a")
    assert mid.stay == 8000 and mid.travel_there_and_back == 3500 and mid.food == 6600


def test_the_most_comfortable_level_within_budget_is_chosen():
    plan = budget_service.plan(_trip(), DISTANCE)
    assert plan.chosen.tier.name == "mid-range" and plan.fits and plan.shortfall == 0
    assert plan.hotel_max_per_night == 4000
    data = budget_service.for_model(plan)
    assert data["left_over"] == 1500 and data["fits_budget"] is True
    assert data["getting_there"].startswith("train, AC 3-tier from Pune")

    rich = budget_service.plan(_trip(budget_total=Decimal(60000)), DISTANCE)
    assert rich.chosen.tier.name == "comfort"


def test_a_budget_below_every_level_says_by_how_much():
    plan = budget_service.plan(_trip(budget_total=Decimal(8000)), DISTANCE)
    assert plan.chosen.tier.name == "budget" and not plan.fits and plan.shortfall == 600
    data = budget_service.for_model(plan)
    assert data["over_budget_by"] == 600 and "over_budget_note" in data
    card = budget_service.for_card(plan)
    assert card["fits"] is False and card["over_by"] == 600


def test_without_a_starting_city_travel_is_left_out():
    plan = budget_service.plan(_trip(origin=None), None)
    assert plan.chosen.travel_mode is None
    assert "getting_there_and_back" not in budget_service.for_model(plan)["estimated_breakdown"]
    assert budget_service.for_model(plan)["getting_there"].startswith("not included")


def test_a_spending_style_instead_of_an_amount():
    plan = budget_service.plan(_trip(budget_total=None, currency=None, budget_level="luxury"), DISTANCE)
    assert plan.chosen.tier.name == "comfort" and plan.budget is None and plan.fits


def test_no_plan_until_dates_travellers_and_budget_are_known():
    assert budget_service.plan(_trip(start_date=None), DISTANCE) is None
    assert budget_service.plan(_trip(adults=None), DISTANCE) is None
    assert budget_service.plan(_trip(budget_total=None), DISTANCE) is None


def _day_trip(**overrides) -> Trip:
    # One day in Mumbai for two on ₹1,000: a real chat that went wrong.
    return _trip(destination="Mumbai", start_date=date(2026, 10, 3), end_date=date(2026, 10, 3),
                 budget_total=Decimal(1000), **overrides)


def test_starting_in_the_destination_costs_no_journey():
    plan = budget_service.plan(_day_trip(origin="Mumbai"), 0.0)
    assert plan.starts_locally and plan.chosen.travel_mode is None
    assert plan.chosen.total == 1400 and plan.shortfall == 400
    data = budget_service.for_model(plan)
    assert data["getting_there"].startswith("not needed")
    assert "stay" not in data["estimated_breakdown"] and "stay" not in data["plan_to_this_level"]
    assert "hotel_max_per_night_all_rooms" not in data
    # A one-day trip cannot be shortened, so the only saving offered is free sights.
    assert data["ways_to_save"] == [{"change": "only free sights, no paid entries", "saves": 200}]


def test_over_budget_savings_are_worked_out_in_code():
    plan = budget_service.plan(_day_trip(origin="Pune"), 119.0)  # 149 km by road: bus at the budget level
    assert plan.chosen.travel_mode == "bus" and plan.chosen.travel_there_and_back == 1400
    assert budget_service.ways_to_save(plan) == [
        {"change": "only free sights, no paid entries", "saves": 200},
        {"change": "go by train in sleeper or second class", "saves": 900},
    ]
    three_days = budget_service.plan(_trip(budget_total=Decimal(5000)), DISTANCE)
    assert {"change": "one day and night fewer", "saves": 2900} in budget_service.ways_to_save(three_days)


def test_long_journeys_fly_only_at_comfort_level():
    plan = budget_service.plan(_trip(budget_total=Decimal(200000)), 1000.0)
    assert [level.travel_mode for level in plan.all_levels] == ["train_sleeper", "train_3a", "flight"]
