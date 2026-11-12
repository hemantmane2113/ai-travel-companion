from abc import ABC, abstractmethod
from dataclasses import dataclass, field


class KnowledgeError(Exception):
    """The knowledge source could not be reached or returned something unusable."""


@dataclass
class PlaceInfo:
    title: str
    summary: str
    url: str
    source: str  # human-readable name of where this came from


@dataclass
class TravelGuide:
    title: str
    url: str
    source: str
    sections: dict[str, str] = field(default_factory=dict)  # heading -> text


class KnowledgeProvider(ABC):
    """Reference text about places, always with the URL it came from."""

    @abstractmethod
    async def search_places(self, query: str, limit: int = 3) -> list[PlaceInfo]:
        """Encyclopedia entries matching the query, best match first."""

    @abstractmethod
    async def travel_guide(self, destination: str) -> TravelGuide | None:
        """Traveller-oriented guide for a destination, or None if there is none."""
