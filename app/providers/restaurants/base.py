from abc import ABC, abstractmethod
from datetime import date, time

from pydantic import BaseModel

from app.providers.maps.base import GeoPoint


class RestaurantsError(Exception):
    """The restaurant source or reservation service failed. The message is safe to show."""


class Restaurant(BaseModel):
    """A place to eat, in the same shape whichever source it came from."""

    source_id: str
    name: str
    cuisines: list[str]
    address: str
    latitude: float
    longitude: float
    opening_hours: str | None = None  # as published by the source, not interpreted
    phone: str | None = None
    website: str | None = None
    vegetarian_only: bool = False
    source: str
    source_url: str


class RestaurantSearchProvider(ABC):
    @abstractmethod
    async def nearby(self, center: GeoPoint, radius_m: int) -> list[Restaurant]:
        """Every known place to eat within the radius. Filtering and ranking are the caller's job."""


class TableReservationProvider(ABC):
    """Whoever takes table reservations."""

    name: str
    is_demo: bool

    @abstractmethod
    async def reserve(self, restaurant: Restaurant, day: date, at: time, party_size: int, guest_name: str) -> str:
        """Reserve a table and return the reservation reference."""

    @abstractmethod
    async def cancel(self, reference: str) -> None: ...
