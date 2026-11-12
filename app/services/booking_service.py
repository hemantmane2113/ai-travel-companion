import asyncio
import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Booking, HotelOfferRecord
from app.models.booking import CANCELLED, CONFIRMED, EXPIRED, FAILED, PENDING_CONFIRMATION
from app.providers.hotels.base import HotelProvider, HotelProviderError
from app.schemas.hotel import CancellationQuote, HotelOffer

logger = logging.getLogger(__name__)

CONFIRMATION_WINDOW = timedelta(minutes=15)
PROVIDER_TIMEOUT_SECONDS = 20.0


class BookingError(Exception):
    """The requested booking action cannot be done. The message is safe to show."""


class BookingNotFound(BookingError):
    pass


class RefundChanged(BookingError):
    def __init__(self, quote: CancellationQuote):
        super().__init__("The refund amount has changed since it was shown.")
        self.quote = quote


def _aware(value: datetime) -> datetime:
    # SQLite hands datetimes back without a timezone; they were stored as UTC.
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _provider(providers: dict[str, HotelProvider], provider_id: str) -> HotelProvider:
    provider = providers.get(provider_id)
    if provider is None:
        raise BookingError("That provider is no longer available.")
    return provider


async def _call(coroutine, provider: HotelProvider):
    try:
        return await asyncio.wait_for(coroutine, PROVIDER_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        raise HotelProviderError(f"{provider.name} did not respond in time.") from exc


async def get_booking(db: AsyncSession, user_id: int, booking_id: int) -> Booking:
    booking = await db.get(Booking, booking_id)
    if booking is None or booking.user_id != user_id:
        raise BookingNotFound("Booking not found.")
    return booking


async def list_bookings(db: AsyncSession, user_id: int) -> list[Booking]:
    rows = await db.scalars(select(Booking).where(Booking.user_id == user_id).order_by(Booking.id.desc()))
    return list(rows)


def booking_view(booking: Booking, providers: dict[str, HotelProvider], now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    offer = booking.offer
    status = booking.status
    if status == PENDING_CONFIRMATION and _aware(booking.expires_at) <= now:
        status = EXPIRED
    provider = providers.get(booking.provider)
    return {
        "id": booking.id,
        "status": status,
        "hotel_name": offer["hotel_name"],
        "area": offer["area"],
        "provider_name": offer["provider_name"],
        "is_demo": offer["is_demo"],
        "room_type": offer["room_type"],
        "breakfast_included": offer["breakfast_included"],
        "check_in": offer["check_in"],
        "check_out": offer["check_out"],
        "nights": offer["nights"],
        "rooms": offer["rooms"],
        "adults": offer["adults"],
        "taxes_and_fees": float(offer["taxes_and_fees"]),
        "total_price": float(booking.total_price),
        "currency": booking.currency,
        "cancellation_policy": offer["cancellation_policy"],
        "guest_name": booking.guest_name,
        "provider_reference": booking.provider_reference,
        "failure_reason": booking.failure_reason,
        "refund_amount": float(booking.refund_amount) if booking.refund_amount is not None else None,
        "cancellation_fee": float(booking.cancellation_fee) if booking.cancellation_fee is not None else None,
        "provider_available": provider is not None,
    }


async def prepare(
    db: AsyncSession,
    providers: dict[str, HotelProvider],
    user_id: int,
    conversation_id: int,
    offer_id: int,
    guest_name: str,
    now: datetime | None = None,
) -> tuple[Booking, Decimal | None]:
    """Re-quote the chosen offer and hold it for the traveller to confirm.

    Nothing is booked here. Returns the pending booking and, if the price moved
    since the offer was shown, the price it was shown at.
    """
    now = now or datetime.now(UTC)
    record = await db.get(HotelOfferRecord, offer_id)
    if record is None or record.user_id != user_id:
        raise BookingError(f"There is no offer {offer_id}. Use an offer_id from compare_hotels.")
    shown = HotelOffer.model_validate(record.data)
    provider = _provider(providers, record.provider)

    current = await _call(provider.get_offer(shown.provider_offer_id), provider)
    previous_price = shown.total_price if current.total_price != shown.total_price else None

    booking = Booking(
        user_id=user_id,
        conversation_id=conversation_id,
        status=PENDING_CONFIRMATION,
        provider=record.provider,
        offer=current.model_dump(mode="json"),
        total_price=current.total_price,
        currency=current.currency,
        guest_name=guest_name.strip(),
        expires_at=now + CONFIRMATION_WINDOW,
    )
    db.add(booking)
    await db.commit()
    return booking, previous_price


async def confirm(
    db: AsyncSession,
    providers: dict[str, HotelProvider],
    user_id: int,
    booking_id: int,
    now: datetime | None = None,
) -> Booking:
    """Place the booking with the provider. Only the traveller's own action reaches this."""
    now = now or datetime.now(UTC)
    booking = await get_booking(db, user_id, booking_id)
    if booking.status != PENDING_CONFIRMATION:
        raise BookingError(f"This booking is {booking.status.lower().replace('_', ' ')} and cannot be confirmed.")
    if _aware(booking.expires_at) <= now:
        booking.status = EXPIRED
        await db.commit()
        raise BookingError("This quote has expired. Ask for the hotel again to get a current price.")

    try:
        provider = _provider(providers, booking.provider)
        result = await _call(
            provider.book(booking.offer["provider_offer_id"], Decimal(booking.total_price), booking.guest_name),
            provider,
        )
    except (HotelProviderError, BookingError) as exc:
        # Not confirmed by the provider, so it is not a booking.
        booking.status = FAILED
        booking.failure_reason = str(exc)
        await db.commit()
        logger.warning("booking failed id=%s provider=%s reason=%s", booking.id, booking.provider, exc)
        return booking

    booking.status = CONFIRMED
    booking.provider_reference = result.reference
    booking.confirmed_at = now
    await db.commit()
    logger.info("booking confirmed id=%s provider=%s", booking.id, booking.provider)
    return booking


async def cancellation_quote(
    db: AsyncSession, providers: dict[str, HotelProvider], user_id: int, booking_id: int
) -> tuple[Booking, CancellationQuote]:
    booking = await get_booking(db, user_id, booking_id)
    if booking.status != CONFIRMED:
        raise BookingError(f"Booking {booking.id} is {booking.status.lower().replace('_', ' ')}, so it cannot be cancelled.")
    provider = _provider(providers, booking.provider)
    try:
        quote = await _call(provider.cancellation_quote(booking.provider_reference), provider)
    except HotelProviderError as exc:
        raise BookingError(str(exc)) from exc
    return booking, quote


async def cancel(
    db: AsyncSession,
    providers: dict[str, HotelProvider],
    user_id: int,
    booking_id: int,
    expected_refund: Decimal,
    now: datetime | None = None,
) -> Booking:
    """Cancel with the provider, but only at the refund the traveller agreed to."""
    now = now or datetime.now(UTC)
    booking, quote = await cancellation_quote(db, providers, user_id, booking_id)
    if quote.refund_amount != expected_refund:
        raise RefundChanged(quote)

    provider = _provider(providers, booking.provider)
    try:
        result = await _call(provider.cancel(booking.provider_reference), provider)
    except HotelProviderError as exc:
        # The provider did not confirm, so the booking stays as it was.
        logger.warning("cancellation failed id=%s provider=%s reason=%s", booking.id, booking.provider, exc)
        raise BookingError(f"{exc} The booking has not been cancelled.") from exc

    booking.status = CANCELLED
    booking.refund_amount = result.refund_amount
    booking.cancellation_fee = result.fee
    booking.cancelled_at = now
    await db.commit()
    logger.info("booking cancelled id=%s provider=%s", booking.id, booking.provider)
    return booking
