"""Table reservation actions taken by the traveller themselves.

As with hotel bookings, confirming and cancelling live here and nowhere else: the
model has no tool that reaches these.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_db
from app.models import Message, TableBooking, User
from app.models.booking import CONFIRMED
from app.services import restaurant_service

router = APIRouter(prefix="/api/table-bookings")


async def _note(db: AsyncSession, booking: TableBooking, text: str) -> None:
    """Record the outcome in the conversation so the companion knows what really happened."""
    db.add(Message(conversation_id=booking.conversation_id, role="assistant", content=text))
    await db.commit()


def _when(view: dict) -> str:
    return f"{view['date']} at {view['time']} for {view['party_size']}"


@router.get("")
async def list_table_bookings(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    return [restaurant_service.booking_view(b) for b in await restaurant_service.list_bookings(db, user.id)]


@router.get("/{booking_id}")
async def get_table_booking(booking_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    try:
        booking = await restaurant_service.get_booking(db, user.id, booking_id)
    except restaurant_service.TableBookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    return restaurant_service.booking_view(booking)


@router.post("/{booking_id}/confirm")
async def confirm_table_booking(
    booking_id: int, request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    provider = request.app.state.table_reservations
    try:
        booking = await restaurant_service.confirm(db, provider, user.id, booking_id)
    except restaurant_service.TableBookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except restaurant_service.TableBookingError as exc:
        raise HTTPException(409, str(exc)) from exc

    view = restaurant_service.booking_view(booking)
    if booking.status == CONFIRMED:
        note = (
            f"Table reserved through {view['provider_name']}: {view['restaurant_name']}, {_when(view)}, "
            f"under {view['guest_name']}. Reference {booking.provider_reference}."
        )
        if booking.is_demo:
            note += " This is a simulated reservation; the restaurant has not been contacted."
    else:
        note = f"The table at {view['restaurant_name']} was not reserved. {booking.failure_reason}"
    await _note(db, booking, note)
    return view


@router.post("/{booking_id}/cancel")
async def cancel_table_booking(
    booking_id: int, request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    provider = request.app.state.table_reservations
    try:
        booking = await restaurant_service.cancel(db, provider, user.id, booking_id)
    except restaurant_service.TableBookingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except restaurant_service.TableBookingError as exc:
        raise HTTPException(409, str(exc)) from exc

    view = restaurant_service.booking_view(booking)
    await _note(
        db,
        booking,
        f"Table reservation cancelled: {view['restaurant_name']}, {_when(view)} (reference {booking.provider_reference}).",
    )
    return view
