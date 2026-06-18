// options.js - persist settings.

// Apply the saved theme so the settings page matches the popup. There's no
// toggle here; "auto" follows the OS via the media query in popup.css.
chrome.storage.local.get({ theme: "auto" }, ({ theme }) => {
  if (theme === "dark" || theme === "light") {
    document.documentElement.setAttribute("data-theme", theme);
  }
});

const fields = ["email", "ncbiApiKey", "s2ApiKey", "coreApiKey", "downloadsPath", "resolverBase", "elsevierKey", "elsevierInstToken", "springerKey", "wileyToken", "ieeeKey"];

chrome.storage.sync.get(fields.reduce((o, k) => ((o[k] = ""), o), {}), (data) => {
  for (const k of fields) document.getElementById(k).value = data[k] || "";
});

document.getElementById("save-btn").addEventListener("click", () => {
  const payload = {};
  for (const k of fields) payload[k] = document.getElementById(k).value.trim();
  chrome.storage.sync.set(payload, () => {
    const ind = document.getElementById("saved-indicator");
    ind.hidden = false;
    setTimeout(() => (ind.hidden = true), 1500);
  });
});
