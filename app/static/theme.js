// Light, dark or system theme. The choice is a per-browser convenience kept in
// localStorage; base.html applies it before the page draws, so there is no flash.
// (With many users it could move to their account settings; nothing else changes.)

const KEY = "theme";
const CHOICES = ["system", "light", "dark"];

function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return CHOICES.includes(value) ? value : "system";
  } catch {
    return "system";
  }
}

function apply(choice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  });
}

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => apply(button.dataset.themeChoice));
});
apply(stored());
