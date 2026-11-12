from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class HotelSearch(BaseModel):
    destination: str
    area: str | None = None
    check_in: date
    check_out: date
    adults: int = Field(ge=1)
    rooms: int = Field(ge=1)

    @property
    def nights(self) -> int:
        return (self.check_out - self.check_in).days


class HotelOffer(BaseModel):
    """One bookable room offer, in the same shape whichever provider it came from."""

    provider: str  # provider id
    provider_name: str
    is_demo: bool
    provider_offer_id: str

    hotel_id: str
    hotel_name: str
    area: str
    star_rating: int
    guest_rating: float  # out of 10
    review_count: int
    amenities: list[str]

    room_type: str
    breakfast_included: bool
    check_in: date
    check_out: date
    nights: int
    rooms: int
    adults: int

    price_per_night: Decimal  # per room, before taxes
    taxes_and_fees: Decimal
    total_price: Decimal  # everything, all rooms and nights
    currency: str

    free_cancellation_until: date | None  # None means non-refundable
    cancellation_policy: str

    retrieved_at: datetime


class ProviderBooking(BaseModel):
    reference: str
    total_price: Decimal
    currency: str


class CancellationQuote(BaseModel):
    refund_amount: Decimal
    fee: Decimal
    currency: str
