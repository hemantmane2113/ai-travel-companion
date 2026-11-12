"""Typical travel costs in India, used to split a budget. These are ESTIMATES.

No free source gives live prices for food, sightseeing or train fares, so these are
hand-set planning figures for an Indian city trip in 2026, in rupees. They decide
which level of comfort a budget can afford; real prices are always checked on the
providers' own sites. Edit the numbers here; nothing else needs to change.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Tier:
    name: str  # "budget", "mid-range", "comfort"
    hotel_per_room_night: int  # upper end of what this level pays for a double room
    food_per_person_day: int
    local_transport_per_person_day: int
    activities_per_person_day: int  # entry fees, boat rides, guided walks
    food_style: str
    local_transport_style: str
    activities_style: str
    stay_style: str


TIERS = (
    Tier(
        name="budget",
        hotel_per_room_night=1500,
        food_per_person_day=450,
        local_transport_per_person_day=150,
        activities_per_person_day=100,
        food_style="street food, dhabas and local thali places",
        local_transport_style="city buses, metro, shared autos and walking",
        activities_style="mostly free sights (markets, ghats, temples, parks, walking areas); at most one paid entry a day",
        stay_style="hostels, guest houses and budget hotels",
    ),
    Tier(
        name="mid-range",
        hotel_per_room_night=4000,
        food_per_person_day=1100,
        local_transport_per_person_day=450,
        activities_per_person_day=450,
        food_style="good local restaurants, with a street-food outing",
        local_transport_style="autos and app cabs, metro where it helps",
        activities_style="paid monuments and museums, an occasional guided walk or boat ride",
        stay_style="3-star hotels and well-reviewed homestays",
    ),
    Tier(
        name="comfort",
        hotel_per_room_night=9000,
        food_per_person_day=2600,
        local_transport_per_person_day=1300,
        activities_per_person_day=1200,
        food_style="well-known restaurants and hotel dining",
        local_transport_style="a private cab for the day",
        activities_style="paid sights, guided tours and experiences",
        stay_style="4- and 5-star hotels",
    ),
)
TIER_BY_NAME = {tier.name: tier for tier in TIERS}
# What travellers say when they set a level instead of an amount.
LEVEL_TO_TIER = {"budget": "budget", "mid-range": "mid-range", "luxury": "comfort"}


@dataclass(frozen=True)
class TravelMode:
    name: str  # shown to the traveller
    search_mode: str  # "train", "bus" or "flight": which search links fit
    per_person_base: int  # fixed part of a one-way fare
    per_person_per_km: float


# Typical one-way fares per person. Distance is by road or rail, not straight line.
MODES = {
    "bus": TravelMode("bus (non-AC or AC sleeper)", "bus", 100, 1.6),
    "train_sleeper": TravelMode("train, sleeper class", "train", 50, 0.45),
    "train_3a": TravelMode("train, AC 3-tier", "train", 80, 1.25),
    "train_2a": TravelMode("train, AC 2-tier", "train", 120, 1.9),
    "flight": TravelMode("flight, economy", "flight", 2800, 2.6),
}
# Which way of getting there each level uses, by one-way distance in km.
SHORT_TRIP_KM = 300  # buses are as good as trains up to about here
LONG_TRIP_KM = 800  # beyond this, comfort means flying


def travel_mode_for(tier: str, distance_km: float) -> str:
    if tier == "budget":
        return "bus" if distance_km <= SHORT_TRIP_KM else "train_sleeper"
    if tier == "mid-range":
        return "bus" if distance_km <= SHORT_TRIP_KM else "train_3a"
    return "flight" if distance_km > LONG_TRIP_KM else "train_2a"


ROAD_FACTOR = 1.25  # straight-line distance to typical road or rail distance
LOCAL_KM = 40  # a start this close (straight line) is in or around the destination: no journey to cost
