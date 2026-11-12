import re
import time
from typing import Any

import httpx

from app.providers.knowledge.base import KnowledgeError, KnowledgeProvider, PlaceInfo, TravelGuide

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIVOYAGE_API = "https://en.wikivoyage.org/w/api.php"

# Kept short on purpose: every lookup is re-sent to the model on each later step of the turn.
SUMMARY_CHARS = 350
SECTION_CHARS = 800
GUIDE_SECTIONS = ("See", "Do", "Eat")
CACHE_SECONDS = 60 * 60
MAX_ATTEMPTS = 2

_SECTION_HEADING = re.compile(r"^==\s*([^=].*?)\s*==\s*$", re.MULTILINE)


def _truncate(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


def split_sections(extract: str) -> dict[str, str]:
    """Split a plain-text extract on its level-2 headings ("== See ==")."""
    parts = _SECTION_HEADING.split(extract)
    # parts = [lead, heading1, body1, heading2, body2, ...]
    return {parts[i].strip(): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


class WikimediaKnowledgeProvider(KnowledgeProvider):
    """Wikipedia for facts and history, Wikivoyage for traveller guides."""

    def __init__(self, user_agent: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": user_agent})
        self._cache: dict[tuple[str, str], tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _query(self, api: str, params: dict[str, Any]) -> dict[str, Any]:
        params = {"action": "query", "format": "json", "formatversion": 2, **params}
        last_error: Exception | None = None
        for _ in range(MAX_ATTEMPTS):
            try:
                response = await self._client.get(api, params=params)
                if response.status_code == 429:
                    raise KnowledgeError("The reference source is rate limiting requests.")
                response.raise_for_status()
                return response.json().get("query", {})
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = exc
            except (httpx.HTTPStatusError, ValueError) as exc:
                raise KnowledgeError("The reference source returned an error.") from exc
        raise KnowledgeError("The reference source did not respond.") from last_error

    def _cached(self, key: tuple[str, str]) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
        return None

    async def search_places(self, query: str, limit: int = 3) -> list[PlaceInfo]:
        key = ("search", f"{query.lower()}|{limit}")
        if (cached := self._cached(key)) is not None:
            return cached

        data = await self._query(
            WIKIPEDIA_API,
            {
                "generator": "search",
                "gsrsearch": query,
                "gsrlimit": limit,
                "prop": "extracts|info|pageprops",
                "exintro": 1,
                "explaintext": 1,
                "exlimit": "max",
                "inprop": "url",
                "ppprop": "disambiguation",
            },
        )
        pages = sorted(data.get("pages", []), key=lambda page: page.get("index", 0))
        results = [
            PlaceInfo(
                title=page["title"],
                summary=_truncate(page["extract"], SUMMARY_CHARS),
                url=page["fullurl"],
                source="Wikipedia",
            )
            for page in pages
            if page.get("extract") and "disambiguation" not in page.get("pageprops", {})
        ]
        self._cache[key] = (time.monotonic(), results)
        return results

    async def travel_guide(self, destination: str) -> TravelGuide | None:
        key = ("guide", destination.lower())
        if (cached := self._cached(key)) is not None:
            return cached or None

        data = await self._query(
            WIKIVOYAGE_API,
            {
                "generator": "search",
                "gsrsearch": destination,
                "gsrlimit": 1,
                "prop": "extracts|info",
                "explaintext": 1,
                "exsectionformat": "wiki",
                "inprop": "url",
            },
        )
        pages = data.get("pages", [])
        guide = None
        if pages and pages[0].get("extract"):
            page = pages[0]
            sections = split_sections(page["extract"])
            guide = TravelGuide(
                title=page["title"],
                url=page["fullurl"],
                source="Wikivoyage",
                sections={
                    name: _truncate(sections[name], SECTION_CHARS) for name in GUIDE_SECTIONS if sections.get(name)
                },
            )
        self._cache[key] = (time.monotonic(), guide or False)
        return guide
