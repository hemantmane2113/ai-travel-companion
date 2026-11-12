from abc import ABC, abstractmethod
from decimal import Decimal

from app.schemas.hotel import CancellationQuote, HotelOffer, HotelSearch, ProviderBooking


class HotelProviderError(Exception):
    """The provider failed or refused. The message is safe to show to the traveller."""


class OfferUnavailable(HotelProviderError):
    pass


class PriceChanged(HotelProviderError):
    pass


class HotelProvider(ABC):
    """A site hotels can be searched and booked through.

    Adapters own everything provider-specific and return the normalised models.
    """

    id: str
    name: str
    is_demo: bool

    @abstractmethod
    async def search(self, search: HotelSearch) -> list[HotelOffer]: ...

    @abstractmethod
    async def get_offer(self, provider_offer_id: str) -> HotelOffer:
        """Current price and terms for an offer. Raises OfferUnavailable if it is gone."""

    @abstractmethod
    async def book(self, provider_offer_id: str, expected_total: Decimal, guest_name: str) -> ProviderBooking:
        """Book at the expected total. Raises PriceChanged if the price is no longer that."""

    @abstractmethod
    async def cancellation_quote(self, reference: str) -> CancellationQuote:
        """What cancelling now would refund. Changes nothing."""

    @abstractmethod
    async def cancel(self, reference: str) -> CancellationQuote:
        """Cancel the booking and return what was refunded."""
