// Options Page Controller

const inputToken = document.getElementById("inputToken") as HTMLInputElement;
const btnAutoDetect = document.getElementById("btnAutoDetect") as HTMLButtonElement;
const btnSave = document.getElementById("btnSave") as HTMLButtonElement;
const btnTest = document.getElementById("btnTest") as HTMLButtonElement;
const btnCheckUpdate = document.getElementById("btnCheckUpdate") as HTMLButtonElement;
const btnReloadExt = document.getElementById("btnReloadExt") as HTMLButtonElement;
const statusBadge = document.getElementById("statusBadge") as HTMLDivElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const testFeedback = document.getElementById("testFeedback") as HTMLDivElement;
const saveFeedback = document.getElementById("saveFeedback") as HTMLDivElement;
const updateFeedback = document.getElementById("updateFeedback") as HTMLDivElement;
const toggleInterception = document.getElementById("toggleInterception") as HTMLInputElement;

// Interception filters & notifications elements
const inputMinSize = document.getElementById("inputMinSize") as HTMLInputElement;
const inputExcludedDomains = document.getElementById("inputExcludedDomains") as HTMLTextAreaElement;
const inputFileExtensions = document.getElementById("inputFileExtensions") as HTMLInputElement;
const btnSaveFilters = document.getElementById("btnSaveFilters") as HTMLButtonElement;
const filterFeedback = document.getElementById("filterFeedback") as HTMLDivElement;

const toggleAutoReconnect = document.getElementById("toggleAutoReconnect") as HTMLInputElement;
const toggleNotifyComplete = document.getElementById("toggleNotifyComplete") as HTMLInputElement;
const toggleNotifyFail = document.getElementById("toggleNotifyFail") as HTMLInputElement;
const toggleYoutubePill = document.getElementById("toggleYoutubePill") as HTMLInputElement;

// Load stored values
async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "edm_ws_token",
    "edm_interception_enabled",
    "edm_min_size",
    "edm_excluded_domains",
    "edm_file_extensions",
    "edm_auto_reconnect",
    "edm_notify_complete",
    "edm_notify_fail",
    "edm_youtube_pill_enabled",
  ]);
  if (stored.edm_ws_token && stored.edm_ws_token.length >= 32 && !stored.edm_ws_token.startsWith("ed0000000000")) {
    inputToken.value = stored.edm_ws_token;
  } else {
    // Attempt automatic detection on page load
    triggerAutoDetect(false);
  }
  toggleInterception.checked = stored.edm_interception_enabled !== false;
  if (inputMinSize) inputMinSize.value = stored.edm_min_size ? String(stored.edm_min_size) : "";
  if (inputExcludedDomains) inputExcludedDomains.value = stored.edm_excluded_domains || "";
  if (inputFileExtensions) inputFileExtensions.value = stored.edm_file_extensions || "";

  if (toggleAutoReconnect) toggleAutoReconnect.checked = stored.edm_auto_reconnect !== false;
  if (toggleNotifyComplete) toggleNotifyComplete.checked = stored.edm_notify_complete !== false;
  if (toggleNotifyFail) toggleNotifyFail.checked = stored.edm_notify_fail !== false;
  if (toggleYoutubePill) toggleYoutubePill.checked = stored.edm_youtube_pill_enabled !== false;

  checkStatus();
}

async function triggerAutoDetect(interactive = true) {
  if (interactive) {
    saveFeedback.className = "feedback-msg";
    saveFeedback.textContent = "Auto-detecting token from EDM Desktop app...";
    if (btnAutoDetect) btnAutoDetect.disabled = true;
  }

  // Direct fetch fallback
  for (const url of ["http://127.0.0.1:14370/token", "http://localhost:14370/token"]) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: { "X-EDM-Client": "extension" },
        cache: "no-store",
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
          inputToken.value = data.token;
          await chrome.storage.local.set({ edm_ws_token: data.token });
          chrome.runtime.sendMessage({ action: "update_token", token: data.token });
          if (btnAutoDetect) btnAutoDetect.disabled = false;
          saveFeedback.className = "feedback-msg success";
          saveFeedback.textContent = "Token auto-detected and synchronized successfully!";
          checkStatus();
          setTimeout(() => {
            saveFeedback.textContent = "";
          }, 3000);
          return;
        }
      }
    } catch {}
  }

  chrome.runtime.sendMessage({ action: "auto_detect_token" }, (resp) => {
    if (btnAutoDetect) btnAutoDetect.disabled = false;
    if (resp && resp.ok && resp.token) {
      inputToken.value = resp.token;
      saveFeedback.className = "feedback-msg success";
      saveFeedback.textContent = "Token auto-detected and synchronized successfully!";
      checkStatus();
      setTimeout(() => {
        saveFeedback.textContent = "";
      }, 3000);
    } else if (interactive) {
      saveFeedback.className = "feedback-msg error";
      saveFeedback.textContent = resp?.error || "Could not auto-detect token. Make sure EDM Desktop is running.";
    }
  });
}

if (btnAutoDetect) {
  btnAutoDetect.addEventListener("click", () => triggerAutoDetect(true));
}

// Check for updates
if (btnCheckUpdate) {
  btnCheckUpdate.addEventListener("click", () => {
    updateFeedback.className = "feedback-msg";
    updateFeedback.textContent = "Checking for extension updates...";
    btnCheckUpdate.disabled = true;

    chrome.runtime.sendMessage({ action: "check_update" }, (resp) => {
      btnCheckUpdate.disabled = false;
      if (resp && resp.ok) {
        if (resp.status === "update_available") {
          updateFeedback.className = "feedback-msg success";
          updateFeedback.textContent = `New update available (v${resp.version})! Click Reload Extension to apply.`;
        } else if (resp.status === "throttled") {
          updateFeedback.className = "feedback-msg";
          updateFeedback.textContent = "Update checks are throttled by Chrome. Try again shortly.";
        } else {
          updateFeedback.className = "feedback-msg success";
          updateFeedback.textContent = "Extension is fully up-to-date.";
        }
      } else {
        updateFeedback.className = "feedback-msg error";
        updateFeedback.textContent = resp?.error || "Unable to check for updates.";
      }
    });
  });
}

// Reload extension
if (btnReloadExt) {
  btnReloadExt.addEventListener("click", () => {
    updateFeedback.className = "feedback-msg success";
    updateFeedback.textContent = "Reloading extension runtime...";
    chrome.runtime.sendMessage({ action: "reload_extension" });
    setTimeout(() => {
      window.location.reload();
    }, 300);
  });
}

// Check current connection status via background
function checkStatus() {
  chrome.runtime.sendMessage({ action: "get_status" }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      updateBadge("disconnected", "Desktop Unreachable");
      return;
    }
    if (resp.connectionStatus === "connected") {
      updateBadge("connected", `Connected (${resp.activeTasks || 0} active)`);
    } else if (resp.connectionStatus === "connecting") {
      updateBadge("disconnected", "Connecting...");
    } else {
      updateBadge("disconnected", "Disconnected");
    }
  });
}

function updateBadge(state: "connected" | "disconnected", text: string) {
  statusBadge.className = `status-badge ${state}`;
  statusText.textContent = text;
}

// Save token
btnSave.addEventListener("click", () => {
  const token = inputToken.value.trim();
  if (token.length < 32) {
    saveFeedback.className = "feedback-msg error";
    saveFeedback.textContent = "Token must be at least 32 characters long.";
    return;
  }

  chrome.runtime.sendMessage({ action: "update_token", token }, (resp) => {
    if (resp && resp.ok) {
      saveFeedback.className = "feedback-msg success";
      saveFeedback.textContent = "Token saved! Reconnecting...";
      setTimeout(() => {
        saveFeedback.textContent = "";
        checkStatus();
      }, 2000);
    } else {
      saveFeedback.className = "feedback-msg error";
      saveFeedback.textContent = "Failed to update token.";
    }
  });
});

// Test Connection
btnTest.addEventListener("click", () => {
  const token = inputToken.value.trim();
  testFeedback.className = "feedback-msg";
  testFeedback.textContent = "Testing connection to 127.0.0.1:14370...";
  btnTest.disabled = true;

  chrome.runtime.sendMessage({ action: "test_token", token }, (resp) => {
    btnTest.disabled = false;
    if (chrome.runtime.lastError) {
      testFeedback.className = "feedback-msg error";
      testFeedback.textContent = "Background service worker not responding.";
      return;
    }
    if (resp && resp.ok) {
      testFeedback.className = "feedback-msg success";
      testFeedback.textContent = `Success! Connected in ${resp.latency}ms.`;
      updateBadge("connected", "Connected");
    } else {
      testFeedback.className = "feedback-msg error";
      testFeedback.textContent = `Connection failed: ${resp?.error || "Unknown error"}`;
      updateBadge("disconnected", "Connection Failed");
    }
  });
});

// Toggle Interception
toggleInterception.addEventListener("change", () => {
  const enabled = toggleInterception.checked;
  chrome.storage.local.set({ edm_interception_enabled: enabled });
});

// Save Interception Filters
if (btnSaveFilters) {
  btnSaveFilters.addEventListener("click", async () => {
    const minSize = inputMinSize ? parseInt(inputMinSize.value, 10) || 0 : 0;
    const excludedDomains = inputExcludedDomains ? inputExcludedDomains.value.trim() : "";
    const fileExtensions = inputFileExtensions ? inputFileExtensions.value.trim() : "";

    await chrome.storage.local.set({
      edm_min_size: minSize,
      edm_excluded_domains: excludedDomains,
      edm_file_extensions: fileExtensions,
    });

    if (filterFeedback) {
      filterFeedback.className = "feedback-msg success";
      filterFeedback.textContent = "Interception filters saved successfully!";
      setTimeout(() => {
        filterFeedback.textContent = "";
      }, 3000);
    }
  });
}

// Notifications and Automation Toggles
if (toggleAutoReconnect) {
  toggleAutoReconnect.addEventListener("change", () => {
    chrome.storage.local.set({ edm_auto_reconnect: toggleAutoReconnect.checked });
  });
}

if (toggleNotifyComplete) {
  toggleNotifyComplete.addEventListener("change", () => {
    chrome.storage.local.set({ edm_notify_complete: toggleNotifyComplete.checked });
  });
}

if (toggleNotifyFail) {
  toggleNotifyFail.addEventListener("change", () => {
    chrome.storage.local.set({ edm_notify_fail: toggleNotifyFail.checked });
  });
}

if (toggleYoutubePill) {
  toggleYoutubePill.addEventListener("change", () => {
    chrome.storage.local.set({ edm_youtube_pill_enabled: toggleYoutubePill.checked });
  });
}

loadSettings();
setInterval(checkStatus, 2500);
