import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import httpx

from app.providers.news.base import NewsError, NewsItem, NewsProvider

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
DISRUPTION_TERMS = (
    "strike OR bandh OR protest OR curfew OR flood OR closed OR closure OR "
    "festival OR rally OR procession OR traffic OR diversion OR shutdown"
)
CACHE_SECONDS = 30 * 60


def parse_feed(xml: str) -> list[NewsItem]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise NewsError("The news feed could not be read.") from exc
    items = []
    for entry in root.findall("./channel/item"):
        title, link, published = entry.findtext("title"), entry.findtext("link"), entry.findtext("pubDate")
        if not (title and link and published):
            continue
        source = entry.findtext("source") or ""
        # Feed titles end with " - Publication"; the publication is carried separately.
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        try:
            when = parsedate_to_datetime(published)
        except (TypeError, ValueError):
            continue
        items.append(NewsItem(title=title.strip(), source=source, published=when, url=link))
    return items


class GoogleNewsProvider(NewsProvider):
    """Headlines from the public Google News search feed."""

    def __init__(self, user_agent: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": user_agent}, follow_redirects=True
        )
        self._cache: dict[tuple[str, int], tuple[float, list[NewsItem]]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def disruptions(self, place: str, days: int = 7, limit: int = 6) -> list[NewsItem]:
        key = (place.lower(), days)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1][:limit]
        try:
            response = await self._client.get(
                GOOGLE_NEWS_RSS,
                params={"q": f'"{place}" ({DISRUPTION_TERMS}) when:{days}d', "hl": "en-IN", "gl": "IN", "ceid": "IN:en"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise NewsError("The news source could not be reached.") from exc
        items = sorted(parse_feed(response.text), key=lambda item: item.published, reverse=True)
        self._cache[key] = (time.monotonic(), items)
        return items[:limit]
