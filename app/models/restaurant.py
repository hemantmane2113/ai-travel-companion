from datetime import date, datetime, time
from typing import Any

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, String, Text, Time, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.booking import PENDING_CONFIRMATION


class RestaurantRecord(Base):
    """A restaurant exactly as it was shown to the traveller. The model refers to it by id."""

    __tablename__ = "restaurant_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    data: Mapped[dict[str, Any]] = mapped_column(JSON)  # Restaurant
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TableBooking(Base):
    """A table reservation and where it stands. Same states as a hotel booking."""

    __tablename__ = "table_bookings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(24), default=PENDING_CONFIRMATION)
    restaurant: Mapped[dict[str, Any]] = mapped_column(JSON)  # Restaurant
    day: Mapped[date] = mapped_column(Date)
    at: Mapped[time] = mapped_column(Time)
    party_size: Mapped[int] = mapped_column(Integer)
    guest_name: Mapped[str] = mapped_column(String(120))
    provider_name: Mapped[str] = mapped_column(String(80))
    is_demo: Mapped[bool] = mapped_column(default=True)
    provider_reference: Mapped[str | None] = mapped_column(String(64))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
