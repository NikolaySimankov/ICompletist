// options.js - persist settings.
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
