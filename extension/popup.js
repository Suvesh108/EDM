var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 B/s";
  return formatBytes(bytesPerSec) + "/s";
}
function formatEta(remainingBytes, speedBps) {
  if (remainingBytes <= 0) return "Finishing...";
  if (speedBps <= 0) return "Connecting...";
  const secs = Math.ceil(remainingBytes / speedBps);
  if (secs < 60) return `${secs}s remaining`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s remaining`;
}
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function sanitizeUrl(rawUrl) {
  if (!rawUrl) return "about:blank";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
  }
  return "about:blank";
}
class PopupController {
  constructor() {
    __publicField(this, "activeTab", "tasks");
    __publicField(this, "taskFilter", "all");
    __publicField(this, "searchQuery", "");
    __publicField(this, "isAddFormOpen", false);
    __publicField(this, "newUrlInput", "");
    __publicField(this, "newFileNameInput", "");
    __publicField(this, "downloads", []);
    __publicField(this, "connectionState", "connecting");
    __publicField(this, "latencyMs", 0);
    __publicField(this, "token", "");
    __publicField(this, "interceptionEnabled", true);
    __publicField(this, "auditLogs", ["Popup initialized"]);
    __publicField(this, "pollInterval", null);
    __publicField(this, "refreshRateMs", 500);
    __publicField(this, "port", null);
    this.init();
  }
  async init() {
    this.bindHeaderNav();
    this.connectPort();
    await this.loadSettings();
    this.render();
  }
  connectPort() {
    try {
      this.port = chrome.runtime.connect({ name: "popup" });
      this.port.onMessage.addListener((msg) => {
        if (msg.type === "snapshot") {
          this.connectionState = msg.connectionStatus || "disconnected";
          this.updateConnectionPill();
          if (Array.isArray(msg.tasks)) {
            this.downloads = msg.tasks.map((t) => ({
              id: t.id,
              url: "",
              filename: t.filename,
              save_dir: "Downloads",
              category: "General",
              state: t.status,
              size_total: t.total,
              size_done: t.downloaded,
              resumable: true,
              speed_bytes_per_sec: t.speed,
              connections: 8,
              created_at: ""
            }));
            const badge = document.getElementById("tasksBadge");
            if (badge) {
              const activeCount = this.downloads.filter((d) => d.state === "downloading").length;
              badge.innerText = String(activeCount);
            }
            if (this.activeTab === "tasks") {
              this.renderTasksListOnly();
            }
          }
        }
      });
      this.port.onDisconnect.addListener(() => {
        this.port = null;
        this.connectionState = "disconnected";
        this.updateConnectionPill();
      });
    } catch (e) {
      console.warn("Could not connect port to background:", e);
    }
  }
  sendTaskAction(id, action) {
    if (this.port) {
      this.port.postMessage({ type: "task_action", id, action });
    }
  }
  async loadSettings() {
    const data = await chrome.storage.local.get([
      "edm_refresh_rate",
      "edm_theme",
      "edm_ws_token",
      "edm_interception_enabled"
    ]);
    if (data.edm_refresh_rate) {
      this.refreshRateMs = parseInt(data.edm_refresh_rate, 10);
    }
    if (data.edm_theme) {
      document.documentElement.setAttribute("data-theme", data.edm_theme);
    }
    this.interceptionEnabled = data.edm_interception_enabled !== false;
    if (data.edm_ws_token && data.edm_ws_token.length >= 32 && !data.edm_ws_token.startsWith("ed0000000000")) {
      this.token = data.edm_ws_token;
    } else {
      this.detectTokenSilently();
    }
  }
  async detectTokenSilently() {
    try {
      const nmhToken = await new Promise((resolve) => {
        chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_token" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.token) return resolve(null);
          resolve(resp.token);
        });
      });
      if (nmhToken && nmhToken.length >= 32) {
        this.token = nmhToken;
        await chrome.storage.local.set({ edm_ws_token: nmhToken });
        chrome.runtime.sendMessage({ action: "update_token", token: nmhToken });
        const input = document.getElementById("popupWsTokenInput");
        if (input) input.value = nmhToken;
        return;
      }
    } catch {
    }
    for (const url of ["http://127.0.0.1:14370/token", "http://localhost:14370/token"]) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: { "X-EDM-Client": "extension" },
          cache: "no-store"
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
            this.token = data.token;
            await chrome.storage.local.set({ edm_ws_token: data.token });
            chrome.runtime.sendMessage({ action: "update_token", token: data.token });
            const input = document.getElementById("popupWsTokenInput");
            if (input) input.value = data.token;
            return;
          }
        }
      } catch {
      }
    }
    chrome.runtime.sendMessage({ action: "auto_detect_token" }, (resp) => {
      if (resp && resp.ok && resp.token) {
        this.token = resp.token;
        const input = document.getElementById("popupWsTokenInput");
        if (input) input.value = resp.token;
      }
    });
  }
  bindHeaderNav() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (tab) {
          this.activeTab = tab;
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.render();
        }
      });
    });
  }
  updateConnectionPill() {
    const pill = document.getElementById("connectionPill");
    const dot = document.getElementById("connectionDot");
    const text = document.getElementById("connectionText");
    if (!pill || !dot || !text) return;
    pill.style.cursor = "pointer";
    pill.title = "Click to configure connection & settings";
    pill.onclick = () => {
      this.activeTab = "settings";
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelector('[data-tab="settings"]')?.classList.add("active");
      this.render();
    };
    dot.className = "status-dot";
    switch (this.connectionState) {
      case "connected":
        dot.classList.add("dot-connected");
        text.innerText = "Connected";
        break;
      case "connecting":
        dot.classList.add("dot-connecting");
        text.innerText = "Connecting...";
        break;
      case "reconnecting":
        dot.classList.add("dot-reconnecting");
        text.innerText = "Reconnecting...";
        break;
      default:
        dot.classList.add("dot-failed");
        text.innerText = "Offline (Setup)";
        break;
    }
  }
  render() {
    const app = document.getElementById("app");
    if (!app) return;
    if (this.activeTab === "tasks") {
      app.innerHTML = this.renderTasksTab();
      this.attachTasksEvents();
    } else {
      app.innerHTML = this.renderSettingsTab();
      this.attachSettingsEvents();
    }
  }
  // ─────────────────────────────────────────────────────────────
  // 1. TASKS TAB
  // ─────────────────────────────────────────────────────────────
  renderTasksTab() {
    const activeDownloads = this.downloads.filter((d) => d.state === "downloading");
    const aggSpeed = activeDownloads.reduce((sum, d) => sum + (d.speed_bytes_per_sec || 0), 0);
    const completedCount = this.downloads.filter((d) => d.state === "completed").length;
    return `
      <div class="tasks-toolbar">
        <div class="toolbar-row">
          <div class="filter-pills">
            <button class="filter-pill ${this.taskFilter === "all" ? "active" : ""}" data-filter="all">All (${this.downloads.length})</button>
            <button class="filter-pill ${this.taskFilter === "active" ? "active" : ""}" data-filter="active">Active (${activeDownloads.length})</button>
            <button class="filter-pill ${this.taskFilter === "completed" ? "active" : ""}" data-filter="completed">Done (${completedCount})</button>
            <button class="filter-pill ${this.taskFilter === "failed" ? "active" : ""}" data-filter="failed">Failed</button>
          </div>
          <button id="toggleAddBtn" class="btn-3d btn-primary" title="Add Download Link">+ Add URL</button>
        </div>

        <div class="toolbar-row">
          <input type="text" id="taskSearch" class="search-input" placeholder="Search files or links..." value="${escapeHtml(this.searchQuery)}">
        </div>

        ${this.isAddFormOpen ? `
          <div class="settings-group" style="margin-top: 4px; padding: 8px;">
            <div style="font-weight: 600; font-size: 11px; margin-bottom: 4px;">Add New Download</div>
            <input type="text" id="newUrlInput" placeholder="https://example.com/file.mp4" value="${escapeHtml(this.newUrlInput)}" style="width: 100%; margin-bottom: 6px;">
            <input type="text" id="newFileNameInput" placeholder="File name (optional, e.g. video.mp4)" value="${escapeHtml(this.newFileNameInput)}" style="width: 100%; margin-bottom: 6px;">
            <div style="display: flex; justify-content: flex-end; gap: 6px;">
              <button id="cancelAddBtn" class="btn-3d">Cancel</button>
              <button id="startAddBtn" class="btn-3d btn-primary">Start Download</button>
            </div>
          </div>
        ` : ""}

        <div class="aggregate-strip">
          <span>Active: <span style="color: #60A5FA; font-weight:600;">${activeDownloads.length}</span> \xB7 Completed: ${completedCount}</span>
          <span class="aggregate-speed">${formatSpeed(aggSpeed)} Total</span>
        </div>
      </div>

      <div id="tasksListContainer" class="downloads-list">
        ${this.renderTasksListHtml()}
      </div>
    `;
  }
  renderTasksListHtml() {
    const filtered = this.downloads.filter((d) => {
      const matchesSearch = d.filename.toLowerCase().includes(this.searchQuery.toLowerCase()) || d.url.toLowerCase().includes(this.searchQuery.toLowerCase());
      const matchesFilter = this.taskFilter === "all" || this.taskFilter === "active" && (d.state === "downloading" || d.state === "queued" || d.state === "connecting") || this.taskFilter === "completed" && d.state === "completed" || this.taskFilter === "failed" && (d.state === "failed" || d.state === "cancelled");
      return matchesSearch && matchesFilter;
    });
    if (filtered.length === 0) {
      if (this.connectionState === "connection_failed" || this.connectionState === "application_not_running") {
        return `
          <div class="empty-state">
            <div class="empty-icon">\u{1F50C}</div>
            <div style="font-weight: 600; color: #F87171;">EDM Desktop App Not Reachable</div>
            <div style="font-size: 11px; max-width: 300px;">Please ensure the EDM Desktop application or Native Host is running on your system.</div>
            <button id="retryConnectBtn" class="btn-3d btn-primary" style="margin-top: 8px;">Retry Connection</button>
          </div>
        `;
      }
      return `
        <div class="empty-state">
          <div class="empty-icon">\u{1F4E5}</div>
          <div style="font-weight: 600;">No downloads found</div>
          <div style="font-size: 11px;">Downloads added in browser or EDM desktop will show here live.</div>
        </div>
      `;
    }
    return filtered.map((item) => {
      const total = item.size_total || 0;
      const done = item.size_done || 0;
      const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
      const isDownloading = item.state === "downloading";
      const isPaused = item.state === "paused";
      const isCompleted = item.state === "completed";
      const isFailed = item.state === "failed" || item.state === "cancelled";
      let catClass = "cat-programs";
      let catLetter = "\u2699";
      const ext = item.filename.split(".").pop()?.toLowerCase() || "";
      if (["mp4", "mkv", "webm", "avi"].includes(ext)) {
        catClass = "cat-video";
        catLetter = "\u{1F3AC}";
      } else if (["mp3", "flac", "wav", "m4a"].includes(ext)) {
        catClass = "cat-music";
        catLetter = "\u{1F3B5}";
      } else if (["zip", "rar", "7z", "tar", "gz", "iso"].includes(ext)) {
        catClass = "cat-compressed";
        catLetter = "\u{1F4E6}";
      } else if (["pdf", "doc", "docx", "txt"].includes(ext)) {
        catClass = "cat-documents";
        catLetter = "\u{1F4C4}";
      }
      return `
        <div class="download-card" data-id="${escapeHtml(item.id)}">
          <div class="card-header">
            <div class="card-identity">
              <div class="cat-icon ${catClass}">${catLetter}</div>
              <div style="min-width: 0; flex: 1;">
                <div class="file-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
                <div class="file-meta">${escapeHtml(item.category)} \u2022 ${escapeHtml(item.save_dir || "Downloads")}</div>
              </div>
            </div>
            <span class="status-badge status-${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
          </div>

          <div class="progress-track">
            <div class="progress-bar-fill" style="width: ${pct}%;">
              ${isDownloading ? '<div class="progress-bar-beacon"></div>' : ""}
            </div>
          </div>

          <div class="card-stats">
            <span>${total > 0 ? `${formatBytes(done)} / ${formatBytes(total)} (${pct}%)` : `${formatBytes(done)} downloaded`}</span>
            <span class="card-stats-speed">
              ${isDownloading ? `${formatSpeed(item.speed_bytes_per_sec)} \xB7 ${formatEta(total - done, item.speed_bytes_per_sec)}` : isCompleted ? "Finished" : isPaused ? "Paused" : escapeHtml(item.state)}
            </span>
          </div>

          <div class="card-actions">
            ${isDownloading ? `<button class="btn-3d act-pause" data-id="${escapeHtml(item.id)}" title="Pause Download">\u23F8 Pause</button>` : isPaused ? `<button class="btn-3d act-resume" data-id="${escapeHtml(item.id)}" style="color: #34D399;" title="Resume Download">\u25B6 Resume</button>` : ""}
            ${isCompleted ? `
              <button class="btn-3d act-open-file" data-id="${escapeHtml(item.id)}" title="Open File">\u{1F4C4} Open</button>
              <button class="btn-3d act-open-folder" data-id="${escapeHtml(item.id)}" title="Open Containing Folder">\u{1F4C1} Folder</button>
            ` : ""}
            ${isFailed ? `<button class="btn-3d act-retry" data-id="${escapeHtml(item.id)}" style="color: #38BDF8;" title="Retry Download">\u21BB Retry</button>` : ""}
            ${!isCompleted ? `<button class="btn-3d act-cancel" data-id="${escapeHtml(item.id)}" style="color: #F87171;" title="Cancel Download">\u2715 Cancel</button>` : ""}
            <button class="btn-3d act-copy" data-url="${escapeHtml(item.url)}" title="Copy URL">\u{1F4CB}</button>
            <button class="btn-3d act-delete" data-id="${escapeHtml(item.id)}" title="Remove from list">\u{1F5D1}</button>
          </div>
        </div>
      `;
    }).join("");
  }
  renderTasksListOnly() {
    const container = document.getElementById("tasksListContainer");
    if (!container) return;
    container.innerHTML = this.renderTasksListHtml();
    this.attachCardActions();
  }
  attachTasksEvents() {
    document.querySelectorAll(".filter-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        this.taskFilter = pill.getAttribute("data-filter");
        document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        this.renderTasksListOnly();
      });
    });
    const searchInp = document.getElementById("taskSearch");
    if (searchInp) {
      searchInp.addEventListener("input", (e) => {
        this.searchQuery = e.target.value;
        this.renderTasksListOnly();
      });
    }
    const toggleAddBtn = document.getElementById("toggleAddBtn");
    if (toggleAddBtn) {
      toggleAddBtn.addEventListener("click", () => {
        this.isAddFormOpen = !this.isAddFormOpen;
        this.render();
      });
    }
    const cancelAddBtn = document.getElementById("cancelAddBtn");
    if (cancelAddBtn) {
      cancelAddBtn.addEventListener("click", () => {
        this.isAddFormOpen = false;
        this.newUrlInput = "";
        this.newFileNameInput = "";
        this.render();
      });
    }
    const startAddBtn = document.getElementById("startAddBtn");
    if (startAddBtn) {
      startAddBtn.addEventListener("click", () => {
        const urlInp = document.getElementById("newUrlInput");
        const fileInp = document.getElementById("newFileNameInput");
        const url = urlInp?.value.trim();
        const filename = fileInp?.value.trim();
        if (!url) return;
        if (this.port) {
          this.port.postMessage({
            type: "create_task",
            url,
            filename: filename || void 0
          });
        }
        this.isAddFormOpen = false;
        this.newUrlInput = "";
        this.newFileNameInput = "";
        this.render();
      });
    }
    const retryBtn = document.getElementById("retryConnectBtn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        if (this.port) {
          this.port.postMessage({ type: "reconnect" });
        }
        this.connectionState = "reconnecting";
        this.updateConnectionPill();
      });
    }
    this.attachCardActions();
  }
  attachCardActions() {
    document.querySelectorAll(".act-pause").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "pause");
        }
      });
    });
    document.querySelectorAll(".act-resume").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "resume");
        }
      });
    });
    document.querySelectorAll(".act-cancel").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id && confirm("Are you sure you want to cancel this download?")) {
          this.sendTaskAction(id, "cancel");
        }
      });
    });
    document.querySelectorAll(".act-retry").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "resume");
        }
      });
    });
    document.querySelectorAll(".act-open-file").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) this.sendTaskAction(id, "open_file");
      });
    });
    document.querySelectorAll(".act-open-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) this.sendTaskAction(id, "open_folder");
      });
    });
    document.querySelectorAll(".act-copy").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const url = btn.getAttribute("data-url");
        if (url) {
          navigator.clipboard.writeText(url);
          const orig = btn.innerHTML;
          btn.innerHTML = "\u2713";
          setTimeout(() => {
            btn.innerHTML = orig;
          }, 1200);
        }
      });
    });
    document.querySelectorAll(".act-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "remove");
        }
      });
    });
  }
  // ─────────────────────────────────────────────────────────────
  // 2. UNIFIED SETTINGS TAB
  // ─────────────────────────────────────────────────────────────
  renderSettingsTab() {
    return `
      <div class="settings-pane" style="padding: 12px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; height: 100%;">
        <!-- WebSocket Authentication Token Card (matches user design) -->
        <div class="settings-group" style="padding: 14px; background: #070e1b; border: 1px solid #1a273e; border-radius: 10px;">
          <div class="settings-group-title" style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-bottom: 6px;">WebSocket Authentication Token</div>
          <div class="setting-desc" style="font-size: 11px; color: #8fa0be; line-height: 1.5; margin-bottom: 12px;">
            Copy this token from the EDM Desktop app: Settings &rarr; Network &amp; Browser Integration &rarr; Extension WebSocket Authentication Token.
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <input type="text" id="popupWsTokenInput" value="${escapeHtml(this.token || "")}" placeholder="Paste 64-character token here" style="flex: 1; height: 38px; background: #040914; border: 1px solid #1a2a44; border-radius: 8px; color: #FFFFFF; padding: 0 12px; font-family: monospace; font-size: 11.5px; outline: none;" spellcheck="false" autocomplete="off" />
            <button id="popupBtnAutoDetectToken" class="btn-3d" style="height: 38px; padding: 0 10px; font-size: 11px; white-space: nowrap;" title="Auto-detect token from EDM Desktop app">Auto-Detect</button>
            <button id="popupBtnSaveToken" class="btn-3d btn-primary" style="height: 38px; padding: 0 16px; font-size: 12px; font-weight: 600; white-space: nowrap; background: #2563EB;">Save</button>
          </div>
          <div id="popupTokenFeedback" style="font-size: 11px; margin-top: 8px; min-height: 16px;"></div>
        </div>

        <!-- Extension Updates & Hot Reload Card -->
        <div class="settings-group" style="padding: 14px; background: #070e1b; border: 1px solid #1a273e; border-radius: 10px;">
          <div class="settings-group-title" style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-bottom: 6px;">Extension Updates &amp; Hot Reload</div>
          <div class="setting-desc" style="font-size: 11px; color: #8fa0be; line-height: 1.5; margin-bottom: 12px;">
            Directly check for newer extension builds or hot reload the extension worker after updating source files.
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="popupBtnCheckUpdate" class="btn-3d" style="height: 34px; padding: 0 12px; font-size: 11px;">Check for Updates</button>
            <button id="popupBtnReloadExt" class="btn-3d btn-primary" style="height: 34px; padding: 0 12px; font-size: 11px; background: #2563EB;">Reload Extension</button>
          </div>
          <div id="popupUpdateFeedback" style="font-size: 11px; margin-top: 8px; min-height: 16px;"></div>
        </div>

        <!-- Download Interception Toggle -->
        <div class="settings-group" style="padding: 14px; background: #070e1b; border: 1px solid #1a273e; border-radius: 10px;">
          <div class="settings-group-title" style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-bottom: 6px;">Download Interception</div>
          <div class="setting-row" style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div class="setting-label" style="font-size: 12px; font-weight: 600;">Automatic Interception</div>
              <div class="setting-desc" style="font-size: 11px; color: #8fa0be;">Route browser downloads to EDM accelerator</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="popupInterceptionToggle" ${this.interceptionEnabled ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
          <div style="font-size: 10.5px; color: #718096; margin-top: 8px; line-height: 1.4;">
            Tip: Hold <kbd style="background:#1e293b; padding:1px 4px; border-radius:3px; font-size:10px;">Shift</kbd> or <kbd style="background:#1e293b; padding:1px 4px; border-radius:3px; font-size:10px;">Alt</kbd> while clicking a link to bypass EDM and download via browser.
          </div>
        </div>

        <!-- Desktop Connection & Bridge -->
        <div class="settings-group">
          <div class="settings-group-title">Desktop Connection &amp; Bridge</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Connection Status</div>
              <div class="setting-desc">Live WebSocket link on 127.0.0.1:14370</div>
            </div>
            <button id="testConnBtn" class="btn-3d">Test Connection</button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Auto-Reconnect</div>
              <div class="setting-desc">Automatically retry connection on drop</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="autoReconnectToggle" checked>
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- Interface & Appearance -->
        <div class="settings-group">
          <div class="settings-group-title">Interface &amp; Appearance</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Telemetry Refresh Rate</div>
              <div class="setting-desc">Live progress update frequency</div>
            </div>
            <select id="rateSelect">
              <option value="250" ${this.refreshRateMs === 250 ? "selected" : ""}>250 ms (Real-time)</option>
              <option value="500" ${this.refreshRateMs === 500 ? "selected" : ""}>500 ms (Standard)</option>
              <option value="1000" ${this.refreshRateMs === 1e3 ? "selected" : ""}>1000 ms (Relaxed)</option>
              <option value="2000" ${this.refreshRateMs === 2e3 ? "selected" : ""}>2000 ms (Battery Saver)</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Theme Palette</div>
              <div class="setting-desc">Matches EDM desktop chassis</div>
            </div>
            <select id="themeSelect">
              <option value="dark" selected>Obsidian Dark (#000000)</option>
              <option value="blue">Deep Blue (#050B14)</option>
            </select>
          </div>
        </div>

        <!-- Browser Notifications -->
        <div class="settings-group">
          <div class="settings-group-title">Browser Notifications</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Download Completed</div>
              <div class="setting-desc">Notify when a file finishes downloading</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="notifyCompleteToggle" checked>
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Download Failed / Error</div>
              <div class="setting-desc">Notify on network failure or stalled task</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="notifyFailToggle" checked>
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- Host Diagnostics -->
        <div class="settings-group">
          <div class="settings-group-title">Diagnostics &amp; Host Telemetry</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Host Channel Status</div>
              <div class="setting-desc">Chromium Native Messaging pipe</div>
            </div>
            <span class="pro-badge" style="background:#10B98120; border-color:#10B98150; color:#34D399;">${this.connectionState.toUpperCase()}</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">IPC Round-Trip Latency</div>
              <div class="setting-desc">Measured ping response time</div>
            </div>
            <span style="font-family:monospace; font-weight:600; color:#38BDF8;">${this.latencyMs} ms</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Host Identifier</div>
              <div class="setting-desc">Native Messaging Host ID</div>
            </div>
            <span style="font-family:monospace; font-size:10.5px;">com.edm.nmh</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Local WebSocket Bridge</div>
              <div class="setting-desc">Direct high-speed telemetry link</div>
            </div>
            <span style="font-family:monospace; font-size:10.5px; color:#34D399;">ws://127.0.0.1:14370</span>
          </div>
        </div>
      </div>
    `;
  }
  attachSettingsEvents() {
    const tokenInput = document.getElementById("popupWsTokenInput");
    const btnSave = document.getElementById("popupBtnSaveToken");
    const btnAutoDetect = document.getElementById("popupBtnAutoDetectToken");
    const tokenFeedback = document.getElementById("popupTokenFeedback");
    const btnCheckUpdate = document.getElementById("popupBtnCheckUpdate");
    const btnReloadExt = document.getElementById("popupBtnReloadExt");
    const updateFeedback = document.getElementById("popupUpdateFeedback");
    const toggleInterception = document.getElementById("popupInterceptionToggle");
    if (toggleInterception) {
      toggleInterception.addEventListener("change", async () => {
        this.interceptionEnabled = toggleInterception.checked;
        await chrome.storage.local.set({ edm_interception_enabled: this.interceptionEnabled });
      });
    }
    if (btnSave && tokenInput) {
      btnSave.addEventListener("click", () => {
        const token = tokenInput.value.trim();
        if (token.length < 32) {
          if (tokenFeedback) {
            tokenFeedback.style.color = "#EF4444";
            tokenFeedback.textContent = "Token must be at least 32 characters long.";
          }
          return;
        }
        chrome.runtime.sendMessage({ action: "update_token", token }, (resp) => {
          if (resp && resp.ok) {
            this.token = token;
            if (tokenFeedback) {
              tokenFeedback.style.color = "#10B981";
              tokenFeedback.textContent = "Token saved! Reconnecting...";
              setTimeout(() => {
                if (tokenFeedback) tokenFeedback.textContent = "";
              }, 2500);
            }
          } else if (tokenFeedback) {
            tokenFeedback.style.color = "#EF4444";
            tokenFeedback.textContent = "Failed to update token.";
          }
        });
      });
    }
    if (btnAutoDetect && tokenInput) {
      btnAutoDetect.addEventListener("click", async () => {
        if (tokenFeedback) {
          tokenFeedback.style.color = "#8FA0BE";
          tokenFeedback.textContent = "Auto-detecting token from EDM Desktop app...";
        }
        btnAutoDetect.disabled = true;
        let detected = null;
        try {
          detected = await new Promise((resolve) => {
            chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_token" }, (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.token) return resolve(null);
              resolve(resp.token);
            });
          });
        } catch {
        }
        if (!detected) {
          for (const url of ["http://127.0.0.1:14370/token", "http://localhost:14370/token"]) {
            try {
              const resp = await fetch(url, {
                method: "GET",
                headers: { "X-EDM-Client": "extension" },
                cache: "no-store"
              });
              if (resp.ok) {
                const data = await resp.json();
                if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
                  detected = data.token;
                  break;
                }
              }
            } catch {
            }
          }
        }
        if (detected) {
          this.token = detected;
          tokenInput.value = detected;
          await chrome.storage.local.set({ edm_ws_token: detected });
          chrome.runtime.sendMessage({ action: "update_token", token: detected });
          btnAutoDetect.disabled = false;
          if (tokenFeedback) {
            tokenFeedback.style.color = "#10B981";
            tokenFeedback.textContent = "Token auto-detected and synchronized successfully!";
            setTimeout(() => {
              if (tokenFeedback) tokenFeedback.textContent = "";
            }, 3e3);
          }
          return;
        }
        chrome.runtime.sendMessage({ action: "auto_detect_token" }, (resp) => {
          btnAutoDetect.disabled = false;
          if (resp && resp.ok && resp.token) {
            this.token = resp.token;
            tokenInput.value = resp.token;
            if (tokenFeedback) {
              tokenFeedback.style.color = "#10B981";
              tokenFeedback.textContent = "Token auto-detected and synchronized successfully!";
              setTimeout(() => {
                if (tokenFeedback) tokenFeedback.textContent = "";
              }, 3e3);
            }
          } else if (tokenFeedback) {
            tokenFeedback.style.color = "#EF4444";
            tokenFeedback.textContent = resp?.error || "Could not auto-detect token. Ensure EDM Desktop is running.";
          }
        });
      });
    }
    if (btnCheckUpdate) {
      btnCheckUpdate.addEventListener("click", () => {
        if (updateFeedback) {
          updateFeedback.style.color = "#8FA0BE";
          updateFeedback.textContent = "Checking for extension updates...";
        }
        btnCheckUpdate.disabled = true;
        chrome.runtime.sendMessage({ action: "check_update" }, (resp) => {
          btnCheckUpdate.disabled = false;
          if (resp && resp.ok) {
            if (resp.status === "update_available") {
              if (updateFeedback) {
                updateFeedback.style.color = "#10B981";
                updateFeedback.textContent = `Update available (v${resp.version})! Click Reload Extension to apply.`;
              }
            } else if (resp.status === "throttled") {
              if (updateFeedback) {
                updateFeedback.style.color = "#8FA0BE";
                updateFeedback.textContent = "Update checks are throttled by Chrome. Try again shortly.";
              }
            } else if (updateFeedback) {
              updateFeedback.style.color = "#10B981";
              updateFeedback.textContent = "Extension is up to date (v0.0.3).";
            }
          } else if (updateFeedback) {
            updateFeedback.style.color = "#EF4444";
            updateFeedback.textContent = resp?.error || "Update check failed.";
          }
        });
      });
    }
    if (btnReloadExt) {
      btnReloadExt.addEventListener("click", () => {
        if (updateFeedback) {
          updateFeedback.style.color = "#10B981";
          updateFeedback.textContent = "Extension reloaded. Reopen popup.";
        }
        chrome.runtime.sendMessage({ action: "reload_extension" });
        setTimeout(() => {
          window.close();
        }, 300);
      });
    }
    const testBtn = document.getElementById("testConnBtn");
    if (testBtn) {
      testBtn.addEventListener("click", () => {
        testBtn.innerText = "Pinging...";
        const token = this.token || tokenInput?.value.trim();
        chrome.runtime.sendMessage({ action: "test_token", token }, (resp) => {
          if (resp && resp.ok) {
            testBtn.innerText = `Connected (${resp.latency}ms)`;
            testBtn.style.color = "#34D399";
            this.latencyMs = resp.latency;
          } else {
            testBtn.innerText = "Failed";
            testBtn.style.color = "#F87171";
          }
          setTimeout(() => {
            testBtn.innerText = "Test Connection";
            testBtn.style.color = "";
          }, 2e3);
        });
      });
    }
    const rateSelect = document.getElementById("rateSelect");
    if (rateSelect) {
      rateSelect.addEventListener("change", async () => {
        const val = parseInt(rateSelect.value, 10);
        this.refreshRateMs = val;
        await chrome.storage.local.set({ edm_refresh_rate: val });
      });
    }
    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
      themeSelect.addEventListener("change", async () => {
        const val = themeSelect.value;
        document.documentElement.setAttribute("data-theme", val);
        await chrome.storage.local.set({ edm_theme: val });
      });
    }
    const notifyComp = document.getElementById("notifyCompleteToggle");
    const notifyFail = document.getElementById("notifyFailToggle");
    if (notifyComp && notifyFail) {
      const saveNotif = async () => {
        await chrome.storage.local.set({
          edm_settings: {
            notifyComplete: notifyComp.checked,
            notifyFail: notifyFail.checked
          }
        });
      };
      notifyComp.addEventListener("change", saveNotif);
      notifyFail.addEventListener("change", saveNotif);
    }
  }
}
document.addEventListener("DOMContentLoaded", () => {
  window.__app = new PopupController();
});
