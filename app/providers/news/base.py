from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime


class NewsError(Exception):
    """The news source could not be reached or returned something unusable."""


@dataclass
class NewsItem:
    title: str
    source: str  # the publication
    published: datetime
    url: str


class NewsProvider(ABC):
    @abstractmethod
    async def disruptions(self, place: str, days: int = 7, limit: int = 6) -> list[NewsItem]:
        """Recent headlines about a place that mention things which can upset a visit
        (strikes, protests, closures, floods, traffic diversions, large gatherings),
        newest first. Headlines are as reported; nothing here verifies them."""
