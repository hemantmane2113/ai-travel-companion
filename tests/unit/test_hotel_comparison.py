import asyncio
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.providers.hotels.base import HotelProvider, HotelProviderError, OfferUnavailable, PriceChanged
from app.schemas.hotel import HotelSearch
from app.services import hotel_comparison
from app.services.hotel_comparison import HotelSearchError

TODAY = date(2026, 9, 1)
SEARCH = HotelSearch(
    destination="Delhi", area="Karol Bagh", check_in=date(2026, 9, 12), check_out=date(2026, 9, 15), adults=2, rooms=1
)


class BrokenProvider(HotelProvider):
    id, name, is_demo = "broken", "Broken (demo)", True

    async def search(self, search):
        raise HotelProviderError("down")

    get_offer = book = cancellation_quote = cancel = None


class SlowProvider(BrokenProvider):
    id, name = "slow", "Slow (demo)"

    async def search(self, search):
        await asyncio.sleep(5)


async def _compare(session_factory, providers, **kwargs):
    async with session_factory() as db:
        return await hotel_comparison.compare(db, providers, SEARCH, 1, 1, TODAY, **kwargs)


async def test_offers_are_normalised_and_sorted_by_total_price(session_factory, hotel_providers):
    comparison = await _compare(session_factory, hotel_providers)

    offers = [offer for _, offer in comparison.offers]
    totals = [offer.total_price for offer in offers]
    assert totals == sorted(totals)
    assert {offer.provider for offer in offers} == {"stayeasy", "roomhub", "tripnest"}
    for offer in offers:
        assert offer.nights == 3
        assert offer.total_price == offer.price_per_night * 3 + offer.taxes_and_fees
        assert offer.currency == "INR" and offer.is_demo
    assert len({offer_id for offer_id, _ in comparison.offers}) == len(offers)
    assert comparison.failed_providers == []


async def test_sort_by_rating_and_price_cap(session_factory, hotel_providers):
    by_rating = await _compare(session_factory, hotel_providers, sort_by="rating")
    ratings = [offer.guest_rating for _, offer in by_rating.offers]
    assert ratings == sorted(ratings, reverse=True)

    capped = await _compare(session_factory, hotel_providers, max_total_price=Decimal("10000"))
    assert capped.offers and all(offer.total_price <= 10000 for _, offer in capped.offers)


async def test_one_failing_or_slow_provider_does_not_sink_the_comparison(session_factory, hotel_providers, monkeypatch):
    monkeypatch.setattr(hotel_comparison, "PROVIDER_TIMEOUT_SECONDS", 0.05)
    providers = {**hotel_providers, "broken": BrokenProvider(), "slow": SlowProvider()}

    comparison = await _compare(session_factory, providers)

    assert comparison.failed_providers == ["Broken (demo)", "Slow (demo)"]
    assert comparison.offers
    assert hotel_comparison.comparison_card(comparison)["failed_providers"] == ["Broken (demo)", "Slow (demo)"]


async def test_card_groups_by_hotel_and_marks_cheapest(session_factory, hotel_providers):
    card = hotel_comparison.comparison_card(await _compare(session_factory, hotel_providers))

    assert card["is_demo"] is True and card["nights"] == 3
    banyan = next(hotel for hotel in card["hotels"] if hotel["hotel_name"] == "Banyan Court")
    assert len(banyan["offers"]) == 3
    prices = [offer["total_price"] for offer in banyan["offers"]]
    assert prices == sorted(prices)
    assert [offer.get("cheapest", False) for offer in banyan["offers"]] == [True, False, False]


async def test_model_view_has_cheapest_and_demo_warning(session_factory, hotel_providers):
    data = hotel_comparison.comparison_for_model(await _compare(session_factory, hotel_providers))
    cheapest = min(data["offers"], key=lambda offer: offer["total_price"])
    assert data["cheapest_offer_id"] == cheapest["offer_id"]
    assert "simulated" in data["demo_data"]


async def test_invalid_dates_are_rejected(session_factory, hotel_providers):
    async with session_factory() as db:
        for check_in, check_out, message in [
            (date(2026, 8, 1), date(2026, 8, 3), "in the past"),
            (date(2026, 9, 12), date(2026, 9, 12), "after check_in"),
            (date(2026, 9, 12), date(2026, 11, 12), "longer than"),
        ]:
            search = SEARCH.model_copy(update={"check_in": check_in, "check_out": check_out})
            with pytest.raises(HotelSearchError, match=message):
                await hotel_comparison.compare(db, hotel_providers, search, 1, 1, TODAY)


async def test_mock_provider_requote_book_and_cancel(session_factory):
    from app.providers.hotels.mock import MOCK_PROFILES, MockHotelProvider

    today = [date.today()]
    search = SEARCH.model_copy(
        update={"check_in": today[0] + timedelta(days=10), "check_out": today[0] + timedelta(days=12)}
    )
    stayeasy = MockHotelProvider(MOCK_PROFILES[0], session_factory, today=lambda: today[0])
    roomhub = MockHotelProvider(MOCK_PROFILES[1], session_factory, today=lambda: today[0])

    offer = (await stayeasy.search(search))[0]
    assert (await stayeasy.get_offer(offer.provider_offer_id)).total_price == offer.total_price
    with pytest.raises(OfferUnavailable):
        await stayeasy.get_offer("not-an-offer")
    with pytest.raises(PriceChanged):
        await stayeasy.book(offer.provider_offer_id, offer.total_price - 1, "Asha Rao")

    booking = await stayeasy.book(offer.provider_offer_id, offer.total_price, "Asha Rao")
    assert booking.reference.startswith("SE-")

    # Free until two days before check-in, then the first night is charged.
    assert (await stayeasy.cancellation_quote(booking.reference)).refund_amount == offer.total_price
    today[0] = search.check_in - timedelta(days=1)
    late = await stayeasy.cancellation_quote(booking.reference)
    assert late.fee == offer.price_per_night and late.refund_amount == offer.total_price - offer.price_per_night

    assert (await stayeasy.cancel(booking.reference)).refund_amount == late.refund_amount
    with pytest.raises(HotelProviderError, match="already cancelled"):
        await stayeasy.cancel(booking.reference)
    with pytest.raises(HotelProviderError, match="no booking"):
        await roomhub.cancellation_quote(booking.reference)

    today[0] = date.today()
    non_refundable = (await roomhub.search(search))[0]
    reference = (await roomhub.book(non_refundable.provider_offer_id, non_refundable.total_price, "Asha Rao")).reference
    assert (await roomhub.cancellation_quote(reference)).refund_amount == 0
