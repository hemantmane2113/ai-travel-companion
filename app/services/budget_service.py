"""Splitting a trip budget, in code. The model is told the result; it does not do the sums.

Given the money, travellers, nights and (if known) where they start from, this
works out what each level of comfort would cost, picks the most comfortable level
that fits, and says how far over budget even the cheapest level is when none does.
All figures are estimates from cost_table.
"""

import math
from dataclasses import dataclass
from typing import Any

from app.models import Trip
from app.services import cost_table
from app.services.cost_table import TIERS, Tier
from app.services.trip_service import trip_dates

ROUND_TO = 100


def _round(amount: float) -> int:
    return int(math.ceil(amount / ROUND_TO) * ROUND_TO)


@dataclass
class TierCost:
    tier: Tier
    stay: int
    travel_there_and_back: int
    food: int
    local_transport: int
    activities: int
    travel_mode: str | None  # key into cost_table.MODES, if the trip includes getting there

    @property
    def total(self) -> int:
        return self.stay + self.travel_there_and_back + self.food + self.local_transport + self.activities


@dataclass
class BudgetPlan:
    budget: int | None  # rupees, if the traveller gave an amount
    chosen: TierCost
    fits: bool  # within budget (always True when no amount was given)
    people: int
    rooms: int
    nights: int
    days: int
    distance_km: float | None  # one way, if the starting point is known
    origin: str | None
    all_levels: list[TierCost]
    starts_locally: bool = False  # the traveller starts in or near the destination

    @property
    def hotel_max_per_night(self) -> int:
        """For all rooms together, which is what booking-site price filters use."""
        return self.chosen.tier.hotel_per_room_night * self.rooms

    @property
    def shortfall(self) -> int:
        return max(0, self.chosen.total - self.budget) if self.budget is not None else 0


def rooms_for(adults: int, children: int) -> int:
    return max(1, math.ceil(adults / 2))


def cost_at(tier: Tier, people: int, rooms: int, nights: int, days: int, distance_km: float | None) -> TierCost:
    mode = cost_table.travel_mode_for(tier.name, distance_km) if distance_km is not None else None
    travel = 0
    if mode is not None:
        fare = cost_table.MODES[mode]
        travel = 2 * people * (fare.per_person_base + fare.per_person_per_km * distance_km)
    return TierCost(
        tier=tier,
        stay=_round(tier.hotel_per_room_night * rooms * nights),
        travel_there_and_back=_round(travel),
        food=_round(tier.food_per_person_day * people * days),
        local_transport=_round(tier.local_transport_per_person_day * people * days),
        activities=_round(tier.activities_per_person_day * people * days),
        travel_mode=mode,
    )


def plan(trip: Trip, distance_km: float | None) -> BudgetPlan | None:
    """The budget split for a trip, or None until its dates and travellers are known."""
    dates = trip_dates(trip)
    if not dates or trip.adults is None or (trip.budget_total is None and trip.budget_level is None):
        return None
    adults, children = trip.adults, trip.children or 0
    people = adults + children
    rooms = rooms_for(adults, children)
    days = len(dates)
    nights = max(0, days - 1)
    starts_locally = distance_km is not None and distance_km < cost_table.LOCAL_KM
    if starts_locally:
        distance_km = None
    elif distance_km is not None:
        distance_km = round(distance_km * cost_table.ROAD_FACTOR)

    levels = [cost_at(tier, people, rooms, nights, days, distance_km) for tier in TIERS]
    budget = None
    if trip.budget_total is not None and (trip.currency or "INR").upper() == "INR":
        budget = int(trip.budget_total)

    if budget is not None:
        affordable = [level for level in levels if level.total <= budget]
        chosen, fits = (affordable[-1], True) if affordable else (levels[0], False)
    else:
        name = cost_table.LEVEL_TO_TIER.get(trip.budget_level or "", "mid-range")
        chosen, fits = next(level for level in levels if level.tier.name == name), True

    return BudgetPlan(
        budget=budget,
        chosen=chosen,
        fits=fits,
        people=people,
        rooms=rooms,
        nights=nights,
        days=days,
        distance_km=distance_km,
        origin=trip.origin,
        all_levels=levels,
        starts_locally=starts_locally,
    )


def _breakdown(cost: TierCost) -> dict[str, int]:
    parts = {
        "stay": cost.stay,
        "getting_there_and_back": cost.travel_there_and_back,
        "food": cost.food,
        "local_transport": cost.local_transport,
        "sightseeing": cost.activities,
    }
    return {key: value for key, value in parts.items() if value}


def _getting_there(budget: BudgetPlan) -> str:
    if budget.chosen.travel_mode:
        mode = cost_table.MODES[budget.chosen.travel_mode]
        return f"{mode.name} from {budget.origin} (about {budget.distance_km} km each way)"
    if budget.starts_locally:
        return f"not needed: the trip starts in or near the destination ({budget.origin})"
    return "not included (no starting city given)"


def ways_to_save(budget: BudgetPlan) -> list[dict[str, Any]]:
    """Cuts that would bring the estimate down, each with what it saves. Worked out here, not by the model."""
    chosen, tier = budget.chosen, budget.chosen.tier
    ways = []
    if chosen.activities:
        ways.append({"change": "only free sights, no paid entries", "saves": chosen.activities})
    if chosen.travel_mode and chosen.travel_mode != "train_sleeper":
        sleeper = cost_table.MODES["train_sleeper"]
        fare = _round(2 * budget.people * (sleeper.per_person_base + sleeper.per_person_per_km * budget.distance_km))
        if fare < chosen.travel_there_and_back:
            ways.append(
                {"change": "go by train in sleeper or second class", "saves": chosen.travel_there_and_back - fare}
            )
    if budget.days > 1:
        per_day = (
            tier.food_per_person_day + tier.local_transport_per_person_day + tier.activities_per_person_day
        ) * budget.people + (tier.hotel_per_room_night * budget.rooms if budget.nights else 0)
        ways.append({"change": "one day and night fewer", "saves": _round(per_day)})
    return ways


def for_model(budget: BudgetPlan) -> dict[str, Any]:
    tier = budget.chosen.tier
    level: dict[str, str] = {}
    if budget.nights:
        level["stay"] = f"{tier.stay_style}, up to about ₹{tier.hotel_per_room_night:,} per room per night"
    level |= {"food": tier.food_style, "getting_around": tier.local_transport_style, "sightseeing": tier.activities_style}
    data: dict[str, Any] = {
        "level": tier.name,
        "estimated_total": budget.chosen.total,
        "estimated_breakdown": _breakdown(budget.chosen),
        "plan_to_this_level": level,
    }
    if budget.nights:
        data["rooms"] = budget.rooms
        data["hotel_max_per_night_all_rooms"] = budget.hotel_max_per_night
    data["getting_there"] = _getting_there(budget)
    if budget.chosen.travel_mode:
        data["getting_there_search_mode"] = cost_table.MODES[budget.chosen.travel_mode].search_mode
    if budget.budget is not None:
        data["budget"] = budget.budget
        data["fits_budget"] = budget.fits
        if not budget.fits:
            data["over_budget_by"] = budget.shortfall
            data["ways_to_save"] = ways_to_save(budget)
            data["over_budget_note"] = (
                "Even the cheapest level is estimated above the budget. Say so plainly with the shortfall, offer "
                "only the ways_to_save listed here with their figures (they may not close the whole gap; say so), "
                "and propose the shortlist at the budget level. Ask whether to go ahead at that level or change "
                "the budget or the trip. Quote no other prices."
            )
        else:
            data["left_over"] = budget.budget - budget.chosen.total
    data["about_these_numbers"] = (
        "Rough estimates from typical Indian prices, not quotes. Call them estimates; real prices are on the "
        "linked booking sites."
    )
    return data


def for_card(budget: BudgetPlan) -> dict[str, Any]:
    data = for_model(budget)
    return {
        "level": data["level"],
        "estimated_total": data["estimated_total"],
        "breakdown": data["estimated_breakdown"],
        "budget": budget.budget,
        "fits": budget.fits,
        "over_by": budget.shortfall,
        "getting_there": _getting_there(budget),
        "people": budget.people,
        "nights": budget.nights,
    }
