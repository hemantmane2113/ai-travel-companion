from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.providers.weather.base import City


class MapsError(Exception):
    """The map service could not be reached or returned something unusable."""


@dataclass(frozen=True)
class GeoPoint:
    latitude: float
    longitude: float
    label: str = ""


@dataclass
class TravelMatrix:
    """Travel between every pair of points, row = from, column = to."""

    distances_km: list[list[float]]
    minutes: list[list[float]]
    source: str


class GeocodingProvider(ABC):
    @abstractmethod
    async def geocode(self, query: str) -> GeoPoint | None:
        """Coordinates for a free-text place, or None if it is not found."""

    async def describe(self, point: GeoPoint) -> str | None:
        """A short name for the area around a point ("Shivajinagar, Pune"), or None if not known.

        Optional: a geocoder that cannot look points up keeps this default.
        """
        return None


class DestinationFinder(ABC):
    @abstractmethod
    async def find_destination(self, name: str) -> "City | None":
        """The place a traveller most likely means by a destination name, or None."""


class RoutingProvider(ABC):
    @abstractmethod
    async def matrix(self, points: list[GeoPoint]) -> TravelMatrix: ...
