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

// ---- Backup: export / import settings ----

function showBackupStatus(msg, isError) {
  const el = document.getElementById("backup-status");
  el.textContent = msg;
  el.hidden = false;
  el.style.color = isError ? "var(--fail)" : "var(--oa)";
  setTimeout(() => { el.hidden = true; }, 4000);
}

document.getElementById("export-settings-btn").addEventListener("click", () => {
  chrome.storage.sync.get(fields.reduce((o, k) => ((o[k] = ""), o), {}), (data) => {
    const payload = {
      app: "ICompletist",
      type: "settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {},
    };
    for (const k of fields) payload.settings[k] = data[k] || "";
    const json = JSON.stringify(payload, null, 2);
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download({
      url: dataUrl,
      filename: `icompletist-settings-${stamp}.json`,
      saveAs: true,
    });
  });
});

const importInput = document.getElementById("import-settings-input");
document.getElementById("import-settings-btn").addEventListener("click", () => importInput.click());

importInput.addEventListener("change", () => {
  const file = importInput.files && importInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      // Accept either the wrapped export ({settings:{...}}) or a bare object.
      const incoming = parsed && typeof parsed.settings === "object" && parsed.settings
        ? parsed.settings
        : parsed;
      if (!incoming || typeof incoming !== "object") throw new Error("not a settings file");

      const payload = {};
      for (const k of fields) {
        if (typeof incoming[k] === "string") payload[k] = incoming[k];
      }
      if (!Object.keys(payload).length) throw new Error("no recognized settings found");

      chrome.storage.sync.set(payload, () => {
        for (const k of fields) {
          if (k in payload) document.getElementById(k).value = payload[k];
        }
        showBackupStatus(`Imported ${Object.keys(payload).length} setting(s) ✓`);
      });
    } catch (e) {
      showBackupStatus(`Import failed: ${e.message}`, true);
    }
    importInput.value = ""; // allow re-importing the same file
  };
  reader.onerror = () => showBackupStatus("Could not read the file", true);
  reader.readAsText(file);
});
