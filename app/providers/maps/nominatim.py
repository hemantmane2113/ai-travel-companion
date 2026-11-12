import asyncio
import math
import time
from typing import Any

import httpx

from app.providers.maps.base import DestinationFinder, GeocodingProvider, GeoPoint, MapsError
from app.providers.weather.base import City

# The public server suits one person testing. A public app must use its own or a hosted
# Nominatim (its usage policy forbids app-scale traffic); only the URL changes.
PUBLIC_NOMINATIM = "https://nominatim.openstreetmap.org"
# OpenStreetMap's usage policy for the public server: at most one request per second.
MIN_SECONDS_BETWEEN_REQUESTS = 1.1
DESTINATION_CANDIDATES = 6
MIN_RADIUS_KM = 40.0
KM_PER_DEGREE = 111.0
# A point is sent rounded to about 100 m: enough to name the area, no more of the
# traveller's position than that leaves the app.
REVERSE_DECIMALS = 3
# The finest part of an address that names an area, then the town or city it is in.
AREA_KEYS = ("neighbourhood", "suburb", "quarter", "city_district", "village", "hamlet")
TOWN_KEYS = ("city", "town", "municipality", "county", "state_district")


def _radius_km(bounding_box: list[str] | None) -> float:
    """Half the diagonal of a result's bounding box: how far the place reaches from its centre."""
    try:
        south, north, west, east = map(float, bounding_box)
    except (TypeError, ValueError):
        return MIN_RADIUS_KM
    middle = math.radians((south + north) / 2)
    height = (north - south) * KM_PER_DEGREE
    width = (east - west) * KM_PER_DEGREE * math.cos(middle)
    return max(MIN_RADIUS_KM, math.hypot(height, width) / 2)


def pick_destination(results: list[dict[str, Any]]) -> City | None:
    """The most prominent match. A traveller who says "Kashmir" means the region, not
    one of the villages of that name, and Nominatim ranks prominence in "importance"."""
    if not results:
        return None
    best = max(results, key=lambda result: float(result.get("importance") or 0))
    address = best.get("address") or {}
    return City(
        name=best.get("name") or best.get("display_name", "").split(",")[0],
        region=address.get("state") if address.get("state") != best.get("name") else None,
        country=address.get("country", ""),
        country_code=(address.get("country_code") or "").upper(),
        latitude=float(best["lat"]),
        longitude=float(best["lon"]),
        radius_km=_radius_km(best.get("boundingbox")),
    )


class NominatimGeocoder(GeocodingProvider, DestinationFinder):
    def __init__(
        self,
        user_agent: str,
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
        min_interval: float = MIN_SECONDS_BETWEEN_REQUESTS,
        base_url: str = PUBLIC_NOMINATIM,
    ):
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})
        self._min_interval = min_interval
        self._lock = asyncio.Lock()
        self._last_request = 0.0
        self._destinations: dict[str, City | None] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _search(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        return await self._get("search", params)

    async def _get(self, endpoint: str, params: dict[str, Any]) -> Any:
        # One lock for every kind of lookup, so together they keep to the rate limit.
        async with self._lock:
            wait = self._min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                response = await self._client.get(f"{self._base_url}/{endpoint}", params={"format": "jsonv2", **params})
                response.raise_for_status()
                return response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise MapsError("The map service could not locate places right now.") from exc
            finally:
                self._last_request = time.monotonic()

    async def geocode(self, query: str) -> GeoPoint | None:
        results = await self._search({"q": query, "limit": 1})
        if not results:
            return None
        try:
            hit = results[0]
            return GeoPoint(float(hit["lat"]), float(hit["lon"]), hit.get("display_name", ""))
        except (KeyError, ValueError, TypeError) as exc:
            raise MapsError("The map service returned an unexpected response.") from exc

    async def find_destination(self, name: str) -> City | None:
        key = " ".join(name.lower().split())
        if key not in self._destinations:
            results = await self._search({"q": name, "limit": DESTINATION_CANDIDATES, "addressdetails": 1})
            try:
                self._destinations[key] = pick_destination(results)
            except (KeyError, ValueError, TypeError) as exc:
                raise MapsError("The map service returned an unexpected response.") from exc
        return self._destinations[key]

    async def describe(self, point: GeoPoint) -> str | None:
        params = {
            "lat": round(point.latitude, REVERSE_DECIMALS),
            "lon": round(point.longitude, REVERSE_DECIMALS),
            "zoom": 16,
            "addressdetails": 1,
        }
        result = await self._get("reverse", params)
        return area_name(result.get("address") or {}) if isinstance(result, dict) else None


def area_name(address: dict[str, Any]) -> str | None:
    """'Shivajinagar, Pune' from a Nominatim address; None if it names neither."""
    area = next((address[key] for key in AREA_KEYS if address.get(key)), None)
    town = next((address[key] for key in TOWN_KEYS if address.get(key)), None)
    parts = [part for part in (area, town) if part]
    if len(parts) == 2 and parts[0] == parts[1]:
        parts = parts[:1]
    return ", ".join(parts) or None
