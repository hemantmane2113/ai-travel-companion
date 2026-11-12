"""Simulated table reservations.

MOCK: no restaurant is contacted and no table is held. It exists so the search ->
choose -> confirm -> reserve -> cancel flow can be built and tested. A real
reservation service is added by writing another TableReservationProvider.
"""

import secrets
from datetime import date, time

from app.providers.restaurants.base import Restaurant, RestaurantsError, TableReservationProvider


class MockTableReservations(TableReservationProvider):
    name = "TableDemo (demo)"
    is_demo = True

    def __init__(self):
        self._open: set[str] = set()

    async def reserve(self, restaurant: Restaurant, day: date, at: time, party_size: int, guest_name: str) -> str:
        reference = f"TD-{secrets.token_hex(4).upper()}"
        self._open.add(reference)
        return reference

    async def cancel(self, reference: str) -> None:
        # References do not outlive a restart of this simulation, so an unknown one is
        # accepted; only the wrong kind of reference is refused.
        if not reference.startswith("TD-"):
            raise RestaurantsError(f"{self.name} has no reservation with reference {reference}.")
        self._open.discard(reference)
