import httpx
import pytest

from app.providers.maps.base import GeoPoint, MapsError
from app.providers.maps.nominatim import NominatimGeocoder
from app.providers.maps.osrm import OsrmRouter
from app.providers.maps.wikipedia_geocoder import FallbackGeocoder, WikipediaGeocoder
from tests.conftest import FakeGeocoder


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_nominatim_normalises_result_and_handles_misses_and_errors():
    def found(request):
        assert request.url.params["q"] == "Rajwada Palace, Indore"
        return httpx.Response(200, json=[{"lat": "22.7180", "lon": "75.8547", "display_name": "Rajwada Palace, Indore"}])

    point = await NominatimGeocoder("test", client=_client(found), min_interval=0).geocode("Rajwada Palace, Indore")
    assert point == GeoPoint(22.718, 75.8547, "Rajwada Palace, Indore")

    miss = NominatimGeocoder("test", client=_client(lambda r: httpx.Response(200, json=[])), min_interval=0)
    assert await miss.geocode("Atlantis") is None
    down = NominatimGeocoder("test", client=_client(lambda r: httpx.Response(503)), min_interval=0)
    with pytest.raises(MapsError):
        await down.geocode("Anything")


async def test_wikipedia_geocoder_uses_article_coordinates():
    def handler(request):
        assert request.url.params["gsrsearch"] == "Khajrana Ganesh Temple  Indore"
        return httpx.Response(
            200, json={"query": {"pages": [{"title": "Khajrana Ganesh Temple", "coordinates": [{"lat": 22.73, "lon": 75.9}]}]}}
        )

    point = await WikipediaGeocoder("test", client=_client(handler)).geocode("Khajrana Ganesh Temple, Indore")
    assert point == GeoPoint(22.73, 75.9, "Khajrana Ganesh Temple")

    no_coordinates = _client(lambda r: httpx.Response(200, json={"query": {"pages": [{"title": "Chappan Dukan"}]}}))
    assert await WikipediaGeocoder("test", client=no_coordinates).geocode("Chappan Dukan, Indore") is None


async def test_fallback_tries_the_next_geocoder_on_a_miss_or_failure():
    first, second = FakeGeocoder(), FakeGeocoder()
    first.places = {}
    chain = FallbackGeocoder([first, second])

    assert await chain.geocode("Red Fort, Delhi") == second.places["red fort"]
    assert await chain.geocode("Atlantis, Delhi") is None

    first.error = MapsError("down")
    assert await chain.geocode("Red Fort, Delhi") == second.places["red fort"]
    # Unknown because a source failed is an error, not "not found".
    with pytest.raises(MapsError):
        await chain.geocode("Atlantis, Delhi")


async def test_osrm_converts_units_and_reports_failures():
    def handler(request):
        assert request.url.path.endswith("/75.850000,22.710000;75.860000,22.720000")
        return httpx.Response(200, json={"code": "Ok", "distances": [[0, 3540.8], [3012.7, 0]], "durations": [[0, 600], [540, 0]]})

    points = [GeoPoint(22.71, 75.85), GeoPoint(22.72, 75.86)]
    matrix = await OsrmRouter("test", client=_client(handler)).matrix(points)
    assert matrix.distances_km[0] == pytest.approx([0, 3.5408]) and matrix.distances_km[1] == pytest.approx([3.0127, 0])
    assert matrix.minutes == [[0, 10], [9, 0]]
    assert "without traffic" in matrix.source

    for response in (httpx.Response(200, json={"code": "NoRoute"}), httpx.Response(500)):
        with pytest.raises(MapsError):
            await OsrmRouter("test", client=_client(lambda r, response=response: response)).matrix(points)
