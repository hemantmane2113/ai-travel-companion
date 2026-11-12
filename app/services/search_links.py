"""Pre-filled search links to sites where travellers compare real prices and book.

No API, key or account is involved: each link opens the provider's own search,
already filled in. The companion never sees the prices behind them. Every format
here was checked by opening it in a browser (October 2026); providers can change
their URLs, so the formats live in this one place.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any
from urllib.parse import quote, urlencode

from app.services import travel_dates

MAX_DAYS_AHEAD = 365


class SearchLinkError(Exception):
    """The request cannot be turned into a search. The message explains why."""


@dataclass
class SearchLink:
    provider: str
    url: str
    note: str = ""


@dataclass
class LinkSet:
    title: str
    subtitle: str
    links: list[SearchLink]
    gaps: list[str] = field(default_factory=list)  # what could not be linked, and why

    def card(self, kind: str) -> dict[str, Any]:
        return {
            "type": "search_links",
            "kind": kind,
            "title": self.title,
            "subtitle": self.subtitle,
            "links": [{"provider": l.provider, "url": l.url, "note": l.note} for l in self.links],
            "gaps": self.gaps,
        }

    def for_model(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "links_shown_to_traveller": [link.provider for link in self.links],
            "important": (
                "These open the providers' own searches. You have NOT seen any prices, times or availability, "
                "so do not state or estimate any. The traveller compares and books on those sites."
            ),
            "reply_instructions": (
                "The traveller sees these links as buttons. Do not paste URLs. At most three sentences. Mention only "
                "these links; any other search the traveller asked for needs its own call first."
            ),
        }
        if self.gaps:
            data["could_not_link"] = self.gaps
        return data


# ---------- place names and codes ----------

_ALIASES = {
    "bombay": "mumbai",
    "bengaluru": "bangalore",
    "calcutta": "kolkata",
    "madras": "chennai",
    "new delhi": "delhi",
    "gurugram": "gurgaon",
    "trivandrum": "thiruvananthapuram",
    "cochin": "kochi",
    "ernakulam": "kochi",
    "vizag": "visakhapatnam",
    "benaras": "varanasi",
    "banaras": "varanasi",
    "pondicherry": "puducherry",
    "mysuru": "mysore",
    "mangaluru": "mangalore",
    "prayagraj": "allahabad",
}

# Main airport for each city (IATA).
AIRPORTS = {
    "delhi": "DEL", "mumbai": "BOM", "bangalore": "BLR", "chennai": "MAA", "kolkata": "CCU", "hyderabad": "HYD",
    "pune": "PNQ", "ahmedabad": "AMD", "goa": "GOI", "jaipur": "JAI", "kochi": "COK", "lucknow": "LKO",
    "indore": "IDR", "bhopal": "BHO", "nagpur": "NAG", "patna": "PAT", "bhubaneswar": "BBI", "guwahati": "GAU",
    "chandigarh": "IXC", "amritsar": "ATQ", "srinagar": "SXR", "jammu": "IXJ", "leh": "IXL", "varanasi": "VNS",
    "thiruvananthapuram": "TRV", "coimbatore": "CJB", "madurai": "IXM", "mangalore": "IXE", "visakhapatnam": "VTZ",
    "vadodara": "BDQ", "surat": "STV", "udaipur": "UDR", "jodhpur": "JDH", "raipur": "RPR", "ranchi": "IXR",
    "dehradun": "DED", "bagdogra": "IXB", "port blair": "IXZ", "tirupati": "TIR", "aurangabad": "IXU",
    "rajkot": "RAJ", "agartala": "IXA", "imphal": "IMF", "allahabad": "IXD", "gwalior": "GWL", "jabalpur": "JLR",
    "mysore": "MYQ", "dubai": "DXB", "singapore": "SIN", "bangkok": "BKK", "london": "LHR", "kathmandu": "KTM",
}

# Main railway station for each city (Indian Railways code).
STATIONS = {
    "delhi": "NDLS", "mumbai": "CSMT", "bangalore": "SBC", "chennai": "MAS", "kolkata": "HWH", "hyderabad": "SC",
    "pune": "PUNE", "ahmedabad": "ADI", "goa": "MAO", "jaipur": "JP", "kochi": "ERS", "lucknow": "LKO",
    "indore": "INDB", "bhopal": "BPL", "nagpur": "NGP", "patna": "PNBE", "bhubaneswar": "BBS", "guwahati": "GHY",
    "chandigarh": "CDG", "amritsar": "ASR", "jammu": "JAT", "varanasi": "BSB", "thiruvananthapuram": "TVC",
    "coimbatore": "CBE", "madurai": "MDU", "mangalore": "MAQ", "visakhapatnam": "VSKP", "vadodara": "BRC",
    "surat": "ST", "udaipur": "UDZ", "jodhpur": "JU", "raipur": "R", "ranchi": "RNC", "dehradun": "DDN",
    "agra": "AGC", "mysore": "MYS", "ujjain": "UJN", "gwalior": "GWL", "jabalpur": "JBP", "allahabad": "PRYJ",
    "kanpur": "CNB", "haridwar": "HW", "rishikesh": "RKSH", "nashik": "NK", "aurangabad": "AWB", "kota": "KOTA",
    "ajmer": "AII", "tirupati": "TPTY", "puducherry": "PDY", "shimla": "SML", "kolhapur": "KOP",
}


def _key(place: str) -> str:
    name = " ".join(place.lower().replace(",", " ").split())
    for suffix in (" city", " junction", " jn"):
        name = name.removesuffix(suffix)
    return _ALIASES.get(name, name)


def _redbus_slug(place: str) -> str:
    return "-".join(_key(place).split())


def _check_dates(first: date, last: date | None, today: date) -> None:
    if first < today:
        raise SearchLinkError(travel_dates.past_dates_message(first, last, today))
    if first > today.replace(year=today.year + 1):
        raise SearchLinkError("That date is more than a year away; providers do not sell that far ahead.")
    if last is not None and last < first:
        raise SearchLinkError("The return or check-out date is before the first date.")


def _same_place(origin: str, destination: str) -> None:
    if _key(origin) == _key(destination):
        raise SearchLinkError("The origin and destination are the same place.")


# ---------- builders ----------


def flight_links(
    origin: str, destination: str, depart: date, return_date: date | None, adults: int, today: date
) -> LinkSet:
    _check_dates(depart, return_date, today)
    _same_place(origin, destination)
    travellers = f"{adults} adult{'s' if adults != 1 else ''}"
    trip = f"returning {return_date.isoformat()}" if return_date else "one way"
    google = (
        "https://www.google.com/travel/flights?q="
        + quote(f"Flights from {origin} to {destination} on {depart.isoformat()} {trip} {travellers}")
    )
    links = [SearchLink("Google Flights", google, "Compares airlines and booking sites")]
    gaps = []

    from_code, to_code = AIRPORTS.get(_key(origin)), AIRPORTS.get(_key(destination))
    if from_code and to_code:
        params = {
            "from": from_code,
            "to": to_code,
            "date": depart.strftime("%d%m%Y"),
            "returnDate": return_date.strftime("%d%m%Y") if return_date else "",
            "adults": adults,
            "children": 0,
            "infants": 0,
            "class": "e",
            "source": "Search Form",
        }
        links.append(SearchLink("ixigo", "https://www.ixigo.com/search/result/flight?" + urlencode(params), f"{from_code} to {to_code}"))
    else:
        unknown = [p for p, c in ((origin, from_code), (destination, to_code)) if not c]
        gaps.append(f"No airport code known for {', '.join(unknown)}, so only Google Flights is linked.")

    return LinkSet(
        title=f"Flights: {origin} to {destination}",
        subtitle=f"{depart.strftime('%d %b %Y')}" + (f", back {return_date.strftime('%d %b %Y')}" if return_date else ", one way")
        + f" · {travellers}",
        links=links,
        gaps=gaps,
    )


def train_links(origin: str, destination: str, day: date, adults: int, today: date) -> LinkSet:
    _check_dates(day, None, today)
    _same_place(origin, destination)
    from_code, to_code = STATIONS.get(_key(origin)), STATIONS.get(_key(destination))
    links, gaps = [], []
    if from_code and to_code:
        url = f"https://www.ixigo.com/search/result/train/{from_code}/{to_code}/{day.strftime('%d%m%Y')}//1/0/0/0/ALL"
        links.append(SearchLink("ixigo Trains", url, f"{from_code} to {to_code}; books through IRCTC"))
    else:
        unknown = [p for p, c in ((origin, from_code), (destination, to_code)) if not c]
        gaps.append(f"No station code known for {', '.join(unknown)}.")
    search = f"trains from {origin} to {destination} on {day.strftime('%d %B %Y')}"
    links.append(SearchLink("Google", "https://www.google.com/search?q=" + quote(search), "Lists trains on the route"))
    links.append(SearchLink("IRCTC", "https://www.irctc.co.in/nget/train-search", "Official booking; enter the route there"))
    return LinkSet(
        title=f"Trains: {origin} to {destination}",
        subtitle=f"{day.strftime('%d %b %Y')} · {adults} traveller{'s' if adults != 1 else ''}",
        links=links,
        gaps=gaps,
    )


def bus_links(origin: str, destination: str, day: date, today: date) -> LinkSet:
    _check_dates(day, None, today)
    _same_place(origin, destination)
    path = f"{_redbus_slug(origin)}-to-{_redbus_slug(destination)}"
    params = {"fromCityName": origin.strip().title(), "toCityName": destination.strip().title(), "onward": day.strftime("%d-%b-%Y")}
    url = f"https://www.redbus.in/bus-tickets/{path}?" + urlencode(params)
    return LinkSet(
        title=f"Buses: {origin} to {destination}",
        subtitle=day.strftime("%d %b %Y"),
        links=[SearchLink("redBus", url, "Compares bus operators")],
    )


def hotel_links(
    city: str,
    area: str | None,
    check_in: date,
    check_out: date,
    adults: int,
    rooms: int,
    today: date,
    max_price_per_night: int | None = None,
) -> LinkSet:
    """Hotel searches. With a price limit, Booking.com opens filtered to it, cheapest first.

    Google Hotels does not take a price limit from its link (written into the search
    text it is ignored, and the dates are lost), so it opens unfiltered.
    """
    _check_dates(check_in, check_out, today)
    if check_out == check_in:
        raise SearchLinkError("Check-out must be at least one night after check-in.")
    where = f"{area}, {city}" if area else city
    google = "https://www.google.com/travel/search?q=" + quote(
        f"hotels in {where} from {check_in.strftime('%d %B %Y')} to {check_out.strftime('%d %B %Y')} for {adults} adults"
    )
    params: dict[str, Any] = {
        "ss": where,
        "checkin": check_in.isoformat(),
        "checkout": check_out.isoformat(),
        "group_adults": adults,
        "no_rooms": rooms,
        "group_children": 0,
    }
    if max_price_per_night:
        params["nflt"] = f"price=INR-0-{max_price_per_night}-1"
        params["order"] = "price"
    booking = "https://www.booking.com/searchresults.html?" + urlencode(params)
    nights = (check_out - check_in).days
    subtitle = (
        f"{check_in.strftime('%d %b')} to {check_out.strftime('%d %b %Y')} · {nights} night{'s' if nights != 1 else ''}"
        f" · {adults} adult{'s' if adults != 1 else ''}, {rooms} room{'s' if rooms != 1 else ''}"
    )
    if max_price_per_night:
        subtitle += f" · up to ₹{max_price_per_night:,} a night"
    return LinkSet(
        title=f"Hotels in {where}",
        subtitle=subtitle,
        links=[
            SearchLink("Google Hotels", google, "Compares prices across booking sites"),
            SearchLink(
                "Booking.com",
                booking,
                f"Filtered to ₹{max_price_per_night:,} a night or less, cheapest first" if max_price_per_night else "",
            ),
        ],
    )
