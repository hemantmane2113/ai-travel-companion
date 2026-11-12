from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select, update

from app.models import Booking, MockProviderBooking
from app.providers.hotels.base import HotelProviderError, PriceChanged
from tests.conftest import call, chat, new_conversation, say, tool_results

CHECK_IN = date.today() + timedelta(days=30)
CHECK_OUT = CHECK_IN + timedelta(days=3)
SEARCH = {
    "destination": "Delhi",
    "area": "Karol Bagh",
    "check_in": CHECK_IN.isoformat(),
    "check_out": CHECK_OUT.isoformat(),
    "adults": 2,
}


async def _compare(client, llm, conversation_id) -> dict:
    llm.queue(call("compare_hotels", SEARCH), say("Here are the options."))
    events = await chat(client, conversation_id, "Compare hotels near Karol Bagh")
    card = next(data for event, data in events if event == "card")
    assert card["type"] == "hotel_comparison"
    return tool_results(llm)[-1]


async def _prepare(client, llm, conversation_id, offer_id: int) -> int:
    llm.queue(call("prepare_booking", {"offer_id": offer_id, "guest_name": "Asha Rao"}, "p"), say("Check and confirm."))
    events = await chat(client, conversation_id, "Book that one, guest Asha Rao")
    card = next(data for event, data in events if event == "card")
    assert card["type"] == "booking_confirm"
    return card["booking_id"]


async def _pending_booking(client, llm, provider: str | None = None) -> tuple[int, dict]:
    conversation_id = await new_conversation(client)
    comparison = await _compare(client, llm, conversation_id)
    offers = comparison["offers"]
    if provider:
        offer = next(o for o in offers if o["provider"].startswith(provider))
    else:
        offer = next(o for o in offers if o["offer_id"] == comparison["cheapest_offer_id"])
    return await _prepare(client, llm, conversation_id, offer["offer_id"]), offer


def test_model_has_no_tool_that_commits_a_booking(app):
    names = {schema["function"]["name"] for schema in app.state.tools.schemas()}
    assert names == {
        "save_trip_requirements",
        "search_place_info",
        "get_travel_guide",
        "save_itinerary",
        "get_trip_conditions",
        "get_local_news",
        "optimize_route",
        "compare_hotels",
        "prepare_booking",
        "list_bookings",
        "prepare_cancellation",
        "find_restaurants",
        "prepare_table_booking",
        "list_table_bookings",
        "prepare_table_cancellation",
        "transport_search_links",
        "hotel_search_links",
    }


async def test_compare_shows_offers_from_every_provider(client, llm):
    comparison = await _compare(client, llm, await new_conversation(client))

    assert {offer["provider"] for offer in comparison["offers"]} == {
        "StayEasy (demo)",
        "RoomHub (demo)",
        "TripNest (demo)",
    }
    assert comparison["rooms"] == 1 and comparison["nights"] == 3
    assert "simulated" in comparison["demo_data"]


async def test_prepare_does_not_book_and_confirm_does(client, llm, session_factory):
    booking_id, offer = await _pending_booking(client, llm)

    prepared = tool_results(llm)[-1]
    assert prepared["status"].startswith("NOT BOOKED YET")
    pending = (await client.get(f"/api/bookings/{booking_id}")).json()
    assert pending["status"] == "PENDING_CONFIRMATION" and pending["provider_reference"] is None
    assert pending["total_price"] == offer["total_price"] and pending["guest_name"] == "Asha Rao"
    async with session_factory() as db:
        assert (await db.scalars(select(MockProviderBooking))).all() == []

    confirmed = (await client.post(f"/api/bookings/{booking_id}/confirm")).json()

    assert confirmed["status"] == "CONFIRMED" and confirmed["provider_reference"]
    async with session_factory() as db:
        provider_side = (await db.scalars(select(MockProviderBooking))).one()
    assert provider_side.reference == confirmed["provider_reference"] and provider_side.status == "BOOKED"

    # Confirming twice does not book twice.
    again = await client.post(f"/api/bookings/{booking_id}/confirm")
    assert again.status_code == 409
    async with session_factory() as db:
        assert len((await db.scalars(select(MockProviderBooking))).all()) == 1


async def test_confirmation_is_recorded_in_the_conversation(client, llm):
    booking_id, _ = await _pending_booking(client, llm)
    reference = (await client.post(f"/api/bookings/{booking_id}/confirm")).json()["provider_reference"]
    conversation_id = (await client.get("/api/conversations")).json()[0]["id"]

    llm.queue(call("list_bookings", {}, "l"), say("It is confirmed."))
    await chat(client, conversation_id, "Is my hotel booked?")

    sent = llm.calls[-1]["messages"]
    assert any(m["role"] == "assistant" and f"Reference {reference}" in m["content"] for m in sent)
    listed = tool_results(llm)[-1]["bookings"]
    assert listed[0]["status"] == "CONFIRMED" and listed[0]["provider_reference"] == reference


async def test_other_users_cannot_see_prepare_confirm_or_cancel(client, other_client, llm):
    booking_id, offer = await _pending_booking(client, llm)

    assert (await other_client.get(f"/api/bookings/{booking_id}")).status_code == 404
    assert (await other_client.post(f"/api/bookings/{booking_id}/confirm")).status_code == 404
    cancel = await other_client.post(f"/api/bookings/{booking_id}/cancel", json={"expected_refund": 0})
    assert cancel.status_code == 404
    assert (await other_client.get("/api/bookings")).json() == []

    # With no comparison or booking of their own, the tools are not even on offer.
    other_conversation = await new_conversation(other_client)
    llm.queue(
        call("prepare_booking", {"offer_id": offer["offer_id"], "guest_name": "Ravi"}),
        call("prepare_cancellation", {"booking_id": booking_id}, "c"),
        say("I cannot do that."),
    )
    await chat(other_client, other_conversation, "Book offer")
    results = tool_results(llm)
    assert results[0]["error"].startswith("'prepare_booking' cannot be used yet.")
    assert results[1]["error"] == "'prepare_cancellation' cannot be used yet. The traveller has no bookings."

    # Once they have offers of their own, another user's offer id still gets them nothing.
    await _compare(other_client, llm, other_conversation)
    llm.queue(call("prepare_booking", {"offer_id": offer["offer_id"], "guest_name": "Ravi"}, "p2"), say("No."))
    await chat(other_client, other_conversation, "Book that offer")
    error = tool_results(llm)[-1]["error"]
    assert "There is no offer" in error and "Nothing was booked" in error
    assert (await client.get(f"/api/bookings/{booking_id}")).json()["status"] == "PENDING_CONFIRMATION"


async def test_signed_out_requests_are_refused(anon):
    assert (await anon.get("/api/bookings")).status_code == 401
    assert (await anon.post("/api/bookings/1/confirm")).status_code == 401


async def test_expired_quote_cannot_be_confirmed(client, llm, session_factory):
    booking_id, _ = await _pending_booking(client, llm)
    async with session_factory() as db:
        await db.execute(update(Booking).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        await db.commit()

    assert (await client.get(f"/api/bookings/{booking_id}")).json()["status"] == "EXPIRED"
    response = await client.post(f"/api/bookings/{booking_id}/confirm")

    assert response.status_code == 409 and "expired" in response.json()["detail"]
    async with session_factory() as db:
        assert (await db.scalars(select(MockProviderBooking))).all() == []


async def test_provider_failure_is_not_recorded_as_a_booking(client, llm, hotel_providers, monkeypatch):
    booking_id, offer = await _pending_booking(client, llm, provider="StayEasy")

    async def price_moved(*args, **kwargs):
        raise PriceChanged("The price is now INR 9999.")

    monkeypatch.setattr(hotel_providers["stayeasy"], "book", price_moved)
    failed = (await client.post(f"/api/bookings/{booking_id}/confirm")).json()

    assert failed["status"] == "FAILED" and failed["provider_reference"] is None
    assert failed["failure_reason"] == "The price is now INR 9999."
    conversation_id = (await client.get("/api/conversations")).json()[0]["id"]
    messages = (await client.get(f"/api/conversations/{conversation_id}/messages")).json()
    assert messages[-1]["content"].startswith(f"The booking for {offer['hotel']} was not made.")


async def test_cancellation_needs_confirmation_at_the_quoted_refund(client, llm, session_factory):
    booking_id, offer = await _pending_booking(client, llm, provider="StayEasy")
    await client.post(f"/api/bookings/{booking_id}/confirm")
    conversation_id = (await client.get("/api/conversations")).json()[0]["id"]

    llm.queue(call("prepare_cancellation", {"booking_id": booking_id}, "c"), say("Press confirm to cancel."))
    events = await chat(client, conversation_id, "Cancel my hotel")

    card = next(data for event, data in events if event == "card")
    assert card["type"] == "cancel_confirm" and card["refund_amount"] == offer["total_price"] and card["fee"] == 0
    assert tool_results(llm)[-1]["status"].startswith("NOT CANCELLED YET")
    assert (await client.get(f"/api/bookings/{booking_id}")).json()["status"] == "CONFIRMED"

    # A refund other than the one the provider quotes now is refused, with the current terms.
    stale = await client.post(f"/api/bookings/{booking_id}/cancel", json={"expected_refund": 1})
    assert stale.status_code == 409 and stale.json()["detail"]["refund_amount"] == offer["total_price"]
    assert (await client.get(f"/api/bookings/{booking_id}")).json()["status"] == "CONFIRMED"

    cancelled = (
        await client.post(f"/api/bookings/{booking_id}/cancel", json={"expected_refund": card["refund_amount"]})
    ).json()
    assert cancelled["status"] == "CANCELLED"
    assert cancelled["refund_amount"] == offer["total_price"] and cancelled["cancellation_fee"] == 0
    async with session_factory() as db:
        assert (await db.scalars(select(MockProviderBooking))).one().status == "CANCELLED"

    assert (await client.post(f"/api/bookings/{booking_id}/cancel", json={"expected_refund": 0})).status_code == 409


async def test_non_refundable_booking_quotes_zero_refund(client, llm):
    booking_id, offer = await _pending_booking(client, llm, provider="RoomHub")
    await client.post(f"/api/bookings/{booking_id}/confirm")
    conversation_id = (await client.get("/api/conversations")).json()[0]["id"]

    llm.queue(call("prepare_cancellation", {"booking_id": booking_id}, "c"), say("You would get nothing back."))
    await chat(client, conversation_id, "Cancel my hotel")

    quote = tool_results(llm)[-1]
    assert quote["refund_amount"] == 0 and quote["cancellation_fee"] == offer["total_price"]


async def test_failed_provider_cancellation_leaves_booking_confirmed(client, llm, hotel_providers, monkeypatch):
    booking_id, offer = await _pending_booking(client, llm, provider="StayEasy")
    await client.post(f"/api/bookings/{booking_id}/confirm")

    async def down(reference):
        raise HotelProviderError("StayEasy (demo) did not respond in time.")

    monkeypatch.setattr(hotel_providers["stayeasy"], "cancel", down)
    response = await client.post(
        f"/api/bookings/{booking_id}/cancel", json={"expected_refund": offer["total_price"]}
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "StayEasy (demo) did not respond in time. The booking has not been cancelled."
    assert (await client.get(f"/api/bookings/{booking_id}")).json()["status"] == "CONFIRMED"


async def test_price_change_between_search_and_prepare_is_flagged(client, llm, hotel_providers, monkeypatch):
    conversation_id = await new_conversation(client)
    comparison = await _compare(client, llm, conversation_id)
    offer = next(o for o in comparison["offers"] if o["provider"].startswith("StayEasy"))
    original = hotel_providers["stayeasy"].get_offer

    async def dearer(provider_offer_id):
        current = await original(provider_offer_id)
        return current.model_copy(update={"total_price": current.total_price + Decimal(500)})

    monkeypatch.setattr(hotel_providers["stayeasy"], "get_offer", dearer)
    booking_id = await _prepare(client, llm, conversation_id, offer["offer_id"])

    assert "price_changed" in tool_results(llm)[-1]
    pending = (await client.get(f"/api/bookings/{booking_id}")).json()
    assert pending["total_price"] == offer["total_price"] + 500
