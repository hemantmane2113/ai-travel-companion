import logging
import re
import time
from typing import Any

import httpx

from app.providers.maps.base import GeoPoint
from app.providers.restaurants.base import Restaurant, RestaurantSearchProvider, RestaurantsError

logger = logging.getLogger(__name__)

# Public Overpass servers are often overloaded; the next one is tried when one fails.
# They suit one person testing; a public app needs its own or a hosted server.
PUBLIC_OVERPASS_SERVERS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
PUBLIC_NOMINATIM = "https://nominatim.openstreetmap.org"
NOMINATIM_LIMIT = 40  # the most Nominatim returns for one search
MAX_ELEMENTS = 400
CACHE_SECONDS = 60 * 60
KM_PER_DEGREE = 111.0


def _restaurant(
    osm_type: str, osm_id: Any, name: str | None, tags: dict[str, Any], latitude: float, longitude: float, address: str
) -> Restaurant | None:
    if not name:
        return None
    return Restaurant(
        source_id=f"{osm_type}/{osm_id}",
        name=tags.get("name:en") or name,
        cuisines=[c.strip().replace("_", " ") for c in re.split(r"[;,]", tags.get("cuisine", "")) if c.strip()],
        address=address,
        latitude=latitude,
        longitude=longitude,
        opening_hours=tags.get("opening_hours"),
        phone=tags.get("phone") or tags.get("contact:phone"),
        website=tags.get("website") or tags.get("contact:website"),
        vegetarian_only=tags.get("diet:vegetarian") == "only",
        source="OpenStreetMap",
        source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
    )


def parse_element(element: dict[str, Any]) -> Restaurant | None:
    """One result of an Overpass query."""
    tags = element.get("tags", {})
    position = element if "lat" in element else element.get("center", {})
    if "lat" not in position:
        return None
    address = ", ".join(
        part
        for part in (
            " ".join(filter(None, (tags.get("addr:housenumber"), tags.get("addr:street")))),
            tags.get("addr:suburb") or tags.get("addr:district"),
        )
        if part
    )
    return _restaurant(element["type"], element["id"], tags.get("name"), tags, position["lat"], position["lon"], address)


def parse_nominatim(row: dict[str, Any]) -> Restaurant | None:
    """One result of a Nominatim search with extratags and addressdetails."""
    address = row.get("address") or {}
    street = " ".join(filter(None, (address.get("house_number"), address.get("road"))))
    area = address.get("suburb") or address.get("neighbourhood") or address.get("city_district")
    try:
        latitude, longitude = float(row["lat"]), float(row["lon"])
    except (KeyError, ValueError):
        return None
    return _restaurant(
        row.get("osm_type", "node"),
        row.get("osm_id"),
        row.get("name"),
        row.get("extratags") or {},
        latitude,
        longitude,
        ", ".join(part for part in (street, area) if part),
    )


class OverpassRestaurantProvider(RestaurantSearchProvider):
    """Restaurants as mapped by OpenStreetMap contributors, from the Overpass query servers.

    Coverage is uneven, and there are no ratings, prices or menus.
    """

    def __init__(
        self,
        user_agent: str,
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
        servers: tuple[str, ...] = PUBLIC_OVERPASS_SERVERS,
    ):
        self._servers = servers
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})
        self._cache: dict[tuple[float, float, int], tuple[float, list[Restaurant]]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def nearby(self, center: GeoPoint, radius_m: int) -> list[Restaurant]:
        key = (round(center.latitude, 3), round(center.longitude, 3), radius_m)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]

        query = (
            "[out:json][timeout:20];"
            'nwr["amenity"~"^(restaurant|fast_food|food_court)$"]'
            f"(around:{radius_m},{center.latitude:.6f},{center.longitude:.6f});"
            f"out center tags {MAX_ELEMENTS};"
        )
        for server in self._servers:
            try:
                response = await self._client.post(server, data={"data": query})
                response.raise_for_status()
                elements = response.json()["elements"]
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                logger.warning("overpass server %s failed: %r", server, exc)
                continue
            restaurants = [r for r in (parse_element(element) for element in elements) if r is not None]
            self._cache[key] = (time.monotonic(), restaurants)
            return restaurants
        raise RestaurantsError("The restaurant map service is not responding right now.")


class NominatimRestaurantProvider(RestaurantSearchProvider):
    """The same OpenStreetMap data through the Nominatim search service.

    More dependable than the Overpass servers, but returns at most 40 places per
    search, so a busy area is only partly covered.
    """

    def __init__(
        self,
        user_agent: str,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
        base_url: str = PUBLIC_NOMINATIM,
    ):
        self._search_url = base_url.rstrip("/") + "/search"
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})

    async def aclose(self) -> None:
        await self._client.aclose()

    async def nearby(self, center: GeoPoint, radius_m: int) -> list[Restaurant]:
        degrees = radius_m / 1000 / KM_PER_DEGREE
        box = (
            center.longitude - degrees,
            center.latitude + degrees,
            center.longitude + degrees,
            center.latitude - degrees,
        )
        try:
            response = await self._client.get(
                self._search_url,
                params={
                    "amenity": "restaurant",
                    "format": "jsonv2",
                    "limit": NOMINATIM_LIMIT,
                    "extratags": 1,
                    "addressdetails": 1,
                    "viewbox": ",".join(f"{value:.6f}" for value in box),
                    "bounded": 1,
                },
            )
            response.raise_for_status()
            rows = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RestaurantsError("The restaurant map service is not responding right now.") from exc
        return [r for r in (parse_nominatim(row) for row in rows) if r is not None]


class FallbackRestaurantProvider(RestaurantSearchProvider):
    def __init__(self, providers: list[RestaurantSearchProvider]):
        self._providers = providers

    async def aclose(self) -> None:
        for provider in self._providers:
            await provider.aclose()

    async def nearby(self, center: GeoPoint, radius_m: int) -> list[Restaurant]:
        failure: RestaurantsError | None = None
        for provider in self._providers:
            try:
                return await provider.nearby(center, radius_m)
            except RestaurantsError as exc:
                logger.warning("restaurant source %s failed: %s", type(provider).__name__, exc)
                failure = exc
        raise failure or RestaurantsError("No restaurant source is configured.")


def build_restaurant_provider(
    user_agent: str,
    overpass_servers: tuple[str, ...] = PUBLIC_OVERPASS_SERVERS,
    nominatim_url: str = PUBLIC_NOMINATIM,
) -> FallbackRestaurantProvider:
    """Overpass first for fuller coverage, Nominatim when the Overpass servers are down."""
    return FallbackRestaurantProvider(
        [
            OverpassRestaurantProvider(user_agent, servers=overpass_servers),
            NominatimRestaurantProvider(user_agent, base_url=nominatim_url),
        ]
    )
