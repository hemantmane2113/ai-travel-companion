// Structured results from tools, rendered from data (never from model-written HTML).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const renderers = {};

export function renderCard(card, actions) {
  const render = renderers[card.type];
  if (!render) return null;
  const node = el("section", `card card-${card.type}`);
  render(node, card, actions);
  return node;
}
