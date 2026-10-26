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

interface SniffedResource {
  url: string;
  title: string;
  type: string;
  format: string;
  size?: string;
}

interface SniffedImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  format: string;
}

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
  if (speedBps <= 0 || remainingBytes <= 0) return "Calculating...";
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
  private activeTab: "tasks" | "resources" | "images" | "advanced" | "settings" = "tasks";
  private taskFilter: "all" | "active" | "completed" | "failed" = "all";
  private searchQuery: string = "";
  private isAddFormOpen: boolean = false;
  private newUrlInput: string = "";
  private newFileNameInput: string = "";

  private downloads: DownloadItem[] = [];
  private resources: SniffedResource[] = [];
  private images: SniffedImage[] = [];
  private connectionState: string = "connecting";
  private latencyMs: number = 0;
  private auditLogs: string[] = ["Popup initialized"];

  private pollInterval: any = null;
  private refreshRateMs: number = 500;
  private port: chrome.runtime.Port | null = null;

  constructor() {
    this.init();
  }

  private async init() {
    this.bindHeaderNav();
    this.connectPort();
    await this.loadSettings();
    await this.sniffPageContent();
    this.render();
  }

  private connectPort() {
    try {
      this.port = chrome.runtime.connect({ name: "popup" });
      this.port.onMessage.addListener((msg) => {
        if (msg.type === "snapshot") {
          this.connectionState = msg.connectionStatus || "disconnected";
          this.updateConnectionPill();
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
            const badge = document.getElementById("tasksBadge");
            if (badge) {
              const activeCount = this.downloads.filter(d => d.state === "downloading").length;
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

  private sendTaskAction(id: string, action: string) {
    if (this.port) {
      this.port.postMessage({ type: "task_action", id, action });
    }
  }

  private async loadSettings() {
    const data = await chrome.storage.local.get(["edm_refresh_rate", "edm_theme"]);
    if (data.edm_refresh_rate) {
      this.refreshRateMs = parseInt(data.edm_refresh_rate, 10);
    }
    if (data.edm_theme) {
      document.documentElement.setAttribute("data-theme", data.edm_theme);
    }
  }

  private bindHeaderNav() {
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
    pill.title = "Click to configure WebSocket connection / token";
    pill.onclick = () => {
      chrome.runtime.openOptionsPage();
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

  private async refreshDownloads() {
    // Downloads are pushed live from background port via WebSocket snapshot!
  }

  private async sniffPageContent() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      chrome.tabs.sendMessage(tab.id, { action: "get_page_resources" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        this.resources = res.resources || [];
        const badge = document.getElementById("resourcesBadge");
        if (badge) badge.innerText = String(this.resources.length);
        if (this.activeTab === "resources") this.render();
      });

      chrome.tabs.sendMessage(tab.id, { action: "get_page_images" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        this.images = res.images || [];
        const badge = document.getElementById("imagesBadge");
        if (badge) badge.innerText = String(this.images.length);
        if (this.activeTab === "images") this.render();
      });
    } catch {}
  }

  private render() {
    const app = document.getElementById("app");
    if (!app) return;

    switch (this.activeTab) {
      case "tasks":
        app.innerHTML = this.renderTasksTab();
        this.attachTasksEvents();
        break;
      case "resources":
        app.innerHTML = this.renderResourcesTab();
        this.attachResourcesEvents();
        break;
      case "images":
        app.innerHTML = this.renderImagesTab();
        this.attachImagesEvents();
        break;
      case "advanced":
        app.innerHTML = this.renderAdvancedTab();
        this.attachAdvancedEvents();
        break;
      case "settings":
        app.innerHTML = this.renderSettingsTab();
        this.attachSettingsEvents();
        break;
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

        let catClass = "cat-programs";
        let catLetter = "⚙";
        const ext = item.filename.split(".").pop()?.toLowerCase() || "";
        if (["mp4", "mkv", "webm", "avi"].includes(ext)) {
          catClass = "cat-video";
          catLetter = "🎬";
        } else if (["mp3", "flac", "wav", "m4a"].includes(ext)) {
          catClass = "cat-music";
          catLetter = "🎵";
        } else if (["zip", "rar", "7z", "tar", "gz", "iso"].includes(ext)) {
          catClass = "cat-compressed";
          catLetter = "📦";
        } else if (["pdf", "doc", "docx", "txt"].includes(ext)) {
          catClass = "cat-documents";
          catLetter = "📄";
        }

        return `
        <div class="download-card" data-id="${escapeHtml(item.id)}">
          <div class="card-header">
            <div class="card-identity">
              <div class="cat-icon ${catClass}">${catLetter}</div>
              <div style="min-width: 0; flex: 1;">
                <div class="file-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
                <div class="file-meta">${escapeHtml(item.category)} • ${escapeHtml(item.save_dir || "Downloads")}</div>
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
              ${isDownloading ? `${formatSpeed(item.speed_bytes_per_sec)} · ${formatEta(total - done, item.speed_bytes_per_sec)}` : isCompleted ? "Finished" : isPaused ? "Paused" : escapeHtml(item.state)}
            </span>
          </div>

          <div class="card-actions">
            ${
              isDownloading
                ? `<button class="btn-3d act-pause" data-id="${escapeHtml(item.id)}" title="Pause Download">⏸ Pause</button>`
                : isPaused
                ? `<button class="btn-3d act-resume" data-id="${escapeHtml(item.id)}" style="color: #34D399;" title="Resume Download">▶ Resume</button>`
                : ""
            }
            ${
              isCompleted
                ? `
              <button class="btn-3d act-open-file" data-id="${escapeHtml(item.id)}" title="Open File">📄 Open</button>
              <button class="btn-3d act-open-folder" data-id="${escapeHtml(item.id)}" title="Open Containing Folder">📁 Folder</button>
            `
                : ""
            }
            ${
              isFailed
                ? `<button class="btn-3d act-retry" data-id="${escapeHtml(item.id)}" style="color: #38BDF8;" title="Retry Download">↻ Retry</button>`
                : ""
            }
            ${
              !isCompleted
                ? `<button class="btn-3d act-cancel" data-id="${escapeHtml(item.id)}" style="color: #F87171;" title="Cancel Download">✕ Cancel</button>`
                : ""
            }
            <button class="btn-3d act-copy" data-url="${escapeHtml(item.url)}" title="Copy URL">📋</button>
            <button class="btn-3d act-delete" data-id="${escapeHtml(item.id)}" title="Remove from list">🗑</button>
          </div>
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
        if (id) {
          this.sendTaskAction(id, "remove");
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 2. RESOURCES TAB (Active Page Media Sniffer)
  // ─────────────────────────────────────────────────────────────
  private renderResourcesTab(): string {
    if (this.resources.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div style="font-weight: 600;">No downloadable media detected</div>
          <div style="font-size: 11px; max-width: 280px;">EDM sniffs videos, HLS streams, audio and file links on the current tab.</div>
          <button id="rescanResourcesBtn" class="btn-3d btn-primary" style="margin-top: 8px;">Rescan Page</button>
        </div>
      `;
    }

    return `
      <div style="padding: 10px 12px; background: var(--bg-header); border-bottom: 1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size: 11px; font-weight: 600;">Detected Media Resources (${this.resources.length})</span>
        <button id="rescanResourcesBtn" class="btn-3d">↻ Rescan</button>
      </div>
      <div class="resource-list">
        ${this.resources
          .map(
            (res, idx) => `
          <div class="resource-card">
            <div style="min-width: 0; flex: 1;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="pro-badge" style="background:#181818; border-color:var(--border-strong); color:var(--text-primary); font-size:9px;">${escapeHtml(res.format)}</span>
                <span class="file-name" style="font-size:11px;" title="${escapeHtml(res.url)}">${escapeHtml(res.title)}</span>
              </div>
              <div class="file-meta" style="margin-top:2px;">${escapeHtml(res.url)}</div>
            </div>
            <button class="btn-3d btn-primary act-download-res" data-idx="${idx}" style="shrink:0;">Download</button>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  private attachResourcesEvents() {
    const rescanBtn = document.getElementById("rescanResourcesBtn");
    if (rescanBtn) {
      rescanBtn.addEventListener("click", () => {
        this.sniffPageContent();
        this.render();
      });
    }

    document.querySelectorAll(".act-download-res").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
        const res = this.resources[idx];
        if (res) {
          await this.sendHost({
            type: "add_download",
            url: res.url,
            filename: `${res.title}.${res.format.toLowerCase()}`,
            source: "resource_sniffer",
          });
          this.activeTab = "tasks";
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          document.querySelector('[data-tab="tasks"]')?.classList.add("active");
          await this.refreshDownloads();
          this.render();
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 3. IMAGES TAB
  // ─────────────────────────────────────────────────────────────
  private renderImagesTab(): string {
    if (this.images.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">🖼</div>
          <div style="font-weight: 600;">No images found on page</div>
          <div style="font-size: 11px;">Navigate to a web page with images to sniff and extract them.</div>
          <button id="rescanImagesBtn" class="btn-3d btn-primary" style="margin-top: 8px;">Rescan Page</button>
        </div>
      `;
    }

    return `
      <div style="padding: 10px 12px; background: var(--bg-header); border-bottom: 1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size: 11px; font-weight: 600;">Page Images (${this.images.length})</span>
        <button id="downloadAllImagesBtn" class="btn-3d btn-primary">Download All (${this.images.length})</button>
      </div>
      <div class="images-grid">
        ${this.images
          .map(
            (img, idx) => `
          <div class="image-tile">
            <img src="${sanitizeUrl(img.url)}" alt="${escapeHtml(img.alt)}" loading="lazy">
            <div class="image-tile-overlay">
              <span style="font-size:9.5px; font-weight:600; color:#fff; text-shadow:0 1px 2px #000;">${img.width}×${img.height}</span>
              <button class="btn-3d btn-primary act-download-img" data-idx="${idx}" style="margin-top:4px; font-size:10px; padding:2px 6px;">Grab</button>
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  private attachImagesEvents() {
    const rescanBtn = document.getElementById("rescanImagesBtn");
    if (rescanBtn) {
      rescanBtn.addEventListener("click", () => {
        this.sniffPageContent();
        this.render();
      });
    }

    const downloadAllBtn = document.getElementById("downloadAllImagesBtn");
    if (downloadAllBtn) {
      downloadAllBtn.addEventListener("click", async () => {
        for (const img of this.images) {
          await this.sendHost({
            type: "add_download",
            url: img.url,
            filename: img.alt.replace(/[\\/:*?"<>|]/g, "_") + ".jpg",
            source: "image_sniffer",
          });
        }
        this.activeTab = "tasks";
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelector('[data-tab="tasks"]')?.classList.add("active");
        await this.refreshDownloads();
        this.render();
      });
    }

    document.querySelectorAll(".act-download-img").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
        const img = this.images[idx];
        if (img) {
          await this.sendHost({
            type: "add_download",
            url: img.url,
            filename: img.alt.replace(/[\\/:*?"<>|]/g, "_") + ".jpg",
            source: "image_sniffer",
          });
          this.activeTab = "tasks";
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          document.querySelector('[data-tab="tasks"]')?.classList.add("active");
          await this.refreshDownloads();
          this.render();
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 4. ADVANCED TAB
  // ─────────────────────────────────────────────────────────────
  private renderAdvancedTab(): string {
    return `
      <div class="advanced-pane">
        <div class="settings-group">
          <div class="settings-group-title">Native Messaging Host Diagnostics</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Host Channel Status</div>
              <div class="setting-desc">Chromium stdio length-prefixed IPC pipe</div>
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
              <div class="setting-desc">Registered Native Messaging Host manifest</div>
            </div>
            <span style="font-family:monospace; font-size:10.5px;">com.edm.nmh</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Fallback HTTP Bridge</div>
              <div class="setting-desc">Local loopback interface for zero-friction dev</div>
            </div>
            <span style="font-family:monospace; font-size:10.5px; color:#34D399;">http://127.0.0.1:8998</span>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">Engine Session Telemetry</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Protocol Version</div>
              <div class="setting-desc">EDM Desktop v0.0.1 compatibility</div>
            </div>
            <span style="font-family:monospace; font-weight:600;">Protocol v1</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Total Managed Downloads</div>
              <div class="setting-desc">SQLite persistent database record count</div>
            </div>
            <span style="font-family:monospace; font-weight:600;">${this.downloads.length} Items</span>
          </div>
          <button id="sendPingBtn" class="btn-3d btn-primary" style="margin-top: 4px;">⚡ Send IPC Ping Benchmark</button>
        </div>
      </div>
    `;
  }

  private attachAdvancedEvents() {
    const pingBtn = document.getElementById("sendPingBtn");
    if (pingBtn) {
      pingBtn.addEventListener("click", async () => {
        const t0 = performance.now();
        await this.sendHost({ type: "ping" });
        this.latencyMs = Math.round(performance.now() - t0);
        this.render();
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 5. SETTINGS TAB
  // ─────────────────────────────────────────────────────────────
  private renderSettingsTab(): string {
    return `
      <div class="settings-pane">
        <div class="settings-group">
          <div class="settings-group-title">Desktop Connection & Bridge</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Desktop Connection</div>
              <div class="setting-desc">Connected to EDM core engine</div>
            </div>
            <button id="testConnBtn" class="btn-3d">Test Connection</button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Auto-Reconnect</div>
              <div class="setting-desc">Automatically retry host connection</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="autoReconnectToggle" checked>
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">Interface & Appearance</div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Telemetry Refresh Rate</div>
              <div class="setting-desc">Live progress update frequency</div>
            </div>
            <select id="rateSelect">
              <option value="250">250 ms (Real-time)</option>
              <option value="500" selected>500 ms (Standard)</option>
              <option value="1000">1000 ms (Relaxed)</option>
              <option value="2000">2000 ms (Battery Saver)</option>
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
      </div>
    `;
  }

  private attachSettingsEvents() {
    // Test Connection
    const testBtn = document.getElementById("testConnBtn");
    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        testBtn.innerText = "Pinging...";
        const resp = await this.sendHost({ type: "ping" });
        if (resp && resp.type === "pong") {
          testBtn.innerText = `Connected (${this.latencyMs}ms)`;
          testBtn.style.color = "#34D399";
        } else {
          testBtn.innerText = "Failed";
          testBtn.style.color = "#F87171";
        }
        setTimeout(() => {
          testBtn.innerText = "Test Connection";
          testBtn.style.color = "";
        }, 2000);
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
