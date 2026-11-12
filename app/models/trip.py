from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Trip(Base):
    """What the traveller has told us about the trip being planned in a conversation."""

    __tablename__ = "trips"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), unique=True
    )
    destination: Mapped[str | None] = mapped_column(String(200))
    # Where the traveller sets out from; when known, getting there is part of the budget.
    origin: Mapped[str | None] = mapped_column(String(200))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    adults: Mapped[int | None] = mapped_column(Integer)
    children: Mapped[int | None] = mapped_column(Integer)
    budget_total: Mapped[float | None] = mapped_column(Numeric(12, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    budget_level: Mapped[str | None] = mapped_column(String(16))
    interests: Mapped[list[str] | None] = mapped_column(JSON)
    pace: Mapped[str | None] = mapped_column(String(16))
    must_visit: Mapped[list[str] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    # Days of an itinerary still being saved in parts; cleared once it is complete.
    itinerary_draft: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Itinerary(Base):
    """A validated day-by-day plan. Each save is a new version; the latest one is current."""

    __tablename__ = "itineraries"

    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
