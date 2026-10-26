const inputToken = document.getElementById("inputToken");
const btnSave = document.getElementById("btnSave");
const btnTest = document.getElementById("btnTest");
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const testFeedback = document.getElementById("testFeedback");
const saveFeedback = document.getElementById("saveFeedback");
const toggleInterception = document.getElementById("toggleInterception");
async function loadSettings() {
  const stored = await chrome.storage.local.get(["edm_ws_token", "edm_interception_enabled"]);
  if (stored.edm_ws_token) {
    inputToken.value = stored.edm_ws_token;
  }
  toggleInterception.checked = stored.edm_interception_enabled !== false;
  checkStatus();
}
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
function updateBadge(state, text) {
  statusBadge.className = `status-badge ${state}`;
  statusText.textContent = text;
}
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
      }, 2e3);
    } else {
      saveFeedback.className = "feedback-msg error";
      saveFeedback.textContent = "Failed to update token.";
    }
  });
});
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
toggleInterception.addEventListener("change", () => {
  const enabled = toggleInterception.checked;
  chrome.storage.local.set({ edm_interception_enabled: enabled });
});
loadSettings();
setInterval(checkStatus, 2500);
