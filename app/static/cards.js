// Structured results from tools, rendered from data (never from model-written HTML).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function money(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

function day(iso, options = { weekday: "short", day: "numeric", month: "short" }) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, options);
}

function dateRange(start, end) {
  return `${day(start, { day: "numeric", month: "short" })} – ${day(end, { day: "numeric", month: "short", year: "numeric" })}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function demoBadge() {
  return el("span", "badge badge-demo", "Demo data");
}

async function request(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function detailText(body, fallback) {
  if (typeof body.detail === "string") return body.detail;
  if (body.detail && typeof body.detail.message === "string") return body.detail.message;
  return fallback;
}

// ---------- news ----------

const NEWS_CAVEAT =
  "Recent headlines that mention this place and a possible disruption. They are unfiltered and unverified; follow the links to judge them.";

function newsList(items) {
  const wrap = el("div", "news");
  wrap.append(el("p", "card-sub", NEWS_CAVEAT));
  const list = el("ul", "news-list");
  for (const item of items) {
    const row = el("li");
    if (item.url && item.url.startsWith("https://")) {
      const link = el("a", null, item.headline);
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(link);
    } else {
      row.append(el("span", null, item.headline));
    }
    row.append(el("span", "news-meta", ` ${item.source} · ${day(item.date, { day: "numeric", month: "short" })}`));
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

function renderNews(node, card) {
  node.append(el("h2", null, `In the news: ${card.place}`));
  node.append(newsList(card.items));
}

// ---------- budget ----------

const BUDGET_PARTS = {
  stay: "Stay",
  getting_there_and_back: "Getting there and back",
  food: "Food",
  local_transport: "Local transport",
  sightseeing: "Sightseeing",
};

function budgetBox(budget) {
  const box = el("div", `budget-box ${budget.fits ? "budget-fits" : "budget-over"}`);
  const head = el("p", "budget-head");
  head.append(el("strong", null, `Planned at ${budget.level} level`));
  let verdict = `Estimated ${money(budget.estimated_total, "INR")}`;
  if (budget.budget) {
    verdict += budget.fits
      ? ` of your ${money(budget.budget, "INR")} budget`
      : `, about ${money(budget.over_by, "INR")} over your ${money(budget.budget, "INR")} budget`;
  }
  head.append(el("span", null, ` · ${verdict}`));
  box.append(head);

  const list = el("ul", "budget-parts");
  for (const [key, amount] of Object.entries(budget.breakdown)) {
    const row = el("li");
    row.append(el("span", null, BUDGET_PARTS[key] || key), el("span", "budget-amount", money(amount, "INR")));
    list.append(row);
  }
  box.append(list);
  box.append(
    el(
      "p",
      "card-sub",
      `${plural(budget.people, "traveller")}, ${plural(budget.nights, "night")}. Getting there: ${budget.getting_there}. ` +
        "Rough estimates from typical prices, not quotes.",
    ),
  );
  return box;
}

// ---------- itinerary ----------

function renderItinerary(node, card) {
  node.append(el("h2", null, `${card.destination}: ${plural(card.days.length, "day")}`));
  const children = card.children === 1 ? "1 child" : `${card.children} children`;
  const travellers = plural(card.adults, "adult") + (card.children ? `, ${children}` : "");
  node.append(el("p", "card-sub", `${dateRange(card.start_date, card.end_date)} · ${travellers}`));
  node.append(el("p", "itinerary-summary", card.summary));
  if (card.budget) node.append(budgetBox(card.budget));

  const conditions = card.conditions || { days: {}, alerts: [], problems: [] };
  if (conditions.alerts.length) {
    const alerts = el("div", "alerts");
    alerts.setAttribute("role", "note");
    alerts.append(el("strong", null, "Before you go"));
    const list = el("ul");
    conditions.alerts.forEach((alert) => list.append(el("li", null, alert)));
    alerts.append(list);
    node.append(alerts);
  }

  for (const entry of card.days) {
    const section = el("div", "itinerary-day");
    const heading = el("h3");
    heading.append(el("span", "day-date", day(entry.date)), document.createTextNode(entry.theme));
    section.append(heading);

    const today = conditions.days[entry.date] || {};
    if (today.weather || today.events || today.air) {
      const line = el("p", "day-conditions");
      if (today.weather) {
        const w = today.weather;
        let text = `${w.summary}, ${w.temp_min_c}–${w.temp_max_c}°C`;
        if (w.precipitation_probability !== null && w.precipitation_probability !== undefined) {
          text += `, rain chance ${w.precipitation_probability}%`;
        } else if (w.precipitation_mm >= 1) {
          text += `, about ${Math.round(w.precipitation_mm)} mm of rain`;
        }
        line.append(el("span", "weather", text));
      }
      if (today.air) {
        const band = today.air.peak_aqi > 150 ? "bad" : today.air.peak_aqi > 100 ? "poor" : "ok";
        const chip = el("span", `badge badge-air air-${band}`, `AQI ${today.air.peak_aqi} · ${today.air.category}`);
        chip.title = `Peak US AQI for the day; PM2.5 about ${Math.round(today.air.pm25)} µg/m³`;
        line.append(chip);
      }
      for (const event of today.events || []) {
        line.append(el("span", `badge ${event.kind === "public holiday" ? "badge-holiday" : "badge-status"}`, event.name));
      }
      section.append(line);
    }

    const list = el("ol", "stops");
    for (const item of entry.items) {
      const stop = el("li", "stop");
      stop.append(el("span", "stop-time", item.time_of_day));
      const body = el("div", "stop-body");
      body.append(el("strong", null, item.place), el("p", null, item.activity));
      if (item.why_visit) {
        const why = el("p", "stop-why", item.why_visit);
        if (item.source_url && item.source_url.startsWith("https://")) {
          const link = el("a", null, "Source");
          link.href = item.source_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          why.append(" ", link);
        }
        body.append(why);
      }
      stop.append(body);
      list.append(stop);
    }
    section.append(list);

    const route = entry.route;
    if (route && route.legs.length) {
      const line = el("p", "day-route");
      line.append(el("span", null, `Travel between stops: ${route.total_km} km, about ${route.total_minutes} min by road`));
      if (route.maps_url) {
        const link = el("a", null, "Open route in Maps");
        link.href = route.maps_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        line.append(" · ", link);
      }
      section.append(line);
    }
    if (route && route.unlocated.length) {
      section.append(el("p", "day-route", `Not found on the map, so not in the distance: ${route.unlocated.join(", ")}`));
    }
    node.append(section);
  }

  if (card.tips && card.tips.length) {
    node.append(el("h3", "tips-heading", "Good to know"));
    const tips = el("ul", "tips");
    card.tips.forEach((tip) => tips.append(el("li", null, tip)));
    node.append(tips);
  }

  if (conditions.news && conditions.news.length) {
    node.append(el("h3", "tips-heading", "In the news"));
    node.append(newsList(conditions.news));
  }

  // Say where the numbers came from and what was not checked.
  const notes = [];
  if (conditions.weather_kind === "forecast") notes.push(`Weather: ${conditions.weather_source}.`);
  if (conditions.weather_kind === "typical") {
    notes.push(`Weather is the usual for these dates, not a forecast (${conditions.weather_source}).`);
  }
  if (conditions.air_kind === "forecast") notes.push(`Air quality: ${conditions.air_source}, US AQI scale, modelled for the city.`);
  if (conditions.air_kind === "typical") {
    notes.push(`Air quality is the usual for these dates, not a forecast (${conditions.air_source}, US AQI scale).`);
  }
  if (conditions.events_checked) notes.push(`Events checked: ${conditions.events_coverage}.`);
  (conditions.problems || []).forEach((problem) => notes.push(problem));
  if (card.route_source) notes.push(`Distances: ${card.route_source}.`);
  if (notes.length) node.append(el("p", "card-sources", notes.join(" ")));
}

// ---------- hotel comparison ----------

function renderHotelComparison(node, card, actions) {
  const header = el("div", "card-header");
  header.append(el("h2", null, `Hotels in ${card.area ? `${card.area}, ` : ""}${card.destination}`));
  if (card.is_demo) header.append(demoBadge());
  node.append(header);
  node.append(
    el(
      "p",
      "card-sub",
      `${dateRange(card.check_in, card.check_out)} · ${plural(card.nights, "night")} · ${plural(card.rooms, "room")} · ${plural(card.adults, "adult")}. Totals include taxes and fees.`
    )
  );
  if (card.is_demo) {
    node.append(el("p", "demo-note", "These providers, hotels and prices are simulated for demonstration. No real reservation or payment is made."));
  }
  if (card.failed_providers.length) {
    node.append(el("p", "warn-note", `No response from: ${card.failed_providers.join(", ")}. Their prices are missing from this comparison.`));
  }

  for (const hotel of card.hotels) {
    const block = el("div", "hotel");
    const title = el("div", "hotel-title");
    title.append(el("strong", null, hotel.hotel_name));
    title.append(el("span", "hotel-meta", `${"★".repeat(hotel.star_rating)} · ${hotel.guest_rating}/10 (${hotel.review_count.toLocaleString()} reviews) · ${hotel.area}`));
    block.append(title);
    block.append(el("p", "hotel-amenities", hotel.amenities.join(" · ")));

    const offers = el("ul", "offers");
    for (const offer of hotel.offers) {
      const row = el("li", "offer");
      const info = el("div", "offer-info");
      const provider = el("div", "offer-provider", offer.provider_name);
      if (offer.cheapest) provider.append(el("span", "badge badge-best", "Lowest price"));
      info.append(provider);
      info.append(el("div", "offer-terms", `${offer.room_type}${offer.breakfast_included ? " · Breakfast included" : ""} · ${offer.cancellation_policy}`));
      const price = el("div", "offer-price");
      price.append(el("strong", null, money(offer.total_price, offer.currency)));
      price.append(el("span", null, `${money(offer.price_per_night, offer.currency)} / night + ${money(offer.taxes_and_fees, offer.currency)} taxes`));
      const book = el("button", "button-secondary", "Book");
      book.type = "button";
      book.setAttribute("aria-label", `Book ${hotel.hotel_name} with ${offer.provider_name}`);
      book.addEventListener("click", () =>
        actions.send(`I want to book ${hotel.hotel_name} with ${offer.provider_name} (offer ${offer.offer_id}).`)
      );
      row.append(info, price, book);
      offers.append(row);
    }
    block.append(offers);
    node.append(block);
  }
}

// ---------- booking ----------

const STATUS_LABELS = {
  PENDING_CONFIRMATION: "Not booked yet",
  CONFIRMED: "Confirmed",
  FAILED: "Not booked",
  EXPIRED: "Quote expired",
  CANCELLED: "Cancelled",
};

function bookingDetails(booking) {
  const list = el("dl", "details");
  const add = (term, value) => {
    list.append(el("dt", null, term), el("dd", null, value));
  };
  add("Hotel", `${booking.hotel_name}, ${booking.area}`);
  add("Booked through", booking.provider_name);
  add("Dates", `${dateRange(booking.check_in, booking.check_out)} (${plural(booking.nights, "night")})`);
  add("Room", `${plural(booking.rooms, "room")} · ${booking.room_type}${booking.breakfast_included ? " · Breakfast included" : ""}`);
  add("Lead guest", booking.guest_name);
  add("Total", `${money(booking.total_price, booking.currency)} including ${money(booking.taxes_and_fees, booking.currency)} taxes and fees`);
  add("Cancellation", booking.cancellation_policy);
  if (booking.provider_reference) add("Reference", booking.provider_reference);
  return list;
}

function bookingHeader(title, booking) {
  const header = el("div", "card-header");
  header.append(el("h2", null, title));
  header.append(el("span", `badge badge-status status-${booking.status.toLowerCase()}`, STATUS_LABELS[booking.status] || booking.status));
  if (booking.is_demo) header.append(demoBadge());
  return header;
}

async function loadBooking(node, id) {
  node.replaceChildren(el("p", "card-sub", "Loading booking…"));
  const { ok, body } = await request(`/api/bookings/${id}`);
  if (!ok) {
    node.replaceChildren(el("p", "warn-note", detailText(body, "Could not load this booking.")));
    return null;
  }
  return body;
}

function paintBookingConfirm(node, booking, error) {
  node.replaceChildren(bookingHeader("Confirm your booking", booking), bookingDetails(booking));
  if (error) node.append(el("p", "warn-note", error));

  if (booking.status === "PENDING_CONFIRMATION") {
    if (booking.is_demo) {
      node.append(el("p", "demo-note", "Demo provider: confirming creates a simulated booking. No real reservation or payment is made."));
    }
    const button = el("button", "button-primary", `Confirm booking · ${money(booking.total_price, booking.currency)}`);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Booking…";
      const { ok, body } = await request(`/api/bookings/${booking.id}/confirm`, { method: "POST" });
      if (ok) {
        paintBookingConfirm(node, body);
      } else {
        const fresh = (await request(`/api/bookings/${booking.id}`)).body;
        paintBookingConfirm(node, fresh.id ? fresh : booking, detailText(body, "The booking could not be completed."));
      }
    });
    node.append(button);
  } else if (booking.status === "CONFIRMED") {
    node.append(el("p", "ok-note", `Booked. ${booking.provider_name} reference ${booking.provider_reference}.`));
  } else if (booking.status === "FAILED") {
    node.append(el("p", "warn-note", `This was not booked. ${booking.failure_reason || ""}`));
  } else if (booking.status === "EXPIRED") {
    node.append(el("p", "warn-note", "This quote expired before it was confirmed. Ask for the hotel again to get a current price."));
  } else if (booking.status === "CANCELLED") {
    node.append(el("p", "card-sub", `Cancelled. Refund ${money(booking.refund_amount, booking.currency)}.`));
  }
}

function renderBookingConfirm(node, card, actions) {
  loadBooking(node, card.booking_id).then((booking) => {
    if (!booking) return;
    paintBookingConfirm(node, booking);
    actions.painted();
  });
}

function paintCancelConfirm(node, booking, quote, error) {
  node.replaceChildren(bookingHeader("Cancel this booking?", booking), bookingDetails(booking));
  if (error) node.append(el("p", "warn-note", error));

  if (booking.status === "CONFIRMED") {
    const terms = el("dl", "details refund");
    terms.append(el("dt", null, "Refund"), el("dd", null, money(quote.refund_amount, quote.currency)));
    terms.append(el("dt", null, "Cancellation fee"), el("dd", null, money(quote.fee, quote.currency)));
    node.append(terms);
    const button = el("button", "button-danger", `Cancel booking · refund ${money(quote.refund_amount, quote.currency)}`);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Cancelling…";
      const { ok, status, body } = await request(`/api/bookings/${booking.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ expected_refund: quote.refund_amount }),
      });
      if (ok) {
        paintCancelConfirm(node, body, quote);
      } else if (status === 409 && body.detail && body.detail.refund_amount !== undefined) {
        // The terms moved since the card was drawn: show the new ones and ask again.
        paintCancelConfirm(node, booking, body.detail, "The refund has changed. Check the new amount before confirming.");
      } else {
        paintCancelConfirm(node, booking, quote, detailText(body, "The cancellation could not be completed."));
      }
    });
    node.append(button);
  } else if (booking.status === "CANCELLED") {
    node.append(
      el("p", "ok-note", `Cancelled. Refund ${money(booking.refund_amount, booking.currency)}, fee ${money(booking.cancellation_fee, booking.currency)}.`)
    );
  } else {
    node.append(el("p", "card-sub", "This booking is not active, so there is nothing to cancel."));
  }
}

function renderCancelConfirm(node, card, actions) {
  const quote = { refund_amount: card.refund_amount, fee: card.fee, currency: card.currency };
  loadBooking(node, card.booking_id).then((booking) => {
    if (!booking) return;
    paintCancelConfirm(node, booking, quote);
    actions.painted();
  });
}

// ---------- restaurants ----------

function externalLink(text, url) {
  const link = el("a", null, text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// ---------- maps ----------

// Leaflet is loaded the first time a map is drawn, not with every page.
let leafletLoading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/static/vendor/leaflet/leaflet.css";
      document.head.append(css);
      const script = document.createElement("script");
      script.src = "/static/vendor/leaflet/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletLoading = null;
        reject(new Error("map library failed to load"));
      };
      document.head.append(script);
    });
  }
  return leafletLoading;
}

// Pins on a map: places from the card, plus the traveller if their position is known
// on this page. That position is never part of the card, so a reloaded chat shows the
// places only.
function placesMap(places, you, painted) {
  const box = el("div", "map");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", `Map of ${plural(places.length, "place")}${you ? " and your position" : ""}`);
  const { mapTiles, mapAttribution } = document.body.dataset;
  loadLeaflet()
    .then((L) => {
      const map = L.map(box, { scrollWheelZoom: false });
      L.tileLayer(mapTiles, { attribution: mapAttribution, maxZoom: 19 }).addTo(map);
      const points = [];
      places.forEach((place, index) => {
        const point = [place.latitude, place.longitude];
        points.push(point);
        const label = el("strong", null, `${index + 1}. ${place.name}`);
        L.circleMarker(point, { radius: 7, weight: 2, color: "#b45309", fillOpacity: 0.85 }).addTo(map).bindPopup(label);
      });
      if (you) {
        const point = [you.latitude, you.longitude];
        points.push(point);
        L.circleMarker(point, { radius: 8, weight: 3, color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: 1 })
          .addTo(map)
          .bindPopup(el("strong", null, "You are here"));
      }
      map.fitBounds(points, { padding: [24, 24], maxZoom: 16 });
      if (painted) painted();
    })
    .catch(() => box.replaceWith(el("p", "card-sub", "The map could not be loaded.")));
  return box;
}

function distanceText(km) {
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m away` : `${km.toFixed(1)} km away`;
}

// ---------- restaurants ----------

function renderLocationRequest(node, card, actions) {
  node.append(el("h2", null, "Share your location?"));
  node.append(
    el(
      "p",
      "card-sub",
      `To ${card.purpose}, your browser can share where you are, for this one search. It is not saved, and the assistant only sees the area name.`
    )
  );
  const button = el("button", null, "Share my location");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Getting your location…";
    const shared = await actions.shareLocation();
    button.textContent = shared ? "Location shared" : "Share my location";
    button.disabled = shared;
  });
  node.append(button);
}

function renderRestaurants(node, card, actions) {
  const where = !card.near_traveller ? `near ${card.area}` : card.area === "your location" ? "near you" : `near you (${card.area})`;
  node.append(el("h2", null, card.dish ? `${card.dish}: places to eat ${where}` : `Places to eat ${where}`));
  const matched = card.keywords.length ? ` Matched on: ${card.keywords.join(", ")}.` : "";
  node.append(
    el(
      "p",
      "card-sub",
      `${plural(card.restaurants.length, "match")} among ${card.nearby_count} places mapped within ${card.radius_km} km.${matched}`
    )
  );
  node.append(
    el(
      "p",
      "demo-note",
      "From OpenStreetMap, which has no ratings, reviews or menus. Closest match first, then nearest; this is not a ranking by quality, and a cuisine match does not confirm a dish is served."
    )
  );
  const mapped = card.restaurants.filter((place) => Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
  if (mapped.length) node.append(placesMap(mapped, card.near_traveller ? actions.currentLocation() : null, actions.painted));

  card.restaurants.forEach((place, index) => {
    const block = el("div", "hotel");
    const title = el("div", "hotel-title");
    title.append(el("strong", null, `${index + 1}. ${place.name}`));
    const meta = [distanceText(place.distance_km) + (card.near_traveller ? " from you" : "")];
    if (place.cuisines.length) meta.push(place.cuisines.slice(0, 5).join(", "));
    if (place.vegetarian_only) meta.push("vegetarian only");
    title.append(el("span", "hotel-meta", meta.join(" · ")));
    block.append(title);

    const row = el("div", "offer");
    const info = el("div", "offer-info");
    if (place.matched_on.length) info.append(el("div", "offer-provider", `Match: ${place.matched_on.join(", ")}`));
    const details = [];
    if (place.address) details.push(place.address);
    details.push(place.opening_hours ? `Hours: ${place.opening_hours}` : "Opening hours not published");
    if (place.phone) details.push(place.phone);
    const terms = el("div", "offer-terms", details.join(" · "));
    if (place.source_url && place.source_url.startsWith("https://")) terms.append(" · ", externalLink("Map", place.source_url));
    if (place.website && /^https?:\/\//.test(place.website)) terms.append(" · ", externalLink("Website", place.website));
    info.append(terms);
    const book = el("button", "button-secondary", "Book a table");
    book.type = "button";
    book.setAttribute("aria-label", `Book a table at ${place.name}`);
    book.addEventListener("click", () => actions.send(`I want to book a table at ${place.name} (restaurant ${place.restaurant_id}).`));
    row.append(info, el("div"), book);
    block.append(row);
    node.append(block);
  });
}

// ---------- table reservations ----------

const TABLE_STATUS_LABELS = { ...STATUS_LABELS, PENDING_CONFIRMATION: "Not reserved yet", FAILED: "Not reserved", EXPIRED: "Request expired" };
const DEMO_TABLE_NOTE =
  "Demo reservation service: the restaurant is not contacted and no table is held. Phone the restaurant to be sure of a table.";

function tableDetails(booking) {
  const list = el("dl", "details");
  const add = (term, value) => list.append(el("dt", null, term), el("dd", null, value));
  add("Restaurant", booking.address ? `${booking.restaurant_name}, ${booking.address}` : booking.restaurant_name);
  add("When", `${day(booking.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} at ${booking.time}`);
  add("Party", plural(booking.party_size, "person").replace("persons", "people"));
  add("Name", booking.guest_name);
  add("Opening hours", booking.opening_hours || "Not published; the time could not be checked");
  if (booking.phone) add("Phone", booking.phone);
  add("Reserved through", booking.provider_name);
  if (booking.provider_reference) add("Reference", booking.provider_reference);
  return list;
}

function tableHeader(title, booking) {
  const header = el("div", "card-header");
  header.append(el("h2", null, title));
  header.append(el("span", `badge badge-status status-${booking.status.toLowerCase()}`, TABLE_STATUS_LABELS[booking.status] || booking.status));
  if (booking.is_demo) header.append(demoBadge());
  return header;
}

async function loadTableBooking(node, id) {
  node.replaceChildren(el("p", "card-sub", "Loading reservation…"));
  const { ok, body } = await request(`/api/table-bookings/${id}`);
  if (!ok) {
    node.replaceChildren(el("p", "warn-note", detailText(body, "Could not load this reservation.")));
    return null;
  }
  return body;
}

// One card for both directions: `cancelling` decides which button a live reservation gets.
function paintTable(node, booking, cancelling, error) {
  node.replaceChildren(tableHeader(cancelling ? "Cancel this reservation?" : "Confirm your table", booking), tableDetails(booking));
  if (error) node.append(el("p", "warn-note", error));
  if (booking.is_demo) node.append(el("p", "demo-note", DEMO_TABLE_NOTE));

  const act = (label, className, busy, path) => {
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = busy;
      const { ok, body } = await request(path, { method: "POST" });
      if (ok) {
        paintTable(node, body, cancelling);
      } else {
        const fresh = (await request(`/api/table-bookings/${booking.id}`)).body;
        paintTable(node, fresh.id ? fresh : booking, cancelling, detailText(body, "That could not be completed."));
      }
    });
    node.append(button);
  };

  if (booking.status === "PENDING_CONFIRMATION" && !cancelling) {
    act("Confirm reservation", "button-primary", "Reserving…", `/api/table-bookings/${booking.id}/confirm`);
  } else if (booking.status === "CONFIRMED" && cancelling) {
    act("Cancel reservation", "button-danger", "Cancelling…", `/api/table-bookings/${booking.id}/cancel`);
  } else if (booking.status === "CONFIRMED") {
    node.append(el("p", "ok-note", `Reserved. Reference ${booking.provider_reference}.`));
  } else if (booking.status === "CANCELLED") {
    node.append(el("p", "ok-note", "This reservation is cancelled."));
  } else if (booking.status === "FAILED") {
    node.append(el("p", "warn-note", `This was not reserved. ${booking.failure_reason || ""}`));
  } else if (booking.status === "EXPIRED") {
    node.append(el("p", "warn-note", "This request expired before it was confirmed. Ask for the table again."));
  } else {
    node.append(el("p", "card-sub", "This reservation is not active."));
  }
}

function renderTable(cancelling) {
  return (node, card, actions) => {
    loadTableBooking(node, card.booking_id).then((booking) => {
      if (!booking) return;
      paintTable(node, booking, cancelling);
      actions.painted();
    });
  };
}

// ---------- search links ----------

const LINK_NOTES = {
  hotel: "Opens each site's own search, already filled in. Prices, availability and booking are on those sites; the companion does not see them.",
  default: "Opens each site's own search, already filled in. Times, fares and booking are on those sites; the companion does not see them.",
};

function renderSearchLinks(node, card) {
  node.append(el("h2", null, card.title));
  node.append(el("p", "card-sub", card.subtitle));
  const list = el("div", "link-buttons");
  for (const link of card.links) {
    if (!link.url.startsWith("https://")) continue;
    const anchor = externalLink(`${link.provider} ↗`, link.url);
    anchor.className = "button-secondary link-button-wide";
    const item = el("div", "link-item");
    // For browsers that will not open a new tab (some embedded ones load links in place):
    // the link can be copied and opened elsewhere instead.
    const copy = el("button", "link-button", "Copy link");
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy the ${link.provider} link`);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link.url);
        copy.textContent = "Copied";
      } catch {
        window.prompt("Copy this link:", link.url);
      }
    });
    item.append(anchor, copy);
    if (link.note) item.append(el("span", "hotel-meta", link.note));
    list.append(item);
  }
  node.append(list);
  for (const gap of card.gaps || []) node.append(el("p", "warn-note", gap));
  node.append(el("p", "card-sources", LINK_NOTES[card.kind] || LINK_NOTES.default));
}

const renderers = {
  search_links: renderSearchLinks,
  restaurants: renderRestaurants,
  location_request: renderLocationRequest,
  table_confirm: renderTable(false),
  table_cancel_confirm: renderTable(true),
  news: renderNews,
  itinerary: renderItinerary,
  hotel_comparison: renderHotelComparison,
  booking_confirm: renderBookingConfirm,
  cancel_confirm: renderCancelConfirm,
};

export function renderCard(card, actions) {
  const render = renderers[card.type];
  if (!render) return null;
  const node = el("section", `card card-${card.type}`);
  render(node, card, actions);
  return node;
}
