import itertools
import random

import pytest

from app.providers.maps.base import GeoPoint, MapsError
from app.services import route_service
from app.services.route_service import path_length, shortest_open_path, split_into_days
from tests.conftest import FakeGeocoder, FakeRouter

CENTER = GeoPoint(28.61, 77.21)
# North to south along the fake geocoder's line.
NORTH_TO_SOUTH = ["Jama Masjid", "Red Fort", "India Gate", "Humayun's Tomb", "Qutub Minar"]


def _line(*positions: float) -> list[list[float]]:
    return [[abs(a - b) for b in positions] for a in positions]


def test_shortest_path_walks_a_line_end_to_end():
    cost = _line(5, 1, 9, 3, 7)
    order = shortest_open_path(cost)
    assert order in ([1, 3, 0, 4, 2], [2, 4, 0, 3, 1])
    assert path_length(order, cost) == 8


def test_shortest_path_honours_a_fixed_start():
    assert shortest_open_path(_line(5, 4, 9), start=0) == [0, 1, 2]
    assert shortest_open_path(_line(5, 4, 9), start=1) == [1, 0, 2]
    assert shortest_open_path(_line(1, 9), start=1) == [1, 0]
    assert shortest_open_path([[0]]) == [0]
    assert shortest_open_path([]) == []


def test_exact_search_matches_brute_force_on_random_asymmetric_costs():
    rng = random.Random(7)
    for size in (4, 5, 6, 7):
        cost = [[0 if i == j else rng.uniform(1, 20) for j in range(size)] for i in range(size)]
        best = min(path_length(list(p), cost) for p in itertools.permutations(range(size)))
        assert path_length(shortest_open_path(cost), cost) == pytest.approx(best)
        best_from_two = min(path_length([2, *p], cost) for p in itertools.permutations([i for i in range(size) if i != 2]))
        fixed = shortest_open_path(cost, start=2)
        assert fixed[0] == 2 and path_length(fixed, cost) == pytest.approx(best_from_two)


def test_heuristic_is_used_beyond_the_exact_limit_and_finds_the_line():
    positions = list(range(14))
    shuffled = positions[:]
    random.Random(3).shuffle(shuffled)
    cost = _line(*shuffled)
    order = shortest_open_path(cost)
    assert sorted(order) == positions
    assert path_length(order, cost) == 13


def test_split_into_days_is_balanced_and_consecutive():
    assert split_into_days([4, 2, 0, 1, 3], 2) == [[4, 2, 0], [1, 3]]
    assert split_into_days([0, 1, 2], 3) == [[0], [1], [2]]
    assert split_into_days([0, 1], 4) == [[0], [1]]
    assert split_into_days([], 3) == [[]]


async def test_optimize_orders_stops_and_groups_neighbours_by_day(session_factory):
    shuffled = ["India Gate", "Qutub Minar", "Jama Masjid", "Humayun's Tomb", "Red Fort"]
    async with session_factory() as db:
        plan = await route_service.optimize(db, FakeGeocoder(), FakeRouter(), "Delhi", shuffled, 2, CENTER)

    stops = [day.stops for day in plan.days]
    assert stops in (
        [NORTH_TO_SOUTH[:3], NORTH_TO_SOUTH[3:]],
        [NORTH_TO_SOUTH[::-1][:3], NORTH_TO_SOUTH[::-1][3:]],
    )
    assert plan.source == "Fake roads" and plan.unlocated == []
    first = plan.days[0]
    assert len(first.legs) == 2 and first.total_km == pytest.approx(sum(leg["km"] for leg in first.legs), abs=0.2)
    assert first.maps_url.startswith("https://www.google.com/maps/dir/?api=1&origin=")


async def test_optimize_starts_from_the_base_and_reports_unlocated(session_factory):
    geocoder = FakeGeocoder()
    geocoder.places["hotel"] = GeoPoint(28.50, 77.21)  # south of everything
    async with session_factory() as db:
        plan = await route_service.optimize(
            db, geocoder, FakeRouter(), "Delhi", ["Red Fort", "Qutub Minar", "Atlantis", "India Gate"], 1, CENTER, "Hotel"
        )

    assert plan.days[0].stops == ["Qutub Minar", "India Gate", "Red Fort"]  # nearest to the base first
    assert plan.unlocated == ["Atlantis"]


async def test_locations_are_cached_and_far_matches_rejected(session_factory):
    geocoder = FakeGeocoder()
    geocoder.places["red fort"] = GeoPoint(27.18, 78.02)  # Agra's Red Fort, 180 km away
    async with session_factory() as db:
        first = await route_service.locate(db, geocoder, "Delhi", ["Red Fort", "India Gate", "Atlantis"], CENTER)
        again = await route_service.locate(db, geocoder, "Delhi", ["red  fort", "India Gate", "Atlantis"], CENTER)

    assert first["Red Fort"] is None and first["Atlantis"] is None and first["India Gate"] is not None
    assert again["red  fort"] is None and again["India Gate"] == first["India Gate"]
    # Found and not-found places come from the cache. A match rejected as too far is not
    # cached, because it depends on where the destination was taken to be.
    assert geocoder.queries == ["Red Fort, Delhi", "India Gate, Delhi", "Atlantis, Delhi", "red  fort, Delhi"]


async def test_a_wider_destination_accepts_places_further_out(session_factory):
    geocoder = FakeGeocoder()
    geocoder.places["gulmarg"] = GeoPoint(34.05, 74.38)
    srinagar = GeoPoint(34.08, 74.80)
    far_centre = GeoPoint(33.0, 76.0)  # roughly the middle of a large state, ~160 km away
    async with session_factory() as db:
        city_limit = await route_service.locate(db, geocoder, "Kashmir", ["Gulmarg"], far_centre)
        state_limit = await route_service.locate(
            db, geocoder, "Kashmir", ["Gulmarg"], far_centre, route_service.reach_km(250)
        )
        near = await route_service.locate(db, geocoder, "Kashmir", ["Gulmarg"], srinagar)
    assert city_limit["Gulmarg"] is None and state_limit["Gulmarg"] is not None and near["Gulmarg"] is not None
    assert route_service.reach_km(10) == 80 and route_service.reach_km(250) == 290


async def test_measure_reports_distance_and_flags_a_wasteful_order(session_factory):
    zigzag = ["Jama Masjid", "Qutub Minar", "Red Fort", "Humayun's Tomb"]
    async with session_factory() as db:
        plan = await route_service.measure(
            db, FakeGeocoder(), FakeRouter(), "Delhi", [zigzag, ["Red Fort", "Atlantis", "India Gate"]], CENTER
        )

    wasteful, fine = plan.days
    assert wasteful.total_km > 30
    assert wasteful.shorter_order in (
        ["Jama Masjid", "Red Fort", "Humayun's Tomb", "Qutub Minar"],
        ["Qutub Minar", "Humayun's Tomb", "Red Fort", "Jama Masjid"],
    )
    assert fine.shorter_order is None and fine.unlocated == ["Atlantis"]
    assert [leg["from"] + ">" + leg["to"] for leg in fine.legs] == ["Red Fort>India Gate"]


async def test_routing_failure_falls_back_to_a_labelled_estimate(session_factory):
    router = FakeRouter()
    router.error = MapsError("down")
    async with session_factory() as db:
        plan = await route_service.optimize(db, FakeGeocoder(), router, "Delhi", NORTH_TO_SOUTH[::2], 1, CENTER)
    assert plan.source.startswith("straight-line estimate")
    assert plan.days[0].stops in (NORTH_TO_SOUTH[::2], NORTH_TO_SOUTH[::2][::-1])
    assert plan.days[0].total_km > 0


async def test_geocoder_failure_is_raised_not_hidden(session_factory):
    geocoder = FakeGeocoder()
    geocoder.error = MapsError("The map service could not locate places right now.")
    async with session_factory() as db:
        with pytest.raises(MapsError):
            await route_service.optimize(db, geocoder, FakeRouter(), "Delhi", ["Red Fort", "India Gate"], 1, CENTER)
