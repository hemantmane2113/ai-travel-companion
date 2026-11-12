import httpx

from app.providers.maps.base import GeoPoint, MapsError, RoutingProvider, TravelMatrix

# The public demo server suits one person testing; a public app needs its own or a hosted one.
PUBLIC_OSRM = "https://router.project-osrm.org"


class OsrmRouter(RoutingProvider):
    """Driving distances and times over the OpenStreetMap road network.

    Times are free-flow: they do not include traffic.
    """

    def __init__(
        self,
        user_agent: str,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
        base_url: str = PUBLIC_OSRM,
    ):
        self._table_url = base_url.rstrip("/") + "/table/v1/driving/"
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})

    async def aclose(self) -> None:
        await self._client.aclose()

    async def matrix(self, points: list[GeoPoint]) -> TravelMatrix:
        coordinates = ";".join(f"{point.longitude:.6f},{point.latitude:.6f}" for point in points)
        try:
            response = await self._client.get(
                self._table_url + coordinates, params={"annotations": "distance,duration"}
            )
            response.raise_for_status()
            data = response.json()
            if data.get("code") != "Ok":
                raise MapsError("The routing service could not route between these places.")
            size = len(points)
            distances = [[(data["distances"][i][j] or 0.0) / 1000 for j in range(size)] for i in range(size)]
            minutes = [[(data["durations"][i][j] or 0.0) / 60 for j in range(size)] for i in range(size)]
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise MapsError("The routing service did not return distances.") from exc
        return TravelMatrix(distances, minutes, "OpenStreetMap roads (OSRM), without traffic")
