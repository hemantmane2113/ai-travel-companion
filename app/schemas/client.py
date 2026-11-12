"""What the traveller's browser sends with a message, beyond the message itself.

Kept for the one request only: none of it is stored or logged. It is where per-user
context belongs (timezone now; language or currency later), so that the server never
assumes one country or one clock.
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator


class SharedLocation(BaseModel):
    """Where the traveller is, shared from their browser with their permission for this message."""

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(None, ge=0, description="The browser's estimate of the error radius.")


class ClientInfo(BaseModel):
    timezone: str | None = Field(None, max_length=64, description="IANA name from the browser, e.g. Asia/Kolkata.")
    location: SharedLocation | None = None

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls, value: str | None) -> str | None:
        # An unknown name is dropped rather than refused: the message still goes through.
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            return None
        return value

    def today(self) -> date:
        """The traveller's own date, which is not the server's near midnight."""
        if self.timezone:
            return datetime.now(ZoneInfo(self.timezone)).date()
        return date.today()
