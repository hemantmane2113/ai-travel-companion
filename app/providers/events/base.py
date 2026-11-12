from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from typing import Literal


class EventsError(Exception):
    """The events source could not be reached or returned something unusable."""


class EventsUnsupported(EventsError):
    """There is no calendar for this country, so nothing can be said either way."""


@dataclass
class Event:
    date: date
    name: str
    kind: Literal["public holiday", "observance"]
    source: str


class EventsProvider(ABC):
    """Dated events that can affect a visit: closures, crowds, restricted traffic."""

    coverage: str  # what this provider does and does not know about, shown to the traveller

    @abstractmethod
    async def events(self, country_code: str, start: date, end: date) -> list[Event]: ...
