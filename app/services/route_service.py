"""Where places are and the shortest way round them. All of it is computed, none of it guessed."""

import logging
import math
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GeocodedPlace
from app.providers.maps.base import GeocodingProvider, GeoPoint, MapsError, RoutingProvider, TravelMatrix

logger = logging.getLogger(__name__)

MAX_KM_FROM_DESTINATION = 80.0  # a match further away is a different place with the same name
DESTINATION_MARGIN_KM = 40.0  # allowed beyond a destination's own extent (e.g. a state's border)


def reach_km(radius_km: float) -> float:
    """How far from a destination's centre its places can be: wider for a state than a city."""
    return max(MAX_KM_FROM_DESTINATION, radius_km + DESTINATION_MARGIN_KM)
EXACT_SEARCH_LIMIT = 11  # exact search up to this many stops; a good heuristic beyond
ROAD_FACTOR = 1.3  # straight line to road distance, used only when routing is unavailable
FALLBACK_KMH = 22.0
WORTH_REORDERING_KM = 2.0
WORTH_REORDERING_RATIO = 1.25


@dataclass
class DayRoute:
    stops: list[str]
    legs: list[dict[str, Any]] = field(default_factory=list)
    total_km: float = 0.0
    total_minutes: int = 0
    maps_url: str | None = None
    unlocated: list[str] = field(default_factory=list)
    shorter_order: list[str] | None = None  # set when the given order wastes real distance

    def as_dict(self) -> dict[str, Any]:
        return {
            "stops": self.stops,
            "legs": self.legs,
            "total_km": self.total_km,
            "total_minutes": self.total_minutes,
            "maps_url": self.maps_url,
            "unlocated": self.unlocated,
        }


@dataclass
class RoutePlan:
    days: list[DayRoute]
    unlocated: list[str]
    source: str


# ---------- geometry ----------


def haversine_km(a: GeoPoint, b: GeoPoint) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a.latitude, a.longitude, b.latitude, b.longitude))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def straight_line_matrix(points: list[GeoPoint]) -> TravelMatrix:
    km = [[haversine_km(a, b) * ROAD_FACTOR for b in points] for a in points]
    minutes = [[value / FALLBACK_KMH * 60 for value in row] for row in km]
    return TravelMatrix(km, minutes, "straight-line estimate (road routing was unavailable)")


def path_length(order: list[int], cost: list[list[float]]) -> float:
    return sum(cost[a][b] for a, b in zip(order, order[1:]))


def shortest_open_path(cost: list[list[float]], start: int | None = None) -> list[int]:
    """Order that visits every point once with the least total cost, ending anywhere.

    With `start`, the path begins there. Exact (Held-Karp) for small inputs.
    """
    size = len(cost)
    if size <= 2:
        order = list(range(size))
        if start is not None and size == 2 and start == 1:
            order.reverse()
        elif start is None and size == 2 and cost[1][0] < cost[0][1]:
            order.reverse()
        return order
    if size > EXACT_SEARCH_LIMIT:
        return _nearest_neighbour_two_opt(cost, start)

    # best[(visited mask, last)] = (cost so far, previous point)
    best: dict[tuple[int, int], tuple[float, int | None]] = {}
    starts = [start] if start is not None else range(size)
    for point in starts:
        best[(1 << point, point)] = (0.0, None)
    for count in range(2, size + 1):
        for subset in combinations(range(size), count):
            if start is not None and start not in subset:
                continue
            mask = sum(1 << point for point in subset)
            for last in subset:
                if start is not None and last == start:
                    continue
                previous_mask = mask ^ (1 << last)
                options = [
                    (best[(previous_mask, previous)][0] + cost[previous][last], previous)
                    for previous in subset
                    if previous != last and (previous_mask, previous) in best
                ]
                if options:
                    best[(mask, last)] = min(options)

    full = (1 << size) - 1
    last = min((point for point in range(size) if (full, point) in best), key=lambda point: best[(full, point)][0])
    order, mask = [], full
    while last is not None:
        order.append(last)
        previous = best[(mask, last)][1]
        mask ^= 1 << last
        last = previous
    return order[::-1]


def _nearest_neighbour_two_opt(cost: list[list[float]], start: int | None) -> list[int]:
    size = len(cost)
    candidates = [start] if start is not None else range(size)
    best_order: list[int] = []
    for first in candidates:
        order, remaining = [first], set(range(size)) - {first}
        while remaining:
            nearest = min(remaining, key=lambda point: cost[order[-1]][point])
            order.append(nearest)
            remaining.remove(nearest)
        improved = True
        while improved:
            improved = False
            for i in range(1, size - 1):
                for j in range(i + 1, size):
                    candidate = order[:i] + order[i : j + 1][::-1] + order[j + 1 :]
                    if path_length(candidate, cost) < path_length(order, cost) - 1e-9:
                        order, improved = candidate, True
        if not best_order or path_length(order, cost) < path_length(best_order, cost):
            best_order = order
    return best_order


def split_into_days(order: list[int], day_count: int) -> list[list[int]]:
    """Cut a route into consecutive stretches of near-equal size, one per day."""
    day_count = max(1, min(day_count, len(order))) if order else 1
    base, extra = divmod(len(order), day_count)
    days, position = [], 0
    for day in range(day_count):
        size = base + (1 if day < extra else 0)
        days.append(order[position : position + size])
        position += size
    return days


# ---------- locating places ----------


def _key(place: str, destination: str) -> str:
    return f"{' '.join(place.lower().split())}|{' '.join(destination.lower().split())}"[:400]


async def locate(
    db: AsyncSession,
    geocoder: GeocodingProvider,
    destination: str,
    places: list[str],
    center: GeoPoint | None,
    max_km: float = MAX_KM_FROM_DESTINATION,
) -> dict[str, GeoPoint | None]:
    """Coordinates for each place, from the cache where possible.

    A match further than max_km from the destination's centre is taken to be another
    place of the same name and ignored. It is not cached, so the place is looked up
    again if the destination is later understood differently.
    """
    found: dict[str, GeoPoint | None] = {}
    for place in dict.fromkeys(places):
        key = _key(place, destination)
        cached = await db.scalar(select(GeocodedPlace).where(GeocodedPlace.key == key))
        if cached is not None:
            point = GeoPoint(cached.latitude, cached.longitude, cached.label) if cached.latitude is not None else None
            if point is None or center is None or haversine_km(point, center) <= max_km:
                found[place] = point
                continue
        point = await geocoder.geocode(f"{place}, {destination}".strip(", "))
        if point and center and haversine_km(point, center) > max_km:
            logger.info("geocode for %r is %.0f km from %s; ignoring", place, haversine_km(point, center), destination)
            found[place] = None
            continue
        found[place] = point
        db.add(
            GeocodedPlace(
                key=key,
                latitude=point.latitude if point else None,
                longitude=point.longitude if point else None,
                label=(point.label if point else "")[:400],
            )
        )
        await db.commit()
    return found


async def _matrix(router: RoutingProvider, points: list[GeoPoint]) -> TravelMatrix:
    if len(points) < 2:
        return TravelMatrix([[0.0]] * len(points), [[0.0]] * len(points), "")
    try:
        return await router.matrix(points)
    except MapsError as exc:
        logger.warning("routing failed, using straight-line estimate: %s", exc)
        return straight_line_matrix(points)


def _maps_url(points: list[GeoPoint]) -> str | None:
    if len(points) < 2:
        return None
    pair = lambda point: f"{point.latitude:.6f},{point.longitude:.6f}"  # noqa: E731
    query = {"api": 1, "origin": pair(points[0]), "destination": pair(points[-1]), "travelmode": "driving"}
    if len(points) > 2:
        query["waypoints"] = "|".join(pair(point) for point in points[1:-1])
    return "https://www.google.com/maps/dir/?" + urlencode(query)


def _day_route(
    stops: list[str], index: dict[str, int], points: list[GeoPoint], matrix: TravelMatrix
) -> DayRoute:
    located = [stop for stop in stops if stop in index]
    route = DayRoute(stops=stops, unlocated=[stop for stop in stops if stop not in index])
    total_minutes = 0.0
    for origin, target in zip(located, located[1:]):
        if origin == target:
            continue
        km = matrix.distances_km[index[origin]][index[target]]
        minutes = matrix.minutes[index[origin]][index[target]]
        route.legs.append({"from": origin, "to": target, "km": round(km, 1), "minutes": round(minutes)})
        route.total_km += km
        total_minutes += minutes
    route.total_km = round(route.total_km, 1)
    route.total_minutes = round(total_minutes)
    route.maps_url = _maps_url([points[index[stop]] for stop in dict.fromkeys(located)])
    return route


# ---------- public operations ----------


async def optimize(
    db: AsyncSession,
    geocoder: GeocodingProvider,
    router: RoutingProvider,
    destination: str,
    places: list[str],
    day_count: int,
    center: GeoPoint | None = None,
    start_from: str | None = None,
    max_km: float = MAX_KM_FROM_DESTINATION,
) -> RoutePlan:
    """Shortest order through the places, cut into days of neighbouring stops."""
    places = list(dict.fromkeys(place.strip() for place in places if place.strip()))
    lookups = places + ([start_from] if start_from and start_from not in places else [])
    located = await locate(db, geocoder, destination, lookups, center, max_km)

    names = [place for place in places if located[place]]
    unlocated = [place for place in places if not located[place]]
    base = located.get(start_from) if start_from else None
    points = ([base] if base else []) + [located[name] for name in names]
    matrix = await _matrix(router, points)

    order = shortest_open_path(matrix.distances_km, start=0 if base else None) if points else []
    offset = 1 if base else 0
    stop_order = [position - offset for position in order if position >= offset]
    index = {name: position + offset for position, name in enumerate(names)}

    days = [
        _day_route([names[position] for position in group], index, points, matrix)
        for group in split_into_days(stop_order, day_count)
    ]
    return RoutePlan(days=days, unlocated=unlocated, source=matrix.source)


async def measure(
    db: AsyncSession,
    geocoder: GeocodingProvider,
    router: RoutingProvider,
    destination: str,
    days: list[list[str]],
    center: GeoPoint | None = None,
    max_km: float = MAX_KM_FROM_DESTINATION,
) -> RoutePlan:
    """Travel within each day as planned, and whether a day's order wastes distance."""
    located = await locate(db, geocoder, destination, [stop for day in days for stop in day], center, max_km)
    names = [name for name, point in located.items() if point]
    points = [located[name] for name in names]
    index = {name: position for position, name in enumerate(names)}
    matrix = await _matrix(router, points)

    routes = []
    for stops in days:
        route = _day_route(stops, index, points, matrix)
        unique = list(dict.fromkeys(stop for stop in stops if stop in index))
        if len(unique) > 2:
            sub = [[matrix.distances_km[index[a]][index[b]] for b in unique] for a in unique]
            best = shortest_open_path(sub)
            best_km = path_length(best, sub)
            if route.total_km - best_km > WORTH_REORDERING_KM and route.total_km > best_km * WORTH_REORDERING_RATIO:
                route.shorter_order = [unique[position] for position in best]
        routes.append(route)
    return RoutePlan(days=routes, unlocated=[name for name, point in located.items() if not point], source=matrix.source)
