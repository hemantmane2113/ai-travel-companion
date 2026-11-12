import httpx
import pytest

from app.providers.knowledge.base import KnowledgeError
from app.providers.knowledge.wikimedia import WikimediaKnowledgeProvider, split_sections


def _provider(handler) -> WikimediaKnowledgeProvider:
    return WikimediaKnowledgeProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_split_sections_uses_level_two_headings_only():
    extract = "Lead text.\n\n== See ==\nForts.\n\n=== Old Delhi ===\nRed Fort.\n\n== Eat ==\nChaat."
    assert split_sections(extract) == {"See": "Forts.\n\n=== Old Delhi ===\nRed Fort.", "Eat": "Chaat."}


async def test_search_places_normalises_orders_and_skips_disambiguation():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "query": {
                    "pages": [
                        {"index": 2, "title": "Delhi Gate", "extract": "A gate.", "fullurl": "https://en.wikipedia.org/wiki/Delhi_Gate"},
                        {"index": 1, "title": "Red Fort", "extract": "A fort. " * 300, "fullurl": "https://en.wikipedia.org/wiki/Red_Fort"},
                        {"index": 3, "title": "Fort", "extract": "May refer to", "fullurl": "https://x", "pageprops": {"disambiguation": ""}},
                    ]
                }
            },
        )

    provider = _provider(handler)
    results = await provider.search_places("Red Fort")

    assert [r.title for r in results] == ["Red Fort", "Delhi Gate"]
    assert results[0].url == "https://en.wikipedia.org/wiki/Red_Fort"
    assert results[0].source == "Wikipedia"
    assert len(results[0].summary) <= 601 and results[0].summary.endswith("…")

    await provider.search_places("red fort")  # served from cache
    assert len(calls) == 1


async def test_travel_guide_keeps_traveller_sections():
    def handler(request: httpx.Request) -> httpx.Response:
        extract = "Lead.\n\n== Understand ==\nCapital of India.\n\n== Get in ==\nBy plane.\n\n== See ==\nRed Fort."
        return httpx.Response(
            200, json={"query": {"pages": [{"title": "Delhi", "extract": extract, "fullurl": "https://en.wikivoyage.org/wiki/Delhi"}]}}
        )

    guide = await _provider(handler).travel_guide("Delhi")

    assert guide.url == "https://en.wikivoyage.org/wiki/Delhi"
    assert guide.sections == {"See": "Red Fort."}


async def test_no_results_and_failures():
    assert await _provider(lambda request: httpx.Response(200, json={})).search_places("zzz") == []
    assert await _provider(lambda request: httpx.Response(200, json={})).travel_guide("zzz") is None

    with pytest.raises(KnowledgeError, match="rate limiting"):
        await _provider(lambda request: httpx.Response(429)).search_places("x1")
    with pytest.raises(KnowledgeError, match="returned an error"):
        await _provider(lambda request: httpx.Response(500)).search_places("x2")

    attempts = []

    def timeout(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        raise httpx.ReadTimeout("slow")

    with pytest.raises(KnowledgeError, match="did not respond"):
        await _provider(timeout).search_places("x3")
    assert len(attempts) == 2  # one retry, then give up
