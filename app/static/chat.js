import { renderCard } from "./cards.js";
import { renderMarkdown } from "./markdown.js";

const messagesEl = document.getElementById("messages");
const emptyEl = document.getElementById("empty");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const conversationsEl = document.getElementById("conversations");
const titleEl = document.getElementById("chat-title");
const sidebar = document.getElementById("sidebar");
const menuButton = document.getElementById("menu-button");

let conversations = [];
let activeId = null;
let busy = false;
// The traveller's position, once they share it. Kept in this page only (never in
// storage) and sent only with the message that shares it.
let lastLocation = null;
const LOCATION_MAX_AGE_MS = 10 * 60 * 1000;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  return response;
}

async function errorMessage(response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.detail === "string" ? body.detail : "The request failed. Try again.";
}

// ---------- conversations ----------

function renderConversations() {
  conversationsEl.replaceChildren(
    ...conversations.map((conversation) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = conversation.title;
      if (conversation.id === activeId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => openConversation(conversation.id));
      item.append(button);
      return item;
    })
  );
}

function showEmpty(show) {
  emptyEl.hidden = !show;
}

function clearMessages() {
  messagesEl.querySelectorAll(".message, .card, .status").forEach((node) => node.remove());
}

function startNewConversation() {
  activeId = null;
  titleEl.textContent = "New Plan";
  clearMessages();
  showEmpty(true);
  renderConversations();
  closeSidebar();
  input.focus();
}

async function openConversation(id) {
  if (busy) return;
  activeId = id;
  const conversation = conversations.find((entry) => entry.id === id);
  titleEl.textContent = conversation ? conversation.title : "Trip";
  renderConversations();
  closeSidebar();
  clearMessages();

  const response = await api(`/api/conversations/${id}/messages`);
  if (!response.ok) {
    addNotice(await errorMessage(response));
    return;
  }
  const items = await response.json();
  showEmpty(items.length === 0);
  for (const item of items) {
    if (item.role === "card") addCard(item.card);
    else addMessage(item.role, item.content);
  }
  scrollToEnd();
}

// ---------- rendering ----------

function scrollToEnd() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;
  node.append(bubble);
  messagesEl.append(node);
  return bubble;
}

function addCard(card) {
  // Booking cards fill in after a fetch, so they report when they have grown.
  const node = renderCard(card, {
    send: sendMessage,
    painted: scrollToEnd,
    shareLocation,
    currentLocation: () => lastLocation,
  });
  if (node) messagesEl.append(node);
}

function addNotice(text) {
  const node = document.createElement("div");
  node.className = "message notice";
  node.setAttribute("role", "alert");
  node.textContent = text;
  messagesEl.append(node);
  scrollToEnd();
}

function setStatus(text) {
  let node = messagesEl.querySelector(".status");
  if (!text) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.className = "status";
  }
  node.textContent = text;
  messagesEl.append(node);
  scrollToEnd();
}

// ---------- sending ----------

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  sendButton.classList.toggle("working", value);
  sendButton.setAttribute("aria-label", value ? "Working…" : "Send");
}

async function ensureConversation() {
  if (activeId !== null) return true;
  const response = await api("/api/conversations", { method: "POST" });
  if (!response.ok) {
    addNotice(await errorMessage(response));
    return false;
  }
  const conversation = await response.json();
  conversations.unshift(conversation);
  activeId = conversation.id;
  renderConversations();
  return true;
}

// What the server should know about this browser: the traveller's own timezone (so
// "today" is their date), and their position when they chose to share it.
function clientInfo(extra = {}) {
  let timezone = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timezone = null;
  }
  return { timezone, ...extra };
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 60000,
    });
  });
}

// Phrases that mean "where I am now". Recognised here so the browser can be asked at
// once, without waiting on the model; anything missed still gets a share button.
const NEAR_ME =
  /\b(near|around|close to|closest to|nearest to)\s+(me|us|here|my location)\b|\bnear ?by\b|\baround here\b/i;

// The browser's position, or null (with a notice) if it could not be had.
async function locate() {
  let position;
  try {
    position = await currentPosition();
  } catch (error) {
    const denied = error && error.code === 1;
    addNotice(
      denied
        ? "Location was not shared. You can allow it in the browser's site settings, or just name the area."
        : "Your location could not be found. Try again, or name the area instead."
    );
    return null;
  }
  lastLocation = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_m: position.coords.accuracy,
  };
  setTimeout(() => {
    lastLocation = null;
  }, LOCATION_MAX_AGE_MS);
  return lastLocation;
}

// Asked for by a "Share my location" card. Returns whether it was shared.
async function shareLocation() {
  if (busy) return false;
  const location = await locate();
  if (!location) return false;
  await sendMessage("Here is my location.", { location });
  return true;
}

async function sendMessage(text, extra = {}) {
  if (busy || !text.trim()) return;
  if (!extra.location && NEAR_ME.test(text) && "geolocation" in navigator) {
    // The browser shows its own permission prompt the first time.
    busy = true;
    setStatus("Getting your location…");
    const location = await locate();
    setStatus("");
    busy = false;
    if (location) extra = { ...extra, location };
  }
  setBusy(true);
  showEmpty(false);
  addMessage("user", text);
  setStatus("Thinking…");

  let bubble = null;
  let buffer = "";

  const handle = (event, data) => {
    if (event === "text") {
      setStatus("");
      if (!bubble) bubble = addMessage("assistant", "");
      buffer += data.delta;
      bubble.innerHTML = renderMarkdown(buffer);
      scrollToEnd();
    } else if (event === "status") {
      // A tool call ends the current text block; later text starts a new bubble.
      bubble = null;
      buffer = "";
      setStatus(data.text);
    } else if (event === "card") {
      addCard(data);
      scrollToEnd();
    } else if (event === "title") {
      const conversation = conversations.find((entry) => entry.id === data.id);
      if (conversation) conversation.title = data.title;
      titleEl.textContent = data.title;
      renderConversations();
    } else if (event === "error") {
      setStatus("");
      addNotice(data.message);
    }
  };

  try {
    if (!(await ensureConversation())) return;
    const response = await api(`/api/conversations/${activeId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message: text, client: clientInfo(extra) }),
    });
    if (!response.ok) {
      addNotice(await errorMessage(response));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop();
      for (const frame of frames) {
        const event = frame.match(/^event: (.*)$/m);
        const data = frame.match(/^data: (.*)$/m);
        if (event && data) handle(event[1], JSON.parse(data[1]));
      }
    }
  } catch (error) {
    if (error.message !== "Signed out") addNotice("The connection dropped. Check your network and try again.");
  } finally {
    setStatus("");
    setBusy(false);
    input.focus();
  }
}

// ---------- wiring ----------

function autosize() {
  input.style.height = "auto";
  // scrollHeight excludes the 1px borders that the border-box height includes.
  input.style.height = `${Math.min(input.scrollHeight + 2, 180)}px`;
}

const composerHint = document.getElementById("composer-hint");
const DEFAULT_HINT = composerHint.textContent;

function resetHint() {
  composerHint.textContent = DEFAULT_HINT;
  composerHint.classList.remove("hint-alert");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  menuButton.setAttribute("aria-expanded", "false");
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value;
  if (busy || !text.trim()) return;
  if (hasBlank(text)) {
    composerHint.textContent = "Fill in the parts in [brackets] first, or delete them. Tab jumps to the next one.";
    composerHint.classList.add("hint-alert");
    selectBlank();
    return;
  }
  resetHint();
  input.value = "";
  autosize();
  sendMessage(text);
});

input.addEventListener("input", () => {
  autosize();
  if (!hasBlank(input.value)) resetHint();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

document.getElementById("new-chat").addEventListener("click", () => {
  if (!busy) startNewConversation();
});

menuButton.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  menuButton.setAttribute("aria-expanded", String(open));
});

// Links to other sites must never replace this page: an embedded browser may ignore
// target="_blank" or refuse the new tab, and then the conversation is lost. They are
// opened here instead, and if no tab can be opened the link is copied for the traveller.
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin === window.location.origin) return;
  event.preventDefault();
  const opened = window.open(url.href, "_blank");
  if (opened) {
    opened.opener = null;
    return;
  }
  const copy = navigator.clipboard ? navigator.clipboard.writeText(url.href) : Promise.reject();
  copy
    .then(() => addNotice(`Your browser blocked the new tab, so the link was copied. Paste it into a new tab: ${url.host}`))
    .catch(() => addNotice(`Your browser blocked the new tab. Open this link in a new tab: ${url.href}`));
});

// ---------- start-screen templates ----------

// A tile puts a question with [blanks] in the message box for the traveller to finish;
// it never sends someone else's example on their behalf.
const BLANK = /\[[^\]\n]+\]/g;
const hasBlank = (text) => /\[[^\]\n]+\]/.test(text);

// Selects the first blank at or after `from` (wrapping round). Returns whether one was found.
function selectBlank(from = 0) {
  const blanks = [...input.value.matchAll(BLANK)];
  if (!blanks.length) return false;
  const next = blanks.find((match) => match.index >= from) || blanks[0];
  input.focus();
  input.setSelectionRange(next.index, next.index + next[0].length);
  return true;
}

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.template;
    autosize();
    if (!selectBlank()) input.focus();
  });
});

input.addEventListener("keydown", (event) => {
  // Tab moves between blanks while any are left; otherwise it moves focus as usual.
  if (event.key !== "Tab" || event.shiftKey || !hasBlank(input.value)) return;
  event.preventDefault();
  selectBlank(input.selectionEnd);
});

(async function init() {
  const response = await api("/api/conversations");
  if (response.ok) conversations = await response.json();
  renderConversations();
  input.focus();
})();
