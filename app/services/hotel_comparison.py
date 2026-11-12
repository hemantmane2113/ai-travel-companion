import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import HotelOfferRecord
from app.providers.hotels.base import HotelProvider
from app.schemas.hotel import HotelOffer, HotelSearch
from app.services import travel_dates

logger = logging.getLogger(__name__)

PROVIDER_TIMEOUT_SECONDS = 8.0
MAX_OFFERS = 15
MAX_NIGHTS = 30

SortBy = Literal["price", "rating"]


class HotelSearchError(Exception):
    """The search request is not valid. The message explains what to fix."""


@dataclass
class Comparison:
    search: HotelSearch
    offers: list[tuple[int, HotelOffer]]  # (stored offer id, offer), best first
    failed_providers: list[str]
    providers_searched: list[str]


def validate_search(search: HotelSearch, today: date) -> None:
    if search.check_in < today:
        raise HotelSearchError(travel_dates.past_dates_message(search.check_in, search.check_out, today))
    if search.check_out <= search.check_in:
        raise HotelSearchError("check_out must be after check_in.")
    if search.nights > MAX_NIGHTS:
        raise HotelSearchError(f"Stays longer than {MAX_NIGHTS} nights are not supported.")


async def _search_one(provider: HotelProvider, search: HotelSearch) -> list[HotelOffer]:
    started = time.monotonic()
    try:
        offers = await asyncio.wait_for(provider.search(search), PROVIDER_TIMEOUT_SECONDS)
    finally:
        logger.info("hotel search provider=%s seconds=%.2f", provider.id, time.monotonic() - started)
    return offers


def sort_offers(offers: list[HotelOffer], sort_by: SortBy) -> list[HotelOffer]:
    if sort_by == "rating":
        return sorted(offers, key=lambda offer: (-offer.guest_rating, offer.total_price))
    return sorted(offers, key=lambda offer: (offer.total_price, -offer.guest_rating))


async def compare(
    db: AsyncSession,
    providers: dict[str, HotelProvider],
    search: HotelSearch,
    user_id: int,
    conversation_id: int,
    today: date,
    sort_by: SortBy = "price",
    max_total_price: Decimal | None = None,
) -> Comparison:
    """Ask every provider at once; one slow or broken provider does not sink the rest."""
    validate_search(search, today)

    results = await asyncio.gather(
        *(_search_one(provider, search) for provider in providers.values()), return_exceptions=True
    )
    offers: list[HotelOffer] = []
    failed: list[str] = []
    for provider, result in zip(providers.values(), results):
        if isinstance(result, BaseException):
            logger.warning("hotel search failed provider=%s error=%r", provider.id, result)
            failed.append(provider.name)
        else:
            offers.extend(result)

    if max_total_price is not None:
        offers = [offer for offer in offers if offer.total_price <= max_total_price]
    offers = sort_offers(offers, sort_by)[:MAX_OFFERS]

    records = [
        HotelOfferRecord(
            user_id=user_id, conversation_id=conversation_id, provider=offer.provider, data=offer.model_dump(mode="json")
        )
        for offer in offers
    ]
    db.add_all(records)
    await db.commit()

    return Comparison(
        search=search,
        offers=[(record.id, offer) for record, offer in zip(records, offers)],
        failed_providers=failed,
        providers_searched=[provider.name for provider in providers.values()],
    )


def comparison_card(comparison: Comparison) -> dict[str, Any]:
    """Offers grouped by hotel, so the same room on different sites sits side by side."""
    search = comparison.search
    hotels: dict[str, dict[str, Any]] = {}
    for offer_id, offer in comparison.offers:
        hotel = hotels.setdefault(
            offer.hotel_id,
            {
                "hotel_name": offer.hotel_name,
                "area": offer.area,
                "star_rating": offer.star_rating,
                "guest_rating": offer.guest_rating,
                "review_count": offer.review_count,
                "amenities": offer.amenities,
                "offers": [],
            },
        )
        hotel["offers"].append(
            {
                "offer_id": offer_id,
                "provider_name": offer.provider_name,
                "room_type": offer.room_type,
                "breakfast_included": offer.breakfast_included,
                "price_per_night": float(offer.price_per_night),
                "taxes_and_fees": float(offer.taxes_and_fees),
                "total_price": float(offer.total_price),
                "currency": offer.currency,
                "cancellation_policy": offer.cancellation_policy,
            }
        )
    for hotel in hotels.values():
        hotel["offers"].sort(key=lambda entry: entry["total_price"])
        hotel["offers"][0]["cheapest"] = len(hotel["offers"]) > 1

    return {
        "type": "hotel_comparison",
        "destination": search.destination,
        "area": search.area,
        "check_in": search.check_in.isoformat(),
        "check_out": search.check_out.isoformat(),
        "nights": search.nights,
        "adults": search.adults,
        "rooms": search.rooms,
        "is_demo": any(offer.is_demo for _, offer in comparison.offers),
        "providers_searched": comparison.providers_searched,
        "failed_providers": comparison.failed_providers,
        "hotels": list(hotels.values()),
    }


def comparison_for_model(comparison: Comparison) -> dict[str, Any]:
    offers = [
        {
            "offer_id": offer_id,
            "hotel": offer.hotel_name,
            "provider": offer.provider_name,
            "guest_rating": offer.guest_rating,
            "breakfast_included": offer.breakfast_included,
            "total_price": float(offer.total_price),
            "free_cancellation_until": (
                offer.free_cancellation_until.isoformat() if offer.free_cancellation_until else "non-refundable"
            ),
        }
        for offer_id, offer in comparison.offers
    ]
    data: dict[str, Any] = {
        "nights": comparison.search.nights,
        "rooms": comparison.search.rooms,
        "currency": comparison.offers[0][1].currency if comparison.offers else None,
        "total_price_includes": "all nights, all rooms, taxes and fees",
        "offers": offers,
        "cheapest_offer_id": min(offers, key=lambda entry: entry["total_price"])["offer_id"] if offers else None,
        "providers_searched": comparison.providers_searched,
        "failed_providers": comparison.failed_providers,
    }
    if offers:
        data["reply_instructions"] = (
            "The traveller already sees every offer in a comparison table with Book buttons. Do not list or "
            "tabulate the offers. Reply in at most four sentences about what stands out."
        )
    if any(offer.is_demo for _, offer in comparison.offers):
        data["demo_data"] = "These are simulated demo providers, hotels and prices, not real ones. Tell the traveller."
    if not offers:
        data["note"] = "No offers matched. Say so; do not suggest hotels or prices from memory."
    return data
