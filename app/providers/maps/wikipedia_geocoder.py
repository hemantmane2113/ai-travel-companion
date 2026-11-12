import logging

import httpx

from app.providers.maps.base import GeocodingProvider, GeoPoint, MapsError

logger = logging.getLogger(__name__)

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"


class WikipediaGeocoder(GeocodingProvider):
    """Coordinates of the best-matching Wikipedia article.

    Catches well-known places whose map name differs from what people call them.
    The best match can be a different place, so callers must check the result is
    near where they expect.
    """

    def __init__(self, user_agent: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})

    async def aclose(self) -> None:
        await self._client.aclose()

    async def geocode(self, query: str) -> GeoPoint | None:
        try:
            response = await self._client.get(
                WIKIPEDIA_API,
                params={
                    "action": "query",
                    "format": "json",
                    "formatversion": 2,
                    "generator": "search",
                    "gsrsearch": query.replace(",", " "),
                    "gsrlimit": 1,
                    "prop": "coordinates",
                },
            )
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
        except (httpx.HTTPError, ValueError) as exc:
            raise MapsError("The map service could not locate places right now.") from exc
        if not pages or not pages[0].get("coordinates"):
            return None
        point = pages[0]["coordinates"][0]
        return GeoPoint(point["lat"], point["lon"], pages[0].get("title", ""))


class FallbackGeocoder(GeocodingProvider):
    """Asks each geocoder in turn until one finds the place."""

    def __init__(self, geocoders: list[GeocodingProvider]):
        self._geocoders = geocoders

    async def aclose(self) -> None:
        for geocoder in self._geocoders:
            await geocoder.aclose()

    async def geocode(self, query: str) -> GeoPoint | None:
        failure: MapsError | None = None
        for geocoder in self._geocoders:
            try:
                point = await geocoder.geocode(query)
            except MapsError as exc:
                logger.warning("geocoder %s failed: %s", type(geocoder).__name__, exc)
                failure = exc
                continue
            if point is not None:
                return point
        if failure is not None:
            raise failure
        return None

    async def describe(self, point: GeoPoint) -> str | None:
        for geocoder in self._geocoders:
            try:
                name = await geocoder.describe(point)
            except MapsError as exc:
                logger.warning("geocoder %s could not name an area: %s", type(geocoder).__name__, exc)
                continue
            if name:
                return name
        return None
