"""Finding restaurants for a dish near an area, and reserving a table."""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RestaurantRecord, TableBooking
from app.models.booking import CANCELLED, CONFIRMED, EXPIRED, FAILED, PENDING_CONFIRMATION
from app.providers.maps.base import GeocodingProvider, GeoPoint
from app.providers.restaurants.base import (
    Restaurant,
    RestaurantSearchProvider,
    RestaurantsError,
    TableReservationProvider,
)
from app.services import route_service, travel_dates

logger = logging.getLogger(__name__)

SEARCH_RADIUS_M = 2500
MAX_RESULTS = 8
# A traveller's own position is sent to outside services rounded to about 100 m.
LOCATION_DECIMALS = 3
CONFIRMATION_WINDOW = timedelta(minutes=15)
MAX_DAYS_AHEAD = 90
MAX_PARTY_SIZE = 20
PROVIDER_TIMEOUT_SECONDS = 20.0


class RestaurantSearchError(Exception):
    """The search cannot be run as asked. The message explains why."""


class TableBookingError(Exception):
    """The requested reservation action cannot be done. The message is safe to show."""


class TableBookingNotFound(TableBookingError):
    pass


@dataclass
class Match:
    record_id: int
    restaurant: Restaurant
    distance_km: float
    matched_on: list[str]  # which of the traveller's keywords this place matched, and where


@dataclass
class SearchResult:
    area_label: str
    matches: list[Match]
    nearby_count: int  # places to eat found in the area before filtering
    keywords: list[str]
    near_traveller: bool = False  # searched around the traveller's shared position


# ---------- search ----------


def _normalise(text: str) -> str:
    return " ".join(text.lower().replace("_", " ").split())


# Words that match most restaurants in a region and so say nothing about a dish.
GENERIC_KEYWORDS = frozenset(
    {"indian", "restaurant", "restaurants", "food", "cuisine", "regional", "local", "multi cuisine", "multicuisine",
     "dinner", "lunch", "meal", "curry", "north indian", "asian"}
)
_VEG_ONLY_NAME = ("pure veg", "veg only", "pure vegetarian", "shudh shakahari")


def is_vegetarian_only(restaurant: Restaurant) -> bool:
    name = _normalise(restaurant.name)
    return restaurant.vegetarian_only or any(marker in name for marker in _VEG_ONLY_NAME)


def score(restaurant: Restaurant, keywords: list[str]) -> tuple[int, list[str]]:
    """How well a place matches the keywords. A cuisine it is tagged with counts
    for more than a word that merely appears in its name."""
    cuisines = [_normalise(c) for c in restaurant.cuisines]
    name = _normalise(restaurant.name)
    points, reasons = 0, []
    for keyword in keywords:
        if any(keyword in cuisine for cuisine in cuisines):
            points += 2
            reasons.append(f"serves {keyword}")
        elif keyword in name:
            points += 1
            reasons.append(f"'{keyword}' in its name")
    return points, reasons


def rank(
    restaurants: list[Restaurant], center: GeoPoint, keywords: list[str], needs_non_veg: bool = False
) -> list[tuple[Restaurant, float, list[str]]]:
    """Best keyword match first, nearer first among equals. With no keywords, nearest first.

    Vegetarian-only places are left out when the dish is meat or fish.
    """
    rows = []
    for restaurant in restaurants:
        if needs_non_veg and is_vegetarian_only(restaurant):
            continue
        distance = route_service.haversine_km(center, GeoPoint(restaurant.latitude, restaurant.longitude))
        points, reasons = score(restaurant, keywords)
        if keywords and points == 0:
            continue
        rows.append((points, distance, restaurant, reasons))
    rows.sort(key=lambda row: (-row[0], row[1], row[2].name))
    return [(restaurant, distance, reasons) for _, distance, restaurant, reasons in rows]


async def find(
    db: AsyncSession,
    geocoder: GeocodingProvider,
    provider: RestaurantSearchProvider,
    city: str | None,
    area: str | None,
    keywords: list[str],
    user_id: int,
    conversation_id: int,
    needs_non_veg: bool = False,
    near: GeoPoint | None = None,
    near_label: str | None = None,
) -> SearchResult:
    """Places to eat around a named area, or around `near` (the traveller's own position)."""
    if near is not None:
        center = near
        # The search service is sent the point rounded to about 100 m; distances are
        # measured from the exact point, which never leaves this function.
        search_from = GeoPoint(round(near.latitude, LOCATION_DECIMALS), round(near.longitude, LOCATION_DECIMALS))
        area_label = near_label or "your location"
    else:
        if not city:
            raise RestaurantSearchError("Say which city to search in, or search near the traveller.")
        place = area or city
        located = await route_service.locate(db, geocoder, city if area else "", [place], center=None)
        center = search_from = located[place]
        if center is None:
            where = f"{area}, {city}" if area else city
            raise RestaurantSearchError(
                f"Could not find '{where}' on the map. Ask the traveller for a nearby landmark or area."
            )
        area_label = f"{area}, {city}" if area else city

    keywords = list(dict.fromkeys(_normalise(k) for k in keywords if k.strip()))
    keywords = [k for k in keywords if k not in GENERIC_KEYWORDS]
    try:
        nearby = await provider.nearby(search_from, SEARCH_RADIUS_M)
    except RestaurantsError as exc:
        raise RestaurantSearchError(str(exc)) from exc

    ranked = rank(nearby, center, keywords, needs_non_veg)[:MAX_RESULTS]
    records = [
        RestaurantRecord(user_id=user_id, conversation_id=conversation_id, data=restaurant.model_dump(mode="json"))
        for restaurant, _, _ in ranked
    ]
    db.add_all(records)
    await db.commit()
    return SearchResult(
        area_label=area_label,
        near_traveller=near is not None,
        matches=[
            Match(record.id, restaurant, round(distance, 2), reasons)
            for record, (restaurant, distance, reasons) in zip(records, ranked)
        ],
        nearby_count=len(nearby),
        keywords=keywords,
    )


def search_card(result: SearchResult, dish: str | None) -> dict[str, Any]:
    return {
        "type": "restaurants",
        "area": result.area_label,
        "near_traveller": result.near_traveller,
        "dish": dish,
        "keywords": result.keywords,
        "nearby_count": result.nearby_count,
        "radius_km": SEARCH_RADIUS_M / 1000,
        "restaurants": [
            {
                "restaurant_id": match.record_id,
                "name": match.restaurant.name,
                "cuisines": match.restaurant.cuisines,
                "address": match.restaurant.address,
                "distance_km": match.distance_km,
                "latitude": match.restaurant.latitude,
                "longitude": match.restaurant.longitude,
                "opening_hours": match.restaurant.opening_hours,
                "phone": match.restaurant.phone,
                "website": match.restaurant.website,
                "vegetarian_only": match.restaurant.vegetarian_only,
                "matched_on": match.matched_on,
                "source_url": match.restaurant.source_url,
            }
            for match in result.matches
        ],
    }


def search_for_model(result: SearchResult) -> dict[str, Any]:
    data: dict[str, Any] = {
        "area": result.area_label,
        "places_to_eat_mapped_nearby": result.nearby_count,
        "restaurants": [
            {
                "restaurant_id": match.record_id,
                "name": match.restaurant.name,
                "cuisines": match.restaurant.cuisines[:6],
                "distance_km": match.distance_km,
                "matched_on": match.matched_on,
                "opening_hours": match.restaurant.opening_hours,
                "vegetarian_only": match.restaurant.vegetarian_only,
            }
            for match in result.matches
        ],
        "about_this_data": (
            "From OpenStreetMap: it has no ratings, reviews, prices or menus, so there is no basis for calling "
            "any of these the best, and a cuisine match does not confirm a particular dish is served. Order is "
            "closeness of match, then distance. Say this plainly; do not invent ratings or praise."
        ),
    }
    if not result.matches:
        data["note"] = (
            "Nothing mapped in this area matches those keywords. Say so; do not suggest restaurants from memory. "
            "Offer to try broader keywords or a neighbouring area."
        )
    else:
        data["reply_instructions"] = (
            "The traveller already sees these as a list with Book buttons. Do not list them again. Reply in at "
            "most four sentences: which match most closely and why, and the limits of the data."
        )
    return data


# ---------- reservations ----------


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def _call(coroutine, provider: TableReservationProvider):
    try:
        return await asyncio.wait_for(coroutine, PROVIDER_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        raise RestaurantsError(f"{provider.name} did not respond in time.") from exc


async def get_booking(db: AsyncSession, user_id: int, booking_id: int) -> TableBooking:
    booking = await db.get(TableBooking, booking_id)
    if booking is None or booking.user_id != user_id:
        raise TableBookingNotFound("Reservation not found.")
    return booking


async def list_bookings(db: AsyncSession, user_id: int) -> list[TableBooking]:
    rows = await db.scalars(select(TableBooking).where(TableBooking.user_id == user_id).order_by(TableBooking.id.desc()))
    return list(rows)


def booking_view(booking: TableBooking, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    status = booking.status
    if status == PENDING_CONFIRMATION and _aware(booking.expires_at) <= now:
        status = EXPIRED
    restaurant = booking.restaurant
    return {
        "id": booking.id,
        "status": status,
        "restaurant_name": restaurant["name"],
        "address": restaurant["address"],
        "opening_hours": restaurant["opening_hours"],
        "phone": restaurant["phone"],
        "date": booking.day.isoformat(),
        "time": booking.at.strftime("%H:%M"),
        "party_size": booking.party_size,
        "guest_name": booking.guest_name,
        "provider_name": booking.provider_name,
        "is_demo": booking.is_demo,
        "provider_reference": booking.provider_reference,
        "failure_reason": booking.failure_reason,
    }


async def prepare(
    db: AsyncSession,
    provider: TableReservationProvider,
    user_id: int,
    conversation_id: int,
    restaurant_id: int,
    day: date,
    at: time,
    party_size: int,
    guest_name: str,
    today: date,
    now: datetime | None = None,
) -> TableBooking:
    """Hold the details for the traveller to confirm. Nothing is reserved here."""
    now = now or datetime.now(UTC)
    record = await db.get(RestaurantRecord, restaurant_id)
    if record is None or record.user_id != user_id:
        raise TableBookingError(f"There is no restaurant {restaurant_id}. Use a restaurant_id from find_restaurants.")
    if day < today:
        raise TableBookingError(travel_dates.past_dates_message(day, None, today))
    if day > today + timedelta(days=MAX_DAYS_AHEAD):
        raise TableBookingError(f"Tables can be reserved at most {MAX_DAYS_AHEAD} days ahead.")
    if not 1 <= party_size <= MAX_PARTY_SIZE:
        raise TableBookingError(f"Party size must be between 1 and {MAX_PARTY_SIZE}.")

    booking = TableBooking(
        user_id=user_id,
        conversation_id=conversation_id,
        status=PENDING_CONFIRMATION,
        restaurant=record.data,
        day=day,
        at=at,
        party_size=party_size,
        guest_name=guest_name.strip(),
        provider_name=provider.name,
        is_demo=provider.is_demo,
        expires_at=now + CONFIRMATION_WINDOW,
    )
    db.add(booking)
    await db.commit()
    return booking


async def confirm(
    db: AsyncSession, provider: TableReservationProvider, user_id: int, booking_id: int, now: datetime | None = None
) -> TableBooking:
    """Place the reservation. Only the traveller's own action reaches this."""
    now = now or datetime.now(UTC)
    booking = await get_booking(db, user_id, booking_id)
    if booking.status != PENDING_CONFIRMATION:
        raise TableBookingError(f"This reservation is {booking.status.lower().replace('_', ' ')} and cannot be confirmed.")
    if _aware(booking.expires_at) <= now:
        booking.status = EXPIRED
        await db.commit()
        raise TableBookingError("This request has expired. Ask for the table again.")

    try:
        reference = await _call(
            provider.reserve(
                Restaurant.model_validate(booking.restaurant), booking.day, booking.at, booking.party_size, booking.guest_name
            ),
            provider,
        )
    except RestaurantsError as exc:
        # Not confirmed by the provider, so it is not a reservation.
        booking.status = FAILED
        booking.failure_reason = str(exc)
        await db.commit()
        logger.warning("table reservation failed id=%s reason=%s", booking.id, exc)
        return booking

    booking.status = CONFIRMED
    booking.provider_reference = reference
    booking.confirmed_at = now
    await db.commit()
    logger.info("table reservation confirmed id=%s", booking.id)
    return booking


async def cancel(
    db: AsyncSession, provider: TableReservationProvider, user_id: int, booking_id: int, now: datetime | None = None
) -> TableBooking:
    now = now or datetime.now(UTC)
    booking = await get_booking(db, user_id, booking_id)
    if booking.status != CONFIRMED:
        raise TableBookingError(
            f"Reservation {booking.id} is {booking.status.lower().replace('_', ' ')}, so it cannot be cancelled."
        )
    try:
        await _call(provider.cancel(booking.provider_reference), provider)
    except RestaurantsError as exc:
        # The provider did not confirm, so the reservation stays as it was.
        logger.warning("table cancellation failed id=%s reason=%s", booking.id, exc)
        raise TableBookingError(f"{exc} The reservation has not been cancelled.") from exc
    booking.status = CANCELLED
    booking.cancelled_at = now
    await db.commit()
    logger.info("table reservation cancelled id=%s", booking.id)
    return booking
