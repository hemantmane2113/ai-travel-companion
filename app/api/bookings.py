"""Booking actions taken by the traveller themselves.

Confirming and cancelling live here and nowhere else: the model has no tool that
reaches these, so a commitment is only ever made by the signed-in user's own request.
"""

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_db
from app.models import Booking, Message, User
from app.models.booking import CONFIRMED
from app.services import booking_service

router = APIRouter(prefix="/api/bookings")


class CancelRequest(BaseModel):
    expected_refund: Decimal = Field(ge=0)


def _money(amount, currency: str) -> str:
    return f"{currency} {Decimal(amount):,.0f}"


async def _note(db: AsyncSession, booking: Booking, text: str) -> None:
    """Record the outcome in the conversation so the companion knows what really happened."""
    db.add(Message(conversation_id=booking.conversation_id, role="assistant", content=text))
    await db.commit()


@router.get("")
async def list_bookings(request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    providers = request.app.state.hotel_providers
    return [booking_service.booking_view(b, providers) for b in await booking_service.list_bookings(db, user.id)]


@router.get("/{booking_id}")
async def get_booking(
    booking_id: int, request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    try:
        booking = await booking_service.get_booking(db, user.id, booking_id)
    except booking_service.BookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    return booking_service.booking_view(booking, request.app.state.hotel_providers)


@router.post("/{booking_id}/confirm")
async def confirm_booking(
    booking_id: int, request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    providers = request.app.state.hotel_providers
    try:
        booking = await booking_service.confirm(db, providers, user.id, booking_id)
    except booking_service.BookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except booking_service.BookingError as exc:
        raise HTTPException(409, str(exc)) from exc

    view = booking_service.booking_view(booking, providers)
    if booking.status == CONFIRMED:
        note = (
            f"Booking confirmed: {view['hotel_name']} via {view['provider_name']}, "
            f"{view['check_in']} to {view['check_out']}, {_money(booking.total_price, booking.currency)}. "
            f"Reference {booking.provider_reference}."
        )
    else:
        note = f"The booking for {view['hotel_name']} was not made. {booking.failure_reason}"
    await _note(db, booking, note)
    return view


@router.post("/{booking_id}/cancel")
async def cancel_booking(
    booking_id: int,
    body: CancelRequest,
    request: Request,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    providers = request.app.state.hotel_providers
    try:
        booking = await booking_service.cancel(db, providers, user.id, booking_id, body.expected_refund)
    except booking_service.BookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except booking_service.RefundChanged as exc:
        raise HTTPException(
            409,
            {
                "message": str(exc),
                "refund_amount": float(exc.quote.refund_amount),
                "fee": float(exc.quote.fee),
                "currency": exc.quote.currency,
            },
        ) from exc
    except booking_service.BookingError as exc:
        raise HTTPException(409, str(exc)) from exc

    view = booking_service.booking_view(booking, providers)
    await _note(
        db,
        booking,
        f"Booking cancelled: {view['hotel_name']} via {view['provider_name']} "
        f"(reference {booking.provider_reference}). Refund {_money(booking.refund_amount, booking.currency)}, "
        f"cancellation fee {_money(booking.cancellation_fee, booking.currency)}.",
    )
    return view
