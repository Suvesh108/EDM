document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const mediaList = document.getElementById("mediaList");
  const rescanBtn = document.getElementById("rescanBtn");
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");
  
  // Quick URL
  const quickUrlInput = document.getElementById("quickUrlInput");
  const qualitySelect = document.getElementById("qualitySelect");
  const quickDownloadBtn = document.getElementById("quickDownloadBtn");
  const quickFeedback = document.getElementById("quickFeedback");

  // Settings
  const interceptToggle = document.getElementById("interceptToggle");
  const floatingBtnToggle = document.getElementById("floatingBtnToggle");
  const backendInput = document.getElementById("backendInput");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const openWebAppBtn = document.getElementById("openWebAppBtn");

  // 1. Navigation Tab Switching
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId)?.classList.add("active");
    });
  });

  // 2. Check Backend Connection Status
  function checkStatus() {
    chrome.runtime.sendMessage({ action: "check_backend_status" }, (res) => {
      if (res && res.online) {
        statusBadge.className = "status-badge online";
        statusText.textContent = "Engine Connected";
      } else {
        statusBadge.className = "status-badge offline";
        statusText.textContent = "Standalone";
      }
    });
  }
  checkStatus();

  // 3. Scan Active Tab for Media
  function scanActiveTab() {
    mediaList.innerHTML = `<div class="empty-state"><span>Scanning current page...</span></div>`;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.id) {
        mediaList.innerHTML = `<div class="empty-state"><span>No active tab found.</span></div>`;
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, { action: "sniff_page_media" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.media || res.media.length === 0) {
          mediaList.innerHTML = `
            <div class="empty-state">
              <span>No direct video streams sniffed yet.<br>Play the media or paste URL in Quick tab.</span>
            </div>
          `;
          return;
        }

        renderMediaItems(res.media);
      });
    });
  }

  function renderMediaItems(items) {
    mediaList.innerHTML = "";
    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "media-item";
      el.innerHTML = `
        <div class="media-meta">
          <div class="media-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="media-sub">
            <span class="media-badge">${escapeHtml(item.type)}</span>
            <span>${escapeHtml(item.resolution)}</span>
          </div>
        </div>
        <button class="media-dl-btn">Download</button>
      `;

      el.querySelector(".media-dl-btn").addEventListener("click", () => {
        chrome.runtime.sendMessage({
          action: "download_stream",
          url: item.url,
          title: item.title
        }, () => {
          showFeedback(quickFeedback, "✓ Download task queued in Vortex Downloader!", "success");
        });
      });

      mediaList.appendChild(el);
    });
  }

  rescanBtn.addEventListener("click", scanActiveTab);
  scanActiveTab();

  // 4. Quick Download Handler
  quickDownloadBtn.addEventListener("click", () => {
    const rawUrl = quickUrlInput.value.trim();
    if (!rawUrl) {
      showFeedback(quickFeedback, "Please enter a valid URL.", "error");
      return;
    }

    quickDownloadBtn.disabled = true;
    quickDownloadBtn.textContent = "Dispatching...";

    chrome.runtime.sendMessage({
      action: "download_stream",
      url: rawUrl,
      title: "Quick Media Download",
      formatId: qualitySelect.value
    }, (res) => {
      quickDownloadBtn.disabled = false;
      quickDownloadBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download with Vortex
      `;
      showFeedback(quickFeedback, "✓ Download dispatched to Vortex Engine!", "success");
      quickUrlInput.value = "";
    });
  });

  // 5. Settings Persistence
  chrome.storage.sync.get(["interceptDownloads", "showFloatingButton", "backendUrl"], (res) => {
    if (res.interceptDownloads !== undefined) interceptToggle.checked = res.interceptDownloads;
    if (res.showFloatingButton !== undefined) floatingBtnToggle.checked = res.showFloatingButton;
    if (res.backendUrl) backendInput.value = res.backendUrl;
  });

  saveSettingsBtn.addEventListener("click", () => {
    chrome.storage.sync.set({
      interceptDownloads: interceptToggle.checked,
      showFloatingButton: floatingBtnToggle.checked,
      backendUrl: backendInput.value.trim() || "http://localhost:5001"
    }, () => {
      saveSettingsBtn.textContent = "Saved ✓";
      setTimeout(() => saveSettingsBtn.textContent = "Save Settings", 1500);
      checkStatus();
    });
  });

  // 6. Open Web App
  openWebAppBtn.addEventListener("click", () => {
    chrome.storage.sync.get("backendUrl", ({ backendUrl }) => {
      const url = "http://localhost:3000";
      chrome.tabs.create({ url });
    });
  });

  function showFeedback(el, msg, type) {
    el.textContent = msg;
    el.className = `feedback-msg ${type}`;
    setTimeout(() => {
      el.textContent = "";
      el.className = "feedback-msg";
    }, 4000);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }
});
