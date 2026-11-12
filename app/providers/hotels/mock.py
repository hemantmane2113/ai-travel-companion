"""Simulated hotel providers.

MOCK: nothing here talks to a real booking site. Hotels are fictional, prices are
generated, and "bookings" are rows in our own database. They exist so the search ->
compare -> confirm -> book -> cancel flow can be built and tested end to end. A real
provider is added by writing another HotelProvider adapter.
"""

import hashlib
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import MockProviderBooking
from app.providers.hotels.base import HotelProvider, HotelProviderError, OfferUnavailable, PriceChanged
from app.schemas.hotel import CancellationQuote, HotelOffer, HotelSearch, ProviderBooking

CURRENCY = "INR"
DEFAULT_AREA = "City centre"


@dataclass(frozen=True)
class _Hotel:
    id: str
    name: str
    stars: int
    rating: float
    reviews: int
    base_price: int  # per room per night
    room_type: str
    amenities: tuple[str, ...]


_CATALOGUE = (
    _Hotel("peepal-tree-inn", "Peepal Tree Inn", 2, 7.4, 812, 1800, "Standard Double", ("Wi-Fi", "Air conditioning")),
    _Hotel("banyan-court", "Banyan Court", 3, 8.1, 1540, 2600, "Deluxe Double", ("Wi-Fi", "Air conditioning", "Restaurant")),
    _Hotel("saffron-gate-residency", "Saffron Gate Residency", 3, 7.9, 967, 3200, "Superior Twin", ("Wi-Fi", "Restaurant", "Airport shuttle")),
    _Hotel("the-lantern-house", "The Lantern House", 4, 8.6, 2210, 4800, "Premium King", ("Wi-Fi", "Pool", "Restaurant", "Gym")),
    _Hotel("marigold-suites", "Marigold Suites", 4, 8.8, 1325, 7200, "Junior Suite", ("Wi-Fi", "Pool", "Spa", "Restaurant", "Gym")),
    _Hotel("indigo-terrace-hotel", "Indigo Terrace Hotel", 5, 9.2, 3480, 11500, "Executive Suite", ("Wi-Fi", "Pool", "Spa", "Restaurant", "Gym", "Butler service")),
)
_HOTELS = {hotel.id: hotel for hotel in _CATALOGUE}


@dataclass(frozen=True)
class MockProfile:
    id: str
    name: str
    reference_prefix: str
    price_factor: float
    tax_rate: float
    free_cancellation_days: int | None  # days before check-in; None = non-refundable
    breakfast_included: bool
    skips: tuple[str, ...]  # hotels this provider does not list


MOCK_PROFILES = (
    MockProfile("stayeasy", "StayEasy (demo)", "SE", 1.00, 0.12, 2, False, ("indigo-terrace-hotel",)),
    MockProfile("roomhub", "RoomHub (demo)", "RH", 0.91, 0.12, None, False, ("peepal-tree-inn",)),
    MockProfile("tripnest", "TripNest (demo)", "TN", 1.07, 0.14, 1, True, ("saffron-gate-residency",)),
)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _money(value: float | Decimal) -> Decimal:
    return Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP)


class MockHotelProvider(HotelProvider):
    is_demo = True

    def __init__(
        self,
        profile: MockProfile,
        session_factory: async_sessionmaker[AsyncSession],
        today: Callable[[], date] = date.today,
    ):
        self._profile = profile
        self._session_factory = session_factory
        self._today = today
        self.id = profile.id
        self.name = profile.name

    # ---------- offers ----------

    def _offer_id(self, hotel: _Hotel, search: HotelSearch) -> str:
        return "|".join(
            [
                hotel.id,
                _slug(search.destination),
                _slug(search.area or DEFAULT_AREA),
                search.check_in.isoformat(),
                search.check_out.isoformat(),
                str(search.adults),
                str(search.rooms),
            ]
        )

    def _quote(self, hotel: _Hotel, search: HotelSearch) -> HotelOffer:
        profile = self._profile
        # Stable per provider, hotel, city and date, so a re-quote matches the search.
        seed = f"{profile.id}|{hotel.id}|{_slug(search.destination)}|{search.check_in.isoformat()}"
        jitter = int(hashlib.sha256(seed.encode()).hexdigest()[:4], 16) / 0xFFFF  # 0..1
        nightly = _money(hotel.base_price * profile.price_factor * (0.94 + 0.12 * jitter))
        subtotal = nightly * search.nights * search.rooms
        taxes = _money(subtotal * Decimal(str(profile.tax_rate)))

        if profile.free_cancellation_days is None:
            free_until = None
            policy = "Non-refundable."
        else:
            free_until = search.check_in - timedelta(days=profile.free_cancellation_days)
            policy = (
                f"Free cancellation until {free_until.strftime('%d %b %Y')}. "
                "After that the first night is charged."
            )

        return HotelOffer(
            provider=profile.id,
            provider_name=profile.name,
            is_demo=True,
            provider_offer_id=self._offer_id(hotel, search),
            hotel_id=hotel.id,
            hotel_name=hotel.name,
            area=(search.area or DEFAULT_AREA).title(),
            star_rating=hotel.stars,
            guest_rating=hotel.rating,
            review_count=hotel.reviews,
            amenities=list(hotel.amenities),
            room_type=hotel.room_type,
            breakfast_included=profile.breakfast_included,
            check_in=search.check_in,
            check_out=search.check_out,
            nights=search.nights,
            rooms=search.rooms,
            adults=search.adults,
            price_per_night=nightly,
            taxes_and_fees=taxes,
            total_price=subtotal + taxes,
            currency=CURRENCY,
            free_cancellation_until=free_until,
            cancellation_policy=policy,
            retrieved_at=datetime.now(UTC),
        )

    async def search(self, search: HotelSearch) -> list[HotelOffer]:
        return [self._quote(hotel, search) for hotel in _CATALOGUE if hotel.id not in self._profile.skips]

    async def get_offer(self, provider_offer_id: str) -> HotelOffer:
        try:
            hotel_id, destination, area, check_in, check_out, adults, rooms = provider_offer_id.split("|")
            hotel = _HOTELS[hotel_id]
            search = HotelSearch(
                destination=destination,
                area=area.replace("-", " "),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                adults=int(adults),
                rooms=int(rooms),
            )
        except (ValueError, KeyError) as exc:
            raise OfferUnavailable("This offer is no longer available.") from exc
        if hotel.id in self._profile.skips or search.check_in < self._today():
            raise OfferUnavailable("This offer is no longer available.")
        return self._quote(hotel, search)

    # ---------- bookings ----------

    async def book(self, provider_offer_id: str, expected_total: Decimal, guest_name: str) -> ProviderBooking:
        offer = await self.get_offer(provider_offer_id)
        if offer.total_price != expected_total:
            raise PriceChanged(f"The price is now {offer.currency} {offer.total_price}.")

        reference = f"{self._profile.reference_prefix}-{secrets.token_hex(4).upper()}"
        async with self._session_factory() as db:
            db.add(
                MockProviderBooking(
                    provider=self.id,
                    reference=reference,
                    guest_name=guest_name,
                    total_price=offer.total_price,
                    first_night_charge=offer.price_per_night * offer.rooms,
                    currency=offer.currency,
                    free_cancellation_until=offer.free_cancellation_until,
                    non_refundable=offer.free_cancellation_until is None,
                    status="BOOKED",
                )
            )
            await db.commit()
        return ProviderBooking(reference=reference, total_price=offer.total_price, currency=offer.currency)

    async def _load(self, db: AsyncSession, reference: str) -> MockProviderBooking:
        row = await db.scalar(
            select(MockProviderBooking).where(
                MockProviderBooking.provider == self.id, MockProviderBooking.reference == reference
            )
        )
        if row is None:
            raise HotelProviderError(f"{self.name} has no booking with reference {reference}.")
        if row.status == "CANCELLED":
            raise HotelProviderError(f"{self.name} booking {reference} is already cancelled.")
        return row

    def _refund(self, row: MockProviderBooking) -> CancellationQuote:
        total = Decimal(row.total_price)
        if row.non_refundable:
            fee = total
        elif self._today() <= row.free_cancellation_until:
            fee = Decimal(0)
        else:
            fee = min(Decimal(row.first_night_charge), total)
        return CancellationQuote(refund_amount=total - fee, fee=fee, currency=row.currency)

    async def cancellation_quote(self, reference: str) -> CancellationQuote:
        async with self._session_factory() as db:
            return self._refund(await self._load(db, reference))

    async def cancel(self, reference: str) -> CancellationQuote:
        async with self._session_factory() as db:
            row = await self._load(db, reference)
            quote = self._refund(row)
            row.status = "CANCELLED"
            await db.commit()
            return quote


def build_mock_providers(
    session_factory: async_sessionmaker[AsyncSession], today: Callable[[], date] = date.today
) -> dict[str, HotelProvider]:
    return {profile.id: MockHotelProvider(profile, session_factory, today) for profile in MOCK_PROFILES}
