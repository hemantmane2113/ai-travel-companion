"""The companion's tools. Each one is a thin adapter from a model tool call to a service."""

import asyncio
import json
import math
from dataclasses import asdict, dataclass
from datetime import date
from datetime import date as date_type  # for models that have a field named "date"
from datetime import time as time_type
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.agent.tools import Tool, ToolContext, ToolFailure, ToolRegistry, ToolResult
from app.models import Booking, HotelOfferRecord, Itinerary, Message, RestaurantRecord, TableBooking
from app.providers.air.base import AirQualityProvider
from app.providers.events.base import EventsProvider
from app.providers.hotels.base import HotelProvider, HotelProviderError
from app.providers.knowledge.base import KnowledgeError, KnowledgeProvider
from app.providers.maps.base import DestinationFinder, GeocodingProvider, GeoPoint, MapsError, RoutingProvider
from app.providers.news.base import NewsError, NewsProvider
from app.providers.restaurants.base import RestaurantSearchProvider, TableReservationProvider
from app.providers.weather.base import WeatherError, WeatherProvider
from app.schemas.hotel import HotelSearch
from app.schemas.trip import SaveItineraryArgs, TripRequirementsArgs
from app.services import (
    booking_service,
    budget_service,
    cost_table,
    conditions_service,
    hotel_comparison,
    itinerary_service,
    restaurant_service,
    route_service,
    search_links,
    travel_dates,
    trip_service,
)

KNOWLEDGE_TOOLS = ("search_place_info", "get_travel_guide")
MAX_LOOKUPS_PER_CALL = 8
RESULTS_PER_LOOKUP = 1


class SearchPlaceArgs(BaseModel):
    # No schema maximum: an over-long list is cut in the handler, which costs less than
    # having the provider reject the whole call.
    queries: list[str] = Field(
        min_length=1,
        description=f"Up to {MAX_LOOKUPS_PER_CALL} place names, each with its city, e.g. 'Rajwada Palace Indore'. "
        "Put every place you need in one call.",
    )


class TravelGuideArgs(BaseModel):
    destination: str = Field(min_length=2, max_length=200, description="City or region.")


async def known_source_urls(ctx: ToolContext) -> set[str]:
    """URLs that knowledge tools actually returned in this conversation."""
    rows = await ctx.db.scalars(
        select(Message).where(Message.conversation_id == ctx.conversation_id, Message.role == "tool")
    )
    urls: set[str] = set()
    for row in rows:
        if (row.meta or {}).get("name") not in KNOWLEDGE_TOOLS:
            continue
        data = json.loads(row.content)
        urls.update(result["url"] for result in data.get("results", []))
        if data.get("guide"):
            urls.add(data["guide"]["url"])
    return urls


# ---------- recaps: what later turns see instead of a full result ----------
# Written in code from the result, so a recap can never say more than the tool did.


def _list(items: list[str], limit: int = 6) -> str:
    shown = "; ".join(items[:limit])
    return shown + (f"; and {len(items) - limit} more" if len(items) > limit else "")


def _recap_trip(data: dict[str, Any]) -> str:
    text = "Saved the trip details; the current trip note at the top of your instructions has them."
    if data.get("conditions", {}).get("alerts"):
        text += " Alerts already told to the traveller: " + _list(data["conditions"]["alerts"], 4) + "."
    return text


def _recap_places(data: dict[str, Any]) -> str:
    found = [f"{r['title']} ({r['url']})" for r in data.get("results", [])]
    text = "Looked up: " + (_list(found, 10) if found else "nothing found") + "."
    if data.get("not_found"):
        text += " Not found: " + _list(data["not_found"]) + "."
    return text


def _recap_guide(data: dict[str, Any]) -> str:
    guide = data.get("guide")
    if not guide:
        return "No travel guide was found."
    return f"Read the {guide['source']} guide '{guide['title']}' ({guide['url']})."


def _recap_conditions(data: dict[str, Any]) -> str:
    alerts = data.get("alerts") or []
    return f"Checked weather, air quality and holidays for {data.get('place', 'the place')}. " + (
        "Alerts: " + _list(alerts, 4) + "." if alerts else "No alerts."
    )


def _recap_news(data: dict[str, Any]) -> str:
    items = data.get("news") or []
    if not items:
        return "Checked local news: no disruption headlines found."
    headlines = [item["headline"] if isinstance(item, dict) else str(item) for item in items]
    return f"Showed the traveller {len(items)} news headlines: " + _list(headlines, 3) + "."


def _recap_route(data: dict[str, Any]) -> str:
    days = [f"day {day['day']}: " + " → ".join(day["stops_in_order"]) for day in data.get("days", [])]
    text = "Shortest route found. " + "; ".join(days) + "."
    if data.get("could_not_locate"):
        text += " Not on the map: " + _list(data["could_not_locate"]) + "."
    return text


def _recap_itinerary(data: dict[str, Any]) -> str:
    if data.get("saved"):
        return f"Saved itinerary version {data['version']}; the traveller sees it as a card."
    return (
        "Saved itinerary days " + ", ".join(data.get("saved_days", []))
        + "; still to save: " + ", ".join(data.get("remaining_dates", [])) + "."
    )


def _recap_links(data: dict[str, Any]) -> str:
    text = "Showed the traveller search links: " + ", ".join(data.get("links_shown_to_traveller", [])) + "."
    for key in ("price_limit", "budget_plan_recommends"):
        if data.get(key):
            text += f" {data[key]}"
    if data.get("could_not_link"):
        text += " Could not link: " + _list(data["could_not_link"]) + "."
    return text


class CompareHotelsArgs(BaseModel):
    destination: str = Field(min_length=2, max_length=200, description="City.")
    area: str | None = Field(None, max_length=120, description="Neighbourhood to stay in, if the traveller named one.")
    check_in: date = Field(description="YYYY-MM-DD")
    check_out: date = Field(description="YYYY-MM-DD")
    adults: int = Field(ge=1, le=20)
    rooms: int | None = Field(None, ge=1, le=10, description="Defaults to one room per two adults.")
    sort_by: Literal["price", "rating"] = "price"
    max_total_price: float | None = Field(None, gt=0, description="Upper limit for the whole stay, taxes included.")


class PrepareBookingArgs(BaseModel):
    offer_id: int = Field(description="offer_id from compare_hotels.")
    guest_name: str = Field(min_length=2, max_length=120, description="Full name of the lead guest, as the traveller gave it.")


class PrepareCancellationArgs(BaseModel):
    booking_id: int = Field(description="id from list_bookings.")


class NoArgs(BaseModel):
    pass


class TripConditionsArgs(BaseModel):
    destination: str = Field(min_length=2, max_length=200, description="City.")
    start_date: date = Field(description="YYYY-MM-DD")
    end_date: date = Field(description="YYYY-MM-DD")


class OptimizeRouteArgs(BaseModel):
    places: list[str] = Field(min_length=2, description="Every place to visit, by name, without the city.")
    start_from: str | None = Field(
        None, max_length=200, description="Where the traveller is based, e.g. their hotel or a conference venue, if known."
    )


class FindRestaurantsArgs(BaseModel):
    near_traveller: bool = Field(
        False,
        description="True when the traveller asks for places near them (near me, nearby, around here) without "
        "naming a place. Searches around the location their browser shares; city and area are then not needed.",
    )
    city: str | None = Field(None, min_length=2, max_length=120)
    area: str | None = Field(None, max_length=120, description="Neighbourhood or landmark within the city, if given.")
    dish: str | None = Field(None, max_length=120, description="The dish the traveller wants, in their words.")
    cuisine_keywords: list[str] = Field(
        default_factory=list,
        description="Specific words to match against each restaurant's cuisine tags and name: the dish's main "
        "ingredient and the cuisines known for it. For fish curry: seafood, fish, malvani, konkani, goan, "
        "coastal, bengali. Broad words such as indian or food are ignored. Leave empty to list what is nearby.",
    )
    dish_has_meat_or_fish: bool = Field(
        False, description="True if the dish contains meat, fish or seafood; vegetarian-only places are then left out."
    )


class PrepareTableBookingArgs(BaseModel):
    restaurant_id: int = Field(description="restaurant_id from find_restaurants.")
    date: date_type = Field(description="YYYY-MM-DD")
    # Plain text, not a time type: that becomes JSON Schema format "time", which
    # providers validate as RFC 3339 and so refuse "19:00" without a timezone.
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="24-hour HH:MM, e.g. 19:00 for 7 pm.")
    party_size: int = Field(ge=1, le=20)
    guest_name: str = Field(min_length=2, max_length=120, description="Name for the reservation, as the traveller gave it.")


class TransportLinksArgs(BaseModel):
    mode: Literal["flight", "train", "bus"]
    origin: str = Field(min_length=2, max_length=120, description="City travelling from.")
    destination: str = Field(min_length=2, max_length=120, description="City travelling to.")
    date: date_type = Field(description="Travel date, YYYY-MM-DD.")
    return_date: date_type | None = Field(None, description="Flights only: return date for a round trip.")
    travellers: int = Field(1, ge=1, le=9)


class HotelLinksArgs(BaseModel):
    city: str = Field(min_length=2, max_length=120)
    area: str | None = Field(None, max_length=120, description="Neighbourhood or landmark, if the traveller named one.")
    check_in: date_type = Field(description="YYYY-MM-DD")
    check_out: date_type = Field(description="YYYY-MM-DD")
    adults: int = Field(ge=1, le=20)
    rooms: int | None = Field(None, ge=1, le=10, description="Defaults to one room per two adults.")
    max_price_per_night: int | None = Field(
        None, ge=500, description="Upper price per night for all rooms, in rupees. Leave empty to use the trip's budget plan."
    )


class LocalNewsArgs(BaseModel):
    place: str = Field(min_length=2, max_length=120, description="City or town.")


ALWAYS_AVAILABLE = {
    "save_trip_requirements",
    "search_place_info",
    "get_travel_guide",
    "get_trip_conditions",
    "get_local_news",
    "compare_hotels",
    "list_bookings",
    "find_restaurants",
    "list_table_bookings",
    "transport_search_links",
    "hotel_search_links",
}


async def available_tools(ctx: ToolContext) -> set[str]:
    """The tools that can do something useful right now.

    Planning tools appear once the trip has what planning needs; booking tools once
    there is an offer to book or a booking to cancel. The model is not shown tools
    it could only misuse, and its requests stay smaller.
    """
    names = set(ALWAYS_AVAILABLE)
    trip = await trip_service.get_trip(ctx.db, ctx.conversation_id)
    if trip is not None and not trip_service.missing_requirements(trip):
        names |= {"optimize_route", "save_itinerary"}
    if await ctx.db.scalar(select(HotelOfferRecord.id).where(HotelOfferRecord.user_id == ctx.user_id).limit(1)):
        names.add("prepare_booking")
    if await ctx.db.scalar(select(Booking.id).where(Booking.user_id == ctx.user_id).limit(1)):
        names.add("prepare_cancellation")
    if await ctx.db.scalar(select(RestaurantRecord.id).where(RestaurantRecord.user_id == ctx.user_id).limit(1)):
        names.add("prepare_table_booking")
    if await ctx.db.scalar(select(TableBooking.id).where(TableBooking.user_id == ctx.user_id).limit(1)):
        names.add("prepare_table_cancellation")
    return names


@dataclass
class Providers:
    """Every external source the tools reach, each behind its own interface."""

    knowledge: KnowledgeProvider
    hotels: dict[str, HotelProvider]
    weather: WeatherProvider
    events: EventsProvider
    geocoder: GeocodingProvider
    router: RoutingProvider
    news: NewsProvider
    restaurants: RestaurantSearchProvider
    table_reservations: TableReservationProvider
    air: AirQualityProvider | None = None
    places: DestinationFinder | None = None  # resolves destination names; the weather service's search if unset


def build_tools(providers: Providers) -> ToolRegistry:
    knowledge = providers.knowledge
    hotel_providers = providers.hotels

    async def conditions_for(destination: str, start: date, end: date, today: date) -> conditions_service.Conditions:
        return await conditions_service.get_conditions(
            providers.weather,
            providers.events,
            destination,
            start,
            end,
            today,
            news=providers.news,
            air=providers.air,
            places=providers.places,
        )

    async def get_local_news(ctx: ToolContext, args: LocalNewsArgs) -> ToolResult:
        try:
            items = await providers.news.disruptions(args.place)
        except NewsError as exc:
            raise ToolFailure(f"{exc} No news was retrieved; do not describe current events from memory.") from exc
        if not items:
            return ToolResult(
                {"news": [], "note": "No recent headlines about disruptions were found. This search is not exhaustive."}
            )
        return ToolResult(
            {"news": conditions_service.news_for_model(items), "news_note": conditions_service.NEWS_NOTE},
            card=conditions_service.news_card(args.place, items),
        )

    async def find_place(name: str):
        try:
            if providers.places is not None:
                return await providers.places.find_destination(name)
            return await providers.weather.find_city(name)
        except (WeatherError, MapsError):
            return None

    async def trip_budget(trip) -> budget_service.BudgetPlan | None:
        """The budget split for the trip in this conversation, with travel there if the start is known."""
        distance = None
        if trip.origin and trip.destination:
            start, end = await find_place(trip.origin), await find_place(trip.destination)
            if start and end:
                distance = route_service.haversine_km(
                    GeoPoint(start.latitude, start.longitude), GeoPoint(end.latitude, end.longitude)
                )
        return budget_service.plan(trip, distance)

    async def destination_area(destination: str) -> tuple[GeoPoint | None, float]:
        """Centre of the destination and how far from it its places may lie."""
        try:
            if providers.places is not None:
                city = await providers.places.find_destination(destination)
            else:
                city = await providers.weather.find_city(destination)
        except (WeatherError, MapsError):
            return None, route_service.MAX_KM_FROM_DESTINATION
        if city is None:
            return None, route_service.MAX_KM_FROM_DESTINATION
        return GeoPoint(city.latitude, city.longitude, city.name), route_service.reach_km(city.radius_km)

    async def save_trip_requirements(ctx: ToolContext, args: TripRequirementsArgs) -> ToolResult:
        try:
            trip = await trip_service.save_requirements(ctx.db, ctx.user_id, ctx.conversation_id, args, ctx.today)
        except trip_service.TripError as exc:
            raise ToolFailure(str(exc)) from exc
        data = trip_service.trip_summary(trip)
        # As soon as the place and dates are known, say what the traveller will walk into.
        if trip.destination and trip.start_date and trip.end_date:
            try:
                conditions = await conditions_for(trip.destination, trip.start_date, trip.end_date, ctx.today)
                data["conditions"] = conditions_service.for_model(conditions)
            except conditions_service.ConditionsError as exc:
                data["conditions"] = {"could_not_check": [str(exc)]}
        budget = await trip_budget(trip)
        if budget is not None:
            data["budget_plan"] = budget_service.for_model(budget)
        return ToolResult(data)

    async def get_trip_conditions(ctx: ToolContext, args: TripConditionsArgs) -> ToolResult:
        if args.end_date < args.start_date:
            raise ToolFailure("end_date is before start_date.")
        if args.end_date < ctx.today:
            raise ToolFailure(travel_dates.past_dates_message(args.start_date, args.end_date, ctx.today))
        try:
            conditions = await conditions_for(args.destination, args.start_date, args.end_date, ctx.today)
        except conditions_service.ConditionsError as exc:
            raise ToolFailure(str(exc)) from exc
        return ToolResult(conditions_service.for_model(conditions))

    async def optimize_route(ctx: ToolContext, args: OptimizeRouteArgs) -> ToolResult:
        trip = await trip_service.get_trip(ctx.db, ctx.conversation_id)
        if trip is None or not trip.destination:
            raise ToolFailure("No destination saved yet. Call save_trip_requirements first.")
        day_count = len(trip_service.trip_dates(trip)) or 1
        center, reach = await destination_area(trip.destination)
        try:
            plan = await route_service.optimize(
                ctx.db,
                providers.geocoder,
                providers.router,
                trip.destination,
                args.places,
                day_count,
                center=center,
                start_from=args.start_from,
                max_km=reach,
            )
        except MapsError as exc:
            raise ToolFailure(f"{exc} No route was computed; order the stops by your own judgement and say so.") from exc
        data: dict[str, Any] = {
            "days": [
                {"day": number, "stops_in_order": day.stops, "km": day.total_km, "minutes_driving": day.total_minutes}
                for number, day in enumerate(plan.days, start=1)
            ],
            "distance_source": plan.source,
            "note": "This is the shortest order, cut into days of neighbouring stops. Keep each day's stops "
            "together and in this order unless timing forces a change (e.g. a night market must be at night).",
        }
        if plan.unlocated:
            data["could_not_locate"] = plan.unlocated
            data["could_not_locate_note"] = "These are not on the map, so they are not in the route. Place them yourself and say so."
        return ToolResult(data)

    async def search_place_info(ctx: ToolContext, args: SearchPlaceArgs) -> ToolResult:
        queries, skipped = args.queries[:MAX_LOOKUPS_PER_CALL], args.queries[MAX_LOOKUPS_PER_CALL:]
        # All lookups go out together: one model step instead of one per place.
        try:
            found = await asyncio.gather(*(knowledge.search_places(query, RESULTS_PER_LOOKUP) for query in queries))
        except KnowledgeError as exc:
            raise ToolFailure(f"{exc} No information was retrieved.") from exc
        results = [{"query": query, **asdict(result)} for query, matches in zip(queries, found) for result in matches]
        data: dict[str, Any] = {"results": results}
        if skipped:
            data["not_looked_up"] = skipped
        not_found = [query for query, matches in zip(queries, found) if not matches]
        if not_found:
            data["not_found"] = not_found
            data["note"] = "Nothing was found for the not_found queries. Say so rather than answering from memory."
        return ToolResult(data)

    async def get_travel_guide(ctx: ToolContext, args: TravelGuideArgs) -> ToolResult:
        try:
            guide = await knowledge.travel_guide(args.destination)
        except KnowledgeError as exc:
            raise ToolFailure(f"{exc} No guide was retrieved.") from exc
        if guide is None:
            return ToolResult({"guide": None, "note": "No travel guide found for this destination."})
        return ToolResult({"guide": asdict(guide)})

    async def save_itinerary(ctx: ToolContext, args: SaveItineraryArgs) -> ToolResult:
        trip = await trip_service.get_trip(ctx.db, ctx.conversation_id)
        if trip is None:
            raise ToolFailure("No trip details saved yet. Call save_trip_requirements first.")
        try:
            itinerary, remaining = await itinerary_service.save_days(ctx.db, trip, args, await known_source_urls(ctx))
        except itinerary_service.ItineraryError as exc:
            raise ToolFailure(str(exc)) from exc
        if itinerary is None:
            # A long trip is saved a few days at a time; nothing is shown until it is whole.
            return ToolResult(
                {
                    "saved_days": [day.date.isoformat() for day in args.days],
                    "remaining_dates": [day.isoformat() for day in remaining],
                    "note": f"Not complete yet. Call save_itinerary again with the next days, at most "
                    f"{itinerary_service.MAX_DAYS_PER_CALL} per call. The traveller sees the itinerary once every "
                    "day is saved; do not describe it before then.",
                }
            )

        card = itinerary_service.itinerary_card(trip, itinerary)
        result: dict[str, Any] = {
            "saved": True,
            "version": itinerary.version,
            "note": "The traveller now sees the full itinerary as a card.",
        }
        budget = await trip_budget(trip)
        if budget is not None:
            card["budget"] = budget_service.for_card(budget)

        # Attach what the traveller needs to know about each day. Failures here are
        # reported, never allowed to lose the saved plan.
        try:
            conditions = await conditions_for(trip.destination, trip.start_date, trip.end_date, ctx.today)
            card["conditions"] = conditions_service.for_card(conditions)
            result["alerts"] = conditions_service.alerts(conditions)
        except conditions_service.ConditionsError as exc:
            card["conditions"] = {"problems": [str(exc)], "days": {}, "alerts": []}
            result["conditions_unavailable"] = str(exc)

        center, reach = await destination_area(trip.destination)
        try:
            measured = await route_service.measure(
                ctx.db,
                providers.geocoder,
                providers.router,
                trip.destination,
                [[item["place"] for item in day["items"]] for day in card["days"]],
                center=center,
                max_km=reach,
            )
            for day, route in zip(card["days"], measured.days):
                day["route"] = route.as_dict()
            card["route_source"] = measured.source
            wasteful = [
                {"day": number, "better_order": route.shorter_order, "km_now": route.total_km}
                for number, route in enumerate(measured.days, start=1)
                if route.shorter_order
            ]
            if wasteful:
                result["route_warning"] = (
                    "These days visit places in a longer order than necessary. Save a revised itinerary with "
                    "the stops in better_order unless timing forces the current order."
                )
                result["wasteful_days"] = wasteful
        except MapsError as exc:
            result["route_unavailable"] = str(exc)
        return ToolResult(result, card=card)

    async def compare_hotels(ctx: ToolContext, args: CompareHotelsArgs) -> ToolResult:
        search = HotelSearch(
            destination=args.destination,
            area=args.area,
            check_in=args.check_in,
            check_out=args.check_out,
            adults=args.adults,
            rooms=args.rooms or math.ceil(args.adults / 2),
        )
        try:
            comparison = await hotel_comparison.compare(
                ctx.db,
                hotel_providers,
                search,
                ctx.user_id,
                ctx.conversation_id,
                ctx.today,
                sort_by=args.sort_by,
                max_total_price=Decimal(str(args.max_total_price)) if args.max_total_price else None,
            )
        except hotel_comparison.HotelSearchError as exc:
            raise ToolFailure(str(exc)) from exc
        card = hotel_comparison.comparison_card(comparison) if comparison.offers else None
        return ToolResult(hotel_comparison.comparison_for_model(comparison), card=card)

    async def prepare_booking(ctx: ToolContext, args: PrepareBookingArgs) -> ToolResult:
        try:
            booking, previous_price = await booking_service.prepare(
                ctx.db, hotel_providers, ctx.user_id, ctx.conversation_id, args.offer_id, args.guest_name
            )
        except (booking_service.BookingError, HotelProviderError) as exc:
            raise ToolFailure(f"{exc} Nothing was booked.") from exc
        view = booking_service.booking_view(booking, hotel_providers)
        data = {
            "booking_id": booking.id,
            "status": "NOT BOOKED YET - waiting for the traveller to press Confirm on the card they now see",
            "hotel": view["hotel_name"],
            "provider": view["provider_name"],
            "total_price": view["total_price"],
            "currency": view["currency"],
            "cancellation": view["cancellation_policy"],
        }
        if previous_price is not None:
            data["price_changed"] = f"The price was {previous_price} when shown and is now {booking.total_price}. Tell the traveller."
        return ToolResult(data, card={"type": "booking_confirm", "booking_id": booking.id})

    async def list_bookings(ctx: ToolContext, args: NoArgs) -> ToolResult:
        bookings = await booking_service.list_bookings(ctx.db, ctx.user_id)
        views = [booking_service.booking_view(booking, hotel_providers) for booking in bookings]
        keys = ("id", "status", "hotel_name", "provider_name", "check_in", "check_out", "total_price", "currency",
                "provider_reference", "cancellation_policy", "refund_amount", "failure_reason")
        return ToolResult({"bookings": [{key: view[key] for key in keys} for view in views]})

    async def prepare_cancellation(ctx: ToolContext, args: PrepareCancellationArgs) -> ToolResult:
        try:
            booking, quote = await booking_service.cancellation_quote(
                ctx.db, hotel_providers, ctx.user_id, args.booking_id
            )
        except booking_service.BookingError as exc:
            raise ToolFailure(f"{exc} Nothing was cancelled.") from exc
        data = {
            "booking_id": booking.id,
            "status": "NOT CANCELLED YET - waiting for the traveller to press Confirm on the card they now see",
            "hotel": booking.offer["hotel_name"],
            "refund_amount": float(quote.refund_amount),
            "cancellation_fee": float(quote.fee),
            "currency": quote.currency,
        }
        card = {
            "type": "cancel_confirm",
            "booking_id": booking.id,
            "refund_amount": float(quote.refund_amount),
            "fee": float(quote.fee),
            "currency": quote.currency,
        }
        return ToolResult(data, card=card)

    async def transport_search_links(ctx: ToolContext, args: TransportLinksArgs) -> ToolResult:
        try:
            if args.mode == "flight":
                found = search_links.flight_links(
                    args.origin, args.destination, args.date, args.return_date, args.travellers, ctx.today
                )
            elif args.mode == "train":
                found = search_links.train_links(args.origin, args.destination, args.date, args.travellers, ctx.today)
            else:
                found = search_links.bus_links(args.origin, args.destination, args.date, ctx.today)
        except search_links.SearchLinkError as exc:
            raise ToolFailure(str(exc)) from exc
        data = found.for_model()
        budget = await conversation_budget(ctx)
        if budget is not None and budget.chosen.travel_mode:
            mode = cost_table.MODES[budget.chosen.travel_mode]
            data["budget_plan_recommends"] = (
                f"{mode.name} (the '{budget.chosen.tier.name}' level of the trip budget). "
                + ("" if mode.search_mode == args.mode else f"Offer {mode.search_mode} links too if the traveller wants to save.")
            )
        return ToolResult(data, card=found.card(args.mode))

    async def conversation_budget(ctx: ToolContext) -> budget_service.BudgetPlan | None:
        trip = await trip_service.get_trip(ctx.db, ctx.conversation_id)
        return await trip_budget(trip) if trip is not None else None

    async def hotel_search_links(ctx: ToolContext, args: HotelLinksArgs) -> ToolResult:
        rooms = args.rooms or math.ceil(args.adults / 2)
        max_price, budget = args.max_price_per_night, None
        if max_price is None:
            # The trip's budget decides what a night may cost, so the searches open on
            # hotels the traveller can afford.
            budget = await conversation_budget(ctx)
            if budget is not None:
                max_price = budget.chosen.tier.hotel_per_room_night * rooms
        try:
            found = search_links.hotel_links(
                args.city, args.area, args.check_in, args.check_out, args.adults, rooms, ctx.today, max_price
            )
        except search_links.SearchLinkError as exc:
            raise ToolFailure(str(exc)) from exc
        data = found.for_model()
        if max_price is not None:
            data["price_limit"] = (
                f"Booking.com opens filtered to at most ₹{max_price:,} a night for {rooms} room{'s' if rooms > 1 else ''}"
                + (f", from the trip's '{budget.chosen.tier.name}' budget level" if budget is not None else "")
                + ", cheapest first. Google Hotels opens unfiltered; the traveller can set its price filter there."
            )
        return ToolResult(data, card=found.card("hotel"))

    async def find_restaurants(ctx: ToolContext, args: FindRestaurantsArgs) -> ToolResult:
        near, near_label = None, None
        if args.near_traveller:
            if ctx.location is None:
                # The traveller sees a button that shares their location and asks again.
                return ToolResult(
                    {
                        "error": "The traveller's location has not been shared, so nothing was searched.",
                        "reply_instructions": "They now see a 'Share my location' button. In one sentence, ask "
                        "them to press it, or to name the area instead. Do not guess where they are.",
                    },
                    card={"type": "location_request", "purpose": "find places to eat near you"},
                )
            near = GeoPoint(ctx.location.latitude, ctx.location.longitude)
            try:
                area = await providers.geocoder.describe(near)
            except MapsError:
                area = None
            near_label = area or "your location"
        elif not args.city:
            raise ToolFailure("Give the city (and area if known), or set near_traveller if they mean near them.")
        try:
            result = await restaurant_service.find(
                ctx.db,
                providers.geocoder,
                providers.restaurants,
                args.city,
                args.area,
                args.cuisine_keywords,
                ctx.user_id,
                ctx.conversation_id,
                needs_non_veg=args.dish_has_meat_or_fish,
                near=near,
                near_label=near_label,
            )
        except (restaurant_service.RestaurantSearchError, MapsError) as exc:
            raise ToolFailure(f"{exc} No restaurants were retrieved; do not suggest any from memory.") from exc
        card = restaurant_service.search_card(result, args.dish) if result.matches else None
        data = restaurant_service.search_for_model(result)
        if near is not None:
            accuracy = ctx.location.accuracy_m
            data["location_note"] = (
                "Searched around the traveller's own position, shared from their browser; distances are straight "
                "lines from them. Refer to it by the area name only."
                + (f" Their position is only approximate (within about {accuracy / 1000:.1f} km), so say the "
                   "distances are rough." if accuracy and accuracy > 1000 else "")
            )
        return ToolResult(data, card=card)

    async def prepare_table_booking(ctx: ToolContext, args: PrepareTableBookingArgs) -> ToolResult:
        try:
            booking = await restaurant_service.prepare(
                ctx.db,
                providers.table_reservations,
                ctx.user_id,
                ctx.conversation_id,
                args.restaurant_id,
                args.date,
                time_type.fromisoformat(args.time),
                args.party_size,
                args.guest_name,
                ctx.today,
            )
        except restaurant_service.TableBookingError as exc:
            raise ToolFailure(f"{exc} Nothing was reserved.") from exc
        view = restaurant_service.booking_view(booking)
        data = {
            "booking_id": booking.id,
            "status": "NOT RESERVED YET - waiting for the traveller to press Confirm on the card they now see",
            "restaurant": view["restaurant_name"],
            "date": view["date"],
            "time": view["time"],
            "party_size": view["party_size"],
            "published_opening_hours": view["opening_hours"] or "not published; the time could not be checked",
        }
        if booking.is_demo:
            data["demo"] = (
                "This reservation service is simulated: the restaurant is not contacted and no table is held. "
                "Tell the traveller to phone the restaurant to be sure of a table."
            )
        return ToolResult(data, card={"type": "table_confirm", "booking_id": booking.id})

    async def list_table_bookings(ctx: ToolContext, args: NoArgs) -> ToolResult:
        bookings = await restaurant_service.list_bookings(ctx.db, ctx.user_id)
        keys = ("id", "status", "restaurant_name", "date", "time", "party_size", "provider_reference", "failure_reason")
        views = [restaurant_service.booking_view(booking) for booking in bookings]
        return ToolResult({"reservations": [{key: view[key] for key in keys} for view in views]})

    async def prepare_table_cancellation(ctx: ToolContext, args: PrepareCancellationArgs) -> ToolResult:
        try:
            booking = await restaurant_service.get_booking(ctx.db, ctx.user_id, args.booking_id)
        except restaurant_service.TableBookingError as exc:
            raise ToolFailure(f"{exc} Nothing was cancelled.") from exc
        view = restaurant_service.booking_view(booking)
        if view["status"] != "CONFIRMED":
            raise ToolFailure(
                f"Reservation {booking.id} is {view['status'].lower().replace('_', ' ')}, so it cannot be cancelled. "
                "Nothing was cancelled."
            )
        data = {
            "booking_id": booking.id,
            "status": "NOT CANCELLED YET - waiting for the traveller to press Confirm on the card they now see",
            "restaurant": view["restaurant_name"],
            "date": view["date"],
            "time": view["time"],
        }
        return ToolResult(data, card={"type": "table_cancel_confirm", "booking_id": booking.id})

    async def trip_note(ctx: ToolContext) -> str | None:
        """The saved trip in a few lines, so no specialist depends on old messages to know it."""
        trip = await trip_service.get_trip(ctx.db, ctx.conversation_id)
        if trip is None:
            return None
        lines = ["## Current trip", "Saved in this conversation. Trust this over older messages; change it only with save_trip_requirements."]
        dates = trip_service.trip_dates(trip)
        details = {
            "Destination": trip.destination,
            "Dates": f"{dates[0].isoformat()} to {dates[-1].isoformat()} ({len(dates)} day{'s' if len(dates) > 1 else ''})"
            if dates else None,
            "Travellers": (f"{trip.adults} adult{'s' if trip.adults > 1 else ''}"
                           + (f", {trip.children} children" if trip.children else "")) if trip.adults else None,
            "Starting from": trip.origin,
            "Budget": f"{trip.currency or ''} {trip.budget_total:,.0f} in total".strip()
            if trip.budget_total is not None else trip.budget_level,
            "Interests": ", ".join(trip.interests) if trip.interests else None,
            "Pace": trip.pace,
            "Must visit": ", ".join(trip.must_visit) if trip.must_visit else None,
            "Notes": trip.notes,
        }
        lines += [f"- {label}: {value}" for label, value in details.items() if value]
        missing = trip_service.missing_requirements(trip)
        if missing:
            lines.append("- Still needed before planning: " + ", ".join(missing))
        budget = await trip_budget(trip)
        if budget is not None:
            text = f"- Budget estimate: {budget.chosen.tier.name} level, about ₹{budget.chosen.total:,}"
            if budget.budget is not None:
                text += (f", ₹{budget.budget - budget.chosen.total:,} under budget" if budget.fits
                         else f", ₹{budget.shortfall:,} OVER budget even at the cheapest level")
            lines.append(text + ". Full figures come with save_trip_requirements.")
        version = await ctx.db.scalar(select(func.max(Itinerary.version)).where(Itinerary.trip_id == trip.id))
        lines.append(f"- Itinerary: saved (version {version})" if version else "- Itinerary: not saved yet")
        return "\n".join(lines)

    return ToolRegistry(
        [
            Tool(
                "save_trip_requirements",
                "Record what the traveller has said about the trip (destination, dates, travellers, budget, "
                "interests, pace, must-visit places). Call it whenever they give or change any of these. "
                "Returns the stored details, what is still missing, whether planning can start, and once the "
                "place and dates are known, the weather, holidays and alerts for those dates.",
                TripRequirementsArgs,
                save_trip_requirements,
                status="Noting your trip details…",
                recap=_recap_trip,
            ),
            Tool(
                "search_place_info",
                "Look up places, monuments, neighbourhoods or dishes in Wikipedia, several at once. Returns "
                "matching entries with a summary and URL. Use it for facts, history and stories about a place.",
                SearchPlaceArgs,
                search_place_info,
                status="Looking up the place…",
                recap=_recap_places,
                bulky_reference=True,
            ),
            Tool(
                "get_travel_guide",
                "Fetch the Wikivoyage traveller guide for a destination: background, what to see, what to do "
                "and what to eat. Use it before planning an itinerary.",
                TravelGuideArgs,
                get_travel_guide,
                status="Reading the travel guide…",
                recap=_recap_guide,
                bulky_reference=True,
            ),
            Tool(
                "save_itinerary",
                "Save the day-by-day itinerary and show it to the traveller. It is checked against the trip: "
                "one day per trip date, the pace limit, every must-visit place included, and source URLs that "
                "came from a lookup. If it is rejected, fix the listed problems and call it again. The result "
                "reports alerts for the dates and any day whose stop order wastes distance.",
                SaveItineraryArgs,
                save_itinerary,
                status="Building your itinerary…",
                recap=_recap_itinerary,
                unavailable_hint="Save complete trip details with save_trip_requirements first.",
            ),
            Tool(
                "get_trip_conditions",
                "Weather, air quality (AQI) and public holidays or festivals for a place and dates, with alerts. "
                "Use it for a direct question about weather, pollution or what is happening there; trip "
                "planning already gets this from save_trip_requirements.",
                TripConditionsArgs,
                get_trip_conditions,
                status="Checking the weather and holidays…",
                recap=_recap_conditions,
            ),
            Tool(
                "get_local_news",
                "Recent news headlines about a city that mention strikes, protests, closures, floods, traffic "
                "diversions or large gatherings. Use it when the traveller asks what is happening there now "
                "or whether something might disrupt a visit. The traveller is shown the headlines with links.",
                LocalNewsArgs,
                get_local_news,
                status="Checking local news…",
                recap=_recap_news,
            ),
            Tool(
                "optimize_route",
                "Work out the shortest route through the places the traveller agreed to, grouped into the "
                "trip's days. Locates each place on the map and uses road distances. Call it before "
                "save_itinerary.",
                OptimizeRouteArgs,
                optimize_route,
                status="Working out the shortest route…",
                recap=_recap_route,
                unavailable_hint="Save complete trip details with save_trip_requirements first.",
            ),
            Tool(
                "compare_hotels",
                "Search every connected hotel provider for a stay and compare the offers. Returns offers with "
                "an offer_id, total price, provider and cancellation terms; the traveller sees them as a "
                "comparison table. This is the only source of hotel prices and availability.",
                CompareHotelsArgs,
                compare_hotels,
                status="Comparing hotel prices across providers…",
            ),
            Tool(
                "prepare_booking",
                "Prepare a hotel booking for an offer_id returned by compare_hotels. Re-checks the price and "
                "shows the traveller a confirmation card. This does NOT book: only the traveller pressing "
                "Confirm on that card books it. Needs the full name of the lead guest.",
                PrepareBookingArgs,
                prepare_booking,
                status="Checking the latest price…",
                unavailable_hint="Run compare_hotels first; only an offer from a comparison can be booked.",
            ),
            Tool(
                "list_bookings",
                "List the traveller's hotel bookings and their real current status. Use it before saying "
                "anything about whether something is booked, confirmed, failed or cancelled.",
                NoArgs,
                list_bookings,
                status="Checking your bookings…",
            ),
            Tool(
                "prepare_cancellation",
                "Get the refund and fee for cancelling a confirmed booking and show the traveller a "
                "confirmation card. This does NOT cancel: only the traveller pressing Confirm cancels it.",
                PrepareCancellationArgs,
                prepare_cancellation,
                status="Checking the cancellation terms…",
                unavailable_hint="The traveller has no bookings.",
            ),
            Tool(
                "transport_search_links",
                "Give the traveller pre-filled search links for flights, trains or buses on a route and date, "
                "opening the providers' own sites where they see real times and prices and book. You do not "
                "receive any prices or times.",
                TransportLinksArgs,
                transport_search_links,
                status="Preparing travel search links…",
                recap=_recap_links,
            ),
            Tool(
                "hotel_search_links",
                "Give the traveller pre-filled hotel search links (Google Hotels, which compares booking sites, "
                "and Booking.com) for a place and dates. They see real hotels and prices there and book there. "
                "You do not receive any prices.",
                HotelLinksArgs,
                hotel_search_links,
                status="Preparing hotel search links…",
                recap=_recap_links,
            ),
            Tool(
                "find_restaurants",
                "Find restaurants for a dish or cuisine near an area of a city, or near the traveller themselves, "
                "from OpenStreetMap. For 'near me' or 'nearby', call it with near_traveller true straight away, "
                "even if you do not know where they are: the app gets their position from their browser, or shows "
                "them a button to share it. The traveller sees the results as a list and a map. The data has no "
                "ratings or menus.",
                FindRestaurantsArgs,
                find_restaurants,
                status="Looking for restaurants…",
            ),
            Tool(
                "prepare_table_booking",
                "Prepare a table reservation at a restaurant_id returned by find_restaurants and show the "
                "traveller a confirmation card. This does NOT reserve: only the traveller pressing Confirm "
                "does. Needs the date, time, number of people and the name for the reservation.",
                PrepareTableBookingArgs,
                prepare_table_booking,
                status="Preparing the reservation…",
                unavailable_hint="Run find_restaurants first; only a restaurant from a search can be reserved.",
            ),
            Tool(
                "list_table_bookings",
                "List the traveller's table reservations and their real current status. Use it before saying "
                "anything about whether a table is reserved or cancelled.",
                NoArgs,
                list_table_bookings,
                status="Checking your reservations…",
            ),
            Tool(
                "prepare_table_cancellation",
                "Show the traveller a card to cancel a confirmed table reservation (booking_id from "
                "list_table_bookings). This does NOT cancel: only the traveller pressing Confirm does.",
                PrepareCancellationArgs,
                prepare_table_cancellation,
                status="Preparing the cancellation…",
                unavailable_hint="The traveller has no table reservations.",
            ),
        ],
        trip_note=trip_note,
    )
