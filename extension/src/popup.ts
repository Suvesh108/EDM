// EDM Live Download Dashboard - Main Popup Controller

interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  save_dir: string;
  category: string;
  state: string;
  size_total: number | null;
  size_done: number;
  resumable: boolean;
  speed_bytes_per_sec: number;
  connections: number;
  created_at: string;
  completed_at?: string | null;
  error_msg?: string | null;
}

const SVG_ICONS = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"></polygon></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`,
  cancel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  retry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
  openFile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`,
  openFolder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
};

const CATEGORY_SVGS = {
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`,
  music: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  compressed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
  document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
  programs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
};

// Format helpers
function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 B/s";
  return formatBytes(bytesPerSec) + "/s";
}

function formatEta(remainingBytes: number, speedBps: number): string {
  if (remainingBytes <= 0) return "Finishing...";
  if (speedBps <= 0) return "Connecting...";
  const secs = Math.ceil(remainingBytes / speedBps);
  if (secs < 60) return `${secs}s remaining`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s remaining`;
}

// Security: Prevent Stored XSS / DOM Injection from unvetted network inputs
function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "about:blank";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {}
  return "about:blank";
}

class PopupController {
  private activeTab: "tasks" | "settings" = "tasks";
  private taskFilter: "all" | "active" | "completed" | "failed" = "all";
  private searchQuery: string = "";
  private isAddFormOpen: boolean = false;
  private newUrlInput: string = "";
  private newFileNameInput: string = "";

  private downloads: DownloadItem[] = [];
  private connectionState: string = "connecting";
  private lifecycleState: string = "active";
  private latencyMs: number = 0;
  private token: string = "";
  private interceptionEnabled: boolean = true;
  private auditLogs: string[] = ["Popup initialized"];

  private pollInterval: any = null;
  private refreshRateMs: number = 500;
  private port: chrome.runtime.Port | null = null;
  private deleteModalTarget: { id: string; filename: string } | null = null;

  constructor() {
    this.init();
  }

  private async init() {
    this.bindHeaderNav();
    this.connectPort();
    await this.loadSettings();
    this.render();
  }

  private connectPort() {
    try {
      this.port = chrome.runtime.connect({ name: "popup" });
      this.port.onMessage.addListener((msg) => {
        if (msg.type === "snapshot") {
          this.connectionState = msg.connectionStatus || "asleep";
          if (msg.lifecycleState) {
            this.lifecycleState = msg.lifecycleState;
          }
          this.updateConnectionPill();
          if (msg.palette) {
            document.documentElement.setAttribute("data-palette", msg.palette);
          }
          if (msg.theme) {
            document.documentElement.setAttribute("data-theme", msg.theme);
          }
          if (Array.isArray(msg.tasks)) {
            this.downloads = msg.tasks.map((t: any) => ({
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
              created_at: "",
            }));
            this.updateAllCounters();
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

  private updateAllCounters() {
    const activeDownloads = this.downloads.filter(
      (d) => d.state === "downloading" || d.state === "queued" || d.state === "connecting"
    );
    const completedCount = this.downloads.filter((d) => d.state === "completed").length;
    const failedCount = this.downloads.filter((d) => d.state === "failed" || d.state === "cancelled").length;
    const aggSpeed = activeDownloads.reduce((sum, d) => sum + (d.speed_bytes_per_sec || 0), 0);

    // Header badge
    const badge = document.getElementById("tasksBadge");
    if (badge) {
      badge.innerText = String(activeDownloads.length);
    }

    // Filter pills
    const pillAll = document.querySelector('.filter-pill[data-filter="all"]');
    if (pillAll) pillAll.textContent = `All (${this.downloads.length})`;

    const pillActive = document.querySelector('.filter-pill[data-filter="active"]');
    if (pillActive) pillActive.textContent = `Active (${activeDownloads.length})`;

    const pillDone = document.querySelector('.filter-pill[data-filter="completed"]');
    if (pillDone) pillDone.textContent = `Done (${completedCount})`;

    const pillFailed = document.querySelector('.filter-pill[data-filter="failed"]');
    if (pillFailed) pillFailed.textContent = `Failed${failedCount > 0 ? ` (${failedCount})` : ""}`;

    // Aggregate strip
    const strip = document.querySelector(".aggregate-strip");
    if (strip) {
      strip.innerHTML = `
        <span>Active: <span style="color: var(--accent); font-weight:600;">${activeDownloads.length}</span> · Completed: ${completedCount}</span>
        <span class="aggregate-speed">${formatSpeed(aggSpeed)} Total</span>
      `;
    }
  }

  private sendTaskAction(id: string, action: string, deleteFile: boolean = false) {
    if (action === "remove") {
      this.downloads = this.downloads.filter((d) => d.id !== id);
      this.updateAllCounters();
      this.renderTasksListOnly();
    }
    if (this.port) {
      this.port.postMessage({
        type: "task_action",
        id,
        action,
        delete_file: deleteFile,
        req_id: crypto.randomUUID(),
      });
    }
  }

  private async loadSettings() {
    const data = await chrome.storage.local.get([
      "edm_refresh_rate",
      "edm_theme",
      "edm_palette",
      "edm_ws_token",
      "edm_interception_enabled",
    ]);
    if (data.edm_refresh_rate) {
      this.refreshRateMs = parseInt(data.edm_refresh_rate, 10);
    }
    if (data.edm_palette) {
      document.documentElement.setAttribute("data-palette", data.edm_palette);
    }
    if (data.edm_theme) {
      document.documentElement.setAttribute("data-theme", data.edm_theme);
    }
    this.interceptionEnabled = data.edm_interception_enabled !== false;

    if (data.edm_ws_token && data.edm_ws_token.length >= 32 && !data.edm_ws_token.startsWith("ed0000000000")) {
      this.token = data.edm_ws_token;
    } else {
      // Auto-detect token silently from desktop app
      this.detectTokenSilently();
    }
  }

  private async detectTokenSilently() {
    // 1. Try native messaging first
    try {
      const nmhToken = await new Promise<string | null>((resolve) => {
        chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_token" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.token) return resolve(null);
          resolve(resp.token);
        });
      });
      if (nmhToken && nmhToken.length >= 32) {
        this.token = nmhToken;
        await chrome.storage.local.set({ edm_ws_token: nmhToken });
        chrome.runtime.sendMessage({ action: "update_token", token: nmhToken });
        const input = document.getElementById("popupWsTokenInput") as HTMLInputElement;
        if (input) input.value = nmhToken;
        return;
      }
    } catch {}

    // 2. Try HTTP loopback
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
            this.token = data.token;
            await chrome.storage.local.set({ edm_ws_token: data.token });
            chrome.runtime.sendMessage({ action: "update_token", token: data.token });
            const input = document.getElementById("popupWsTokenInput") as HTMLInputElement;
            if (input) input.value = data.token;
            return;
          }
        }
      } catch {}
    }

    chrome.runtime.sendMessage({ action: "auto_detect_token" }, (resp) => {
      if (resp && resp.ok && resp.token) {
        this.token = resp.token;
        const input = document.getElementById("popupWsTokenInput") as HTMLInputElement;
        if (input) input.value = resp.token;
      }
    });
  }

  private bindHeaderNav() {
    const openEdmBtn = document.getElementById("openEdmBtn");
    if (openEdmBtn) {
      openEdmBtn.addEventListener("click", () => {
        this.connectionState = "waking";
        this.updateConnectionPill();
        if (this.port) {
          this.port.postMessage({ type: "wake_desktop", show_window: true });
        } else {
          chrome.runtime.sendMessage({ action: "wake_desktop", show_window: true });
        }
      });
    }

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab") as any;
        if (tab) {
          this.activeTab = tab;
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.render();
        }
      });
    });
  }

  private updateConnectionPill() {
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
    if (this.connectionState === "connected") {
      if (this.lifecycleState === "listener_sleep" || this.lifecycleState === "warm") {
        dot.classList.add("dot-asleep");
        text.innerText = "Connected (sleeping)";
      } else {
        dot.classList.add("dot-connected");
        text.innerText = "Connected";
      }
    } else if (this.connectionState === "waking") {
      dot.classList.add("dot-waking");
      text.innerText = "Waking...";
    } else if (this.connectionState === "connecting" || this.connectionState === "reconnecting") {
      dot.classList.add("dot-connecting");
      text.innerText = "Connecting...";
    } else {
      dot.classList.add("dot-asleep");
      text.innerText = "Asleep, wakes automatically";
    }
  }

  private render() {
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
  private renderTasksTab(): string {
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

        ${
          this.isAddFormOpen
            ? `
          <div class="settings-group" style="margin-top: 4px; padding: 8px;">
            <div style="font-weight: 600; font-size: 11px; margin-bottom: 4px;">Add New Download</div>
            <input type="text" id="newUrlInput" placeholder="https://example.com/file.mp4" value="${escapeHtml(this.newUrlInput)}" style="width: 100%; margin-bottom: 6px;">
            <input type="text" id="newFileNameInput" placeholder="File name (optional, e.g. video.mp4)" value="${escapeHtml(this.newFileNameInput)}" style="width: 100%; margin-bottom: 6px;">
            <div style="display: flex; justify-content: flex-end; gap: 6px;">
              <button id="cancelAddBtn" class="btn-3d">Cancel</button>
              <button id="startAddBtn" class="btn-3d btn-primary">Start Download</button>
            </div>
          </div>
        `
            : ""
        }

        <div class="aggregate-strip">
          <span>Active: <span style="color: #60A5FA; font-weight:600;">${activeDownloads.length}</span> · Completed: ${completedCount}</span>
          <span class="aggregate-speed">${formatSpeed(aggSpeed)} Total</span>
        </div>
      </div>

      <div id="tasksListContainer" class="downloads-list">
        ${this.renderTasksListHtml()}
      </div>
    `;
  }

  private renderTasksListHtml(): string {
    const filtered = this.downloads.filter((d) => {
      const matchesSearch =
        d.filename.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        d.url.toLowerCase().includes(this.searchQuery.toLowerCase());
      const matchesFilter =
        this.taskFilter === "all" ||
        (this.taskFilter === "active" && (d.state === "downloading" || d.state === "queued" || d.state === "connecting")) ||
        (this.taskFilter === "completed" && d.state === "completed") ||
        (this.taskFilter === "failed" && (d.state === "failed" || d.state === "cancelled"));
      return matchesSearch && matchesFilter;
    });

    if (filtered.length === 0) {
      if (this.connectionState === "connection_failed" || this.connectionState === "application_not_running") {
        return `
          <div class="empty-state">
            <div class="empty-icon">🔌</div>
            <div style="font-weight: 600; color: #F87171;">EDM Desktop App Not Reachable</div>
            <div style="font-size: 11px; max-width: 300px;">Please ensure the EDM Desktop application or Native Host is running on your system.</div>
            <button id="retryConnectBtn" class="btn-3d btn-primary" style="margin-top: 8px;">Retry Connection</button>
          </div>
        `;
      }

      return `
        <div class="empty-state">
          <div class="empty-icon">📥</div>
          <div style="font-weight: 600;">No downloads found</div>
          <div style="font-size: 11px;">Downloads added in browser or EDM desktop will show here live.</div>
        </div>
      `;
    }

    return filtered
      .map((item) => {
        const total = item.size_total || 0;
        const done = item.size_done || 0;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        const isDownloading = item.state === "downloading";
        const isPaused = item.state === "paused";
        const isCompleted = item.state === "completed";
        const isFailed = item.state === "failed" || item.state === "cancelled";

        let catClass = "tile-programs";
        let catSvg = CATEGORY_SVGS.programs;
        const ext = item.filename.split(".").pop()?.toLowerCase() || "";
        if (["mp4", "mkv", "webm", "avi", "mov", "flv", "m4v"].includes(ext)) {
          catClass = "tile-video";
          catSvg = CATEGORY_SVGS.video;
        } else if (["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma"].includes(ext)) {
          catClass = "tile-music";
          catSvg = CATEGORY_SVGS.music;
        } else if (["zip", "rar", "7z", "tar", "gz", "iso", "bin", "7zip"].includes(ext)) {
          catClass = "tile-compressed";
          catSvg = CATEGORY_SVGS.compressed;
        } else if (["pdf", "doc", "docx", "txt", "xlsx", "pptx", "epub", "csv"].includes(ext)) {
          catClass = "tile-document";
          catSvg = CATEGORY_SVGS.document;
        }

        let metaHtml = "";
        if (isDownloading) {
          metaHtml = `
            <span>${total > 0 ? `${formatBytes(done)} / ${formatBytes(total)} (${pct}%)` : `${formatBytes(done)}`}</span>
            <span>•</span>
            <span style="color: var(--accent); font-weight: 600;">${formatSpeed(item.speed_bytes_per_sec)}</span>
            <span>•</span>
            <span>${formatEta(total - done, item.speed_bytes_per_sec)}</span>
          `;
        } else if (isCompleted) {
          metaHtml = `
            <span>${formatBytes(done || total)}</span>
            <span>•</span>
            <span>${escapeHtml(item.category || "General")}</span>
            <span>•</span>
            <span style="color: #34D399; font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">
              <span style="display: inline-block; width: 11px; height: 11px;">${SVG_ICONS.check}</span> Finished
            </span>
          `;
        } else if (isPaused) {
          metaHtml = `
            <span>${total > 0 ? `${formatBytes(done)} / ${formatBytes(total)} (${pct}%)` : `${formatBytes(done)}`}</span>
            <span>•</span>
            <span style="color: #FBBF24; font-weight: 600;">Paused</span>
          `;
        } else {
          metaHtml = `
            <span>${formatBytes(done)}</span>
            <span>•</span>
            <span style="color: #F87171; font-weight: 600;">Failed</span>
          `;
        }

        let actionsHtml = "";
        if (isDownloading) {
          actionsHtml = `
            <button class="btn-icon-3d act-pause" data-id="${escapeHtml(item.id)}" title="Pause Download">${SVG_ICONS.pause}</button>
            <button class="btn-icon-3d btn-icon-danger act-cancel" data-id="${escapeHtml(item.id)}" title="Cancel Download">${SVG_ICONS.cancel}</button>
          `;
        } else if (isPaused) {
          actionsHtml = `
            <button class="btn-icon-3d btn-icon-success act-resume" data-id="${escapeHtml(item.id)}" title="Resume Download">${SVG_ICONS.play}</button>
            <button class="btn-icon-3d btn-icon-danger act-cancel" data-id="${escapeHtml(item.id)}" title="Cancel Download">${SVG_ICONS.cancel}</button>
          `;
        } else if (isCompleted) {
          actionsHtml = `
            <button class="btn-icon-3d act-open-file" data-id="${escapeHtml(item.id)}" title="Open File">${SVG_ICONS.openFile}</button>
            <button class="btn-icon-3d act-open-folder" data-id="${escapeHtml(item.id)}" title="Open Folder">${SVG_ICONS.openFolder}</button>
          `;
        } else if (isFailed) {
          actionsHtml = `
            <button class="btn-icon-3d btn-icon-primary act-retry" data-id="${escapeHtml(item.id)}" title="Retry Download">${SVG_ICONS.retry}</button>
          `;
        }

        actionsHtml += `
          <button class="btn-icon-3d act-copy" data-url="${escapeHtml(item.url || item.filename)}" title="Copy URL">${SVG_ICONS.copy}</button>
          <button class="btn-icon-3d btn-icon-danger act-delete" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.filename)}" title="Remove">${SVG_ICONS.trash}</button>
        `;

        return `
          <div class="download-card ${isCompleted ? 'card-completed' : 'card-downloading'}" data-id="${escapeHtml(item.id)}">
            <div class="card-inner">
              <div class="card-icon-tile ${catClass}">
                ${catSvg}
              </div>
              <div class="card-content">
                <div class="card-title-row">
                  <div class="file-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
                </div>
                <div class="card-meta-row">
                  ${metaHtml}
                </div>
              </div>
              <div class="card-actions-cluster">
                ${actionsHtml}
              </div>
            </div>
            ${isDownloading ? `<div class="card-progress-border" style="width: ${pct}%;"></div>` : ''}
          </div>
        `;
      })
      .join("");
  }

  private renderTasksListOnly() {
    const container = document.getElementById("tasksListContainer");
    if (!container) return;
    container.innerHTML = this.renderTasksListHtml();
    this.attachCardActions();
  }

  private attachTasksEvents() {
    // Filter pills
    document.querySelectorAll(".filter-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        this.taskFilter = pill.getAttribute("data-filter") as any;
        document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        this.renderTasksListOnly();
      });
    });

    // Search input
    const searchInp = document.getElementById("taskSearch") as HTMLInputElement;
    if (searchInp) {
      searchInp.addEventListener("input", (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value;
        this.renderTasksListOnly();
      });
    }

    // Toggle Add form
    const toggleAddBtn = document.getElementById("toggleAddBtn");
    if (toggleAddBtn) {
      toggleAddBtn.addEventListener("click", () => {
        this.isAddFormOpen = !this.isAddFormOpen;
        this.render();
      });
    }

    // Cancel Add form
    const cancelAddBtn = document.getElementById("cancelAddBtn");
    if (cancelAddBtn) {
      cancelAddBtn.addEventListener("click", () => {
        this.isAddFormOpen = false;
        this.newUrlInput = "";
        this.newFileNameInput = "";
        this.render();
      });
    }

    // Start Add
    const startAddBtn = document.getElementById("startAddBtn");
    if (startAddBtn) {
      startAddBtn.addEventListener("click", () => {
        const urlInp = document.getElementById("newUrlInput") as HTMLInputElement;
        const fileInp = document.getElementById("newFileNameInput") as HTMLInputElement;
        const url = urlInp?.value.trim();
        const filename = fileInp?.value.trim();
        if (!url) return;

        if (this.port) {
          this.port.postMessage({
            type: "create_task",
            url,
            filename: filename || undefined,
          });
        }

        this.isAddFormOpen = false;
        this.newUrlInput = "";
        this.newFileNameInput = "";
        this.render();
      });
    }

    // Retry connection button
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

  private attachCardActions() {
    // Pause
    document.querySelectorAll(".act-pause").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "pause");
        }
      });
    });

    // Resume
    document.querySelectorAll(".act-resume").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "resume");
        }
      });
    });

    // Cancel
    document.querySelectorAll(".act-cancel").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id && confirm("Are you sure you want to cancel this download?")) {
          this.sendTaskAction(id, "cancel");
        }
      });
    });

    // Retry
    document.querySelectorAll(".act-retry").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) {
          this.sendTaskAction(id, "resume");
        }
      });
    });

    // Open File
    document.querySelectorAll(".act-open-file").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) this.sendTaskAction(id, "open_file");
      });
    });

    // Open Folder
    document.querySelectorAll(".act-open-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) this.sendTaskAction(id, "open_folder");
      });
    });

    // Copy URL
    document.querySelectorAll(".act-copy").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const url = btn.getAttribute("data-url");
        if (url) {
          navigator.clipboard.writeText(url);
          const orig = btn.innerHTML;
          btn.innerHTML = "✓";
          setTimeout(() => { btn.innerHTML = orig; }, 1200);
        }
      });
    });

    // Remove from list
    document.querySelectorAll(".act-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        const filename = btn.getAttribute("data-name") || "Download";
        if (id) {
          this.openDeleteModal(id, filename);
        }
      });
    });
  }

  private openDeleteModal(id: string, filename: string) {
    this.deleteModalTarget = { id, filename };
    let modal = document.getElementById("deleteConfirmModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "deleteConfirmModal";
      modal.className = "modal-overlay";
      document.body.appendChild(modal);
    }
    modal.style.display = "flex";
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-title">Remove Download</div>
        <div class="modal-desc">
          Are you sure you want to remove <strong>${escapeHtml(filename)}</strong>?
        </div>
        <div class="modal-buttons">
          <button id="modalCancelBtn" class="btn-3d">Cancel</button>
          <button id="modalRemoveListBtn" class="btn-3d">Remove from list</button>
          <button id="modalRecycleFileBtn" class="btn-3d btn-danger">Recycle File</button>
        </div>
      </div>
    `;

    document.getElementById("modalCancelBtn")?.addEventListener("click", () => {
      this.closeDeleteModal();
    });
    document.getElementById("modalRemoveListBtn")?.addEventListener("click", () => {
      if (this.deleteModalTarget) {
        this.sendTaskAction(this.deleteModalTarget.id, "remove", false);
      }
      this.closeDeleteModal();
    });
    document.getElementById("modalRecycleFileBtn")?.addEventListener("click", () => {
      if (this.deleteModalTarget) {
        this.sendTaskAction(this.deleteModalTarget.id, "remove", true);
      }
      this.closeDeleteModal();
    });
  }

  private closeDeleteModal() {
    this.deleteModalTarget = null;
    const modal = document.getElementById("deleteConfirmModal");
    if (modal) {
      modal.style.display = "none";
      modal.innerHTML = "";
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2. UNIFIED SETTINGS TAB
  // ─────────────────────────────────────────────────────────────
  private renderSettingsTab(): string {
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
              <option value="1000" ${this.refreshRateMs === 1000 ? "selected" : ""}>1000 ms (Relaxed)</option>
              <option value="2000" ${this.refreshRateMs === 2000 ? "selected" : ""}>2000 ms (Battery Saver)</option>
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

  private attachSettingsEvents() {
    const tokenInput = document.getElementById("popupWsTokenInput") as HTMLInputElement;
    const btnSave = document.getElementById("popupBtnSaveToken");
    const btnAutoDetect = document.getElementById("popupBtnAutoDetectToken") as HTMLButtonElement;
    const tokenFeedback = document.getElementById("popupTokenFeedback");

    const btnCheckUpdate = document.getElementById("popupBtnCheckUpdate") as HTMLButtonElement;
    const btnReloadExt = document.getElementById("popupBtnReloadExt") as HTMLButtonElement;
    const updateFeedback = document.getElementById("popupUpdateFeedback");

    // Interception toggle
    const toggleInterception = document.getElementById("popupInterceptionToggle") as HTMLInputElement;
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

        // 1. Try Native Messaging Host com.edm.nmh first
        let detected: string | null = null;
        try {
          detected = await new Promise<string | null>((resolve) => {
            chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_token" }, (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.token) return resolve(null);
              resolve(resp.token);
            });
          });
        } catch {}

        // 2. Try direct loopback fetch from popup context
        if (!detected) {
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
                  detected = data.token;
                  break;
                }
              }
            } catch {}
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
            }, 3000);
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
              }, 3000);
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
              updateFeedback.textContent = "Extension is up to date (v0.0.4).";
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

    // Test Connection
    const testBtn = document.getElementById("testConnBtn");
    if (testBtn) {
      testBtn.addEventListener("click", () => {
        testBtn.innerText = "Pinging...";
        const token = this.token || (tokenInput?.value.trim());
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
          }, 2000);
        });
      });
    }

    // Rate
    const rateSelect = document.getElementById("rateSelect") as HTMLSelectElement;
    if (rateSelect) {
      rateSelect.addEventListener("change", async () => {
        const val = parseInt(rateSelect.value, 10);
        this.refreshRateMs = val;
        await chrome.storage.local.set({ edm_refresh_rate: val });
      });
    }

    // Theme
    const themeSelect = document.getElementById("themeSelect") as HTMLSelectElement;
    if (themeSelect) {
      themeSelect.addEventListener("change", async () => {
        const val = themeSelect.value;
        document.documentElement.setAttribute("data-theme", val);
        await chrome.storage.local.set({ edm_theme: val });
      });
    }

    // Notification toggles
    const notifyComp = document.getElementById("notifyCompleteToggle") as HTMLInputElement;
    const notifyFail = document.getElementById("notifyFailToggle") as HTMLInputElement;
    if (notifyComp && notifyFail) {
      const saveNotif = async () => {
        await chrome.storage.local.set({
          edm_settings: {
            notifyComplete: notifyComp.checked,
            notifyFail: notifyFail.checked,
          },
        });
      };
      notifyComp.addEventListener("change", saveNotif);
      notifyFail.addEventListener("change", saveNotif);
    }
  }
}

// Instantiate on popup load
document.addEventListener("DOMContentLoaded", () => {
  (window as any).__app = new PopupController();
});
