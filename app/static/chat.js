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
  titleEl.textContent = "New trip";
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
  const node = renderCard(card, { send: sendMessage });
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
  sendButton.textContent = value ? "Working…" : "Send";
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

async function sendMessage(text) {
  if (busy || !text.trim()) return;
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
      body: JSON.stringify({ message: text }),
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
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function closeSidebar() {
  sidebar.classList.remove("open");
  menuButton.setAttribute("aria-expanded", "false");
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value;
  if (busy || !text.trim()) return;
  input.value = "";
  autosize();
  sendMessage(text);
});

input.addEventListener("input", autosize);
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

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.textContent));
});

(async function init() {
  const response = await api("/api/conversations");
  if (response.ok) conversations = await response.json();
  renderConversations();
  input.focus();
})();
