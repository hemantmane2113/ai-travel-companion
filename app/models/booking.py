from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

PENDING_CONFIRMATION = "PENDING_CONFIRMATION"
CONFIRMED = "CONFIRMED"
FAILED = "FAILED"
EXPIRED = "EXPIRED"
CANCELLED = "CANCELLED"


class HotelOfferRecord(Base):
    """An offer exactly as it was shown to the traveller. The model refers to it by id."""

    __tablename__ = "hotel_offers"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict[str, Any]] = mapped_column(JSON)  # HotelOffer
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Booking(Base):
    """A hotel reservation and where it stands.

    It becomes CONFIRMED or CANCELLED only after the provider says so.
    """

    __tablename__ = "bookings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(24), default=PENDING_CONFIRMATION)
    provider: Mapped[str] = mapped_column(String(40))
    offer: Mapped[dict[str, Any]] = mapped_column(JSON)  # HotelOffer as quoted at prepare time
    total_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3))
    guest_name: Mapped[str] = mapped_column(String(120))
    provider_reference: Mapped[str | None] = mapped_column(String(64))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    refund_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    cancellation_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MockProviderBooking(Base):
    """MOCK: stands in for the demo providers' own reservation systems."""

    __tablename__ = "mock_provider_bookings"
    __table_args__ = (UniqueConstraint("provider", "reference"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(40))
    reference: Mapped[str] = mapped_column(String(64))
    guest_name: Mapped[str] = mapped_column(String(120))
    total_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    first_night_charge: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3))
    free_cancellation_until: Mapped[date | None] = mapped_column(Date)
    non_refundable: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16))
