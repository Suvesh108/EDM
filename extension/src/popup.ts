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
  private activeTab: "tasks" | "media" | "grabber" | "settings" = "tasks";
  private taskFilter: "all" | "active" | "completed" | "failed" = "all";
  private searchQuery: string = "";
  private isAddFormOpen: boolean = false;
  private newUrlInput: string = "";
  private newFileNameInput: string = "";
  private pageResources: any[] = [];
  private selectedGrabberUrls: Set<string> = new Set();
  private grabberFilter: string = "all";

  private downloads: DownloadItem[] = [];
  private connectionState: string = "connecting";
  private lifecycleState: string = "active";
  private nmhHealth: { ok: boolean; reason?: string } = { ok: true };
  private diagnosticsReport: any = null;
  private isRepairing: boolean = false;
  private latencyMs: number = 0;
  private token: string = "";
  private interceptionEnabled: boolean = true;
  private mediaMaster: boolean = true;
  private mediaYouTube: boolean = true;
  private mediaOtherSites: boolean = true;
  private hiddenSites: string[] = [];
  private auditLogs: string[] = ["Popup initialized"];
  private currentVersion: string = "0.0.7";
  private expectedVersion: string = "0.0.7";
  private updateStatus: string = "latest";
  private detectedBrowser: string = "browser";

  private pollInterval: any = null;
  private refreshRateMs: number = 500;
  private port: chrome.runtime.Port | null = null;
  private deleteModalTarget: { id: string; filename: string } | null = null;

  constructor() {
    try {
      this.currentVersion = chrome.runtime.getManifest().version;
    } catch {}
    chrome.storage.local.get(["expected_extension_version", "edm_update_status"], (res) => {
      if (res && res.expected_extension_version) {
        this.expectedVersion = res.expected_extension_version;
      }
      if (res && res.edm_update_status) {
        this.updateStatus = res.edm_update_status;
      }
    });
    this.init();
  }

  private async init() {
    this.bindHeaderNav();
    this.connectPort();
    await this.loadSettings();
    await this.loadActiveTabResources();
    this.render();
  }

  private async loadActiveTabResources() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs || !tabs[0] || !tabs[0].id) return;
        const tab = tabs[0];
        const tabId = tab.id!;
        const tabUrl = tab.url || "";

        // 1. Fetch sniffed media from session storage
        let sniffedMedia: any[] = [];
        try {
          const res = await new Promise<any>((resolve) => {
            chrome.runtime.sendMessage({ action: "get_sniffed_media", tabId }, resolve);
          });
          if (res && res.ok && Array.isArray(res.media)) {
            sniffedMedia = res.media;
          }
        } catch {}

        // 2. Fetch page links with scripting fallback
        const pageLinks = await this.grabLinksWithFallback(tabId);

        // 3. Extractor probe if video site
        let probedMedia: any[] = [];
        if (tabUrl.includes("youtube.com") || tabUrl.includes("youtu.be") || tabUrl.includes("vimeo.com")) {
          try {
            const probeRes = await new Promise<any>((resolve) => {
              chrome.runtime.sendMessage({ action: "probe_page_media", url: tabUrl }, resolve);
            });
            if (probeRes && probeRes.ok && Array.isArray(probeRes.variants)) {
              const cleanTitle = (tab.title || "Video Stream").replace(" - YouTube", "").trim();
              probedMedia = probeRes.variants.map((v: any) => ({
                url: v.url,
                title: `${cleanTitle} (${v.quality || v.resolution || 'Best'})`,
                type: v.media_type === "audio" ? "audio" : "video",
                size: v.bitrate ? Math.round(v.bitrate / 8) : 0,
                format: v.media_type || "mp4",
              }));
            }
          } catch {}
        }

        const combined = [...probedMedia, ...sniffedMedia, ...pageLinks];
        const seen = new Set<string>();
        this.pageResources = combined.filter((r) => {
          if (!r.url || seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        });

        if (this.activeTab === "media" || this.activeTab === "grabber") {
          this.render();
        }
      });
    } catch {}
  }

  private async grabLinksWithFallback(tabId: number): Promise<any[]> {
    try {
      const res = await new Promise<any>((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: "grab_page_links" }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });
      if (res && Array.isArray(res.resources) && res.resources.length > 0) {
        return res.resources;
      }
    } catch {}

    try {
      if (chrome.scripting && chrome.scripting.executeScript) {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const items: any[] = [];
            const seen = new Set<string>();

            // 1. Anchors
            document.querySelectorAll("a[href]").forEach((el) => {
              const a = el as HTMLAnchorElement;
              const href = a.href;
              if (href && !href.startsWith("javascript:") && !href.startsWith("#") && !seen.has(href)) {
                seen.add(href);
                const text = (a.innerText || a.title || href).trim().slice(0, 100);
                const ext = href.split(".").pop()?.split(/[?#]/)[0]?.toLowerCase() || "";
                let type = "link";
                if (["zip", "rar", "7z", "tar", "gz", "iso"].includes(ext)) type = "archive";
                else if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"].includes(ext)) type = "document";
                else if (["exe", "msi", "dmg", "pkg", "deb", "rpm", "apk"].includes(ext)) type = "executable";
                else if (["mp4", "mkv", "webm", "avi", "mov", "mp3", "m4a", "flac"].includes(ext)) type = "video";
                items.push({ url: href, title: text || href, type, size: 0, format: ext.toUpperCase() });
              }
            });

            // 2. Media
            document.querySelectorAll("video, audio, source").forEach((el) => {
              const src = (el as HTMLMediaElement | HTMLSourceElement).src;
              if (src && !src.startsWith("blob:") && !seen.has(src)) {
                seen.add(src);
                items.push({ url: src, title: document.title || "Media File", type: "video", size: 0, format: "MEDIA" });
              }
            });

            return items.slice(0, 150);
          },
        });
        if (injected && injected[0] && Array.isArray(injected[0].result)) {
          return injected[0].result;
        }
      }
    } catch (err) {
      console.debug("[EDM Popup] Fallback script execution:", err);
    }

    return [];
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
          if (msg.nmhHealth) {
            this.nmhHealth = msg.nmhHealth;
          }
          if (msg.diagnosticsReport) {
            this.diagnosticsReport = msg.diagnosticsReport;
          }
          if (msg.currentVersion) {
            this.currentVersion = msg.currentVersion;
          }
          if (msg.browser) {
            this.detectedBrowser = msg.browser;
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
              error_msg: t.error_msg || null,
            }));
            this.updateAllCounters();
            if (this.activeTab === "tasks") {
              this.renderTasksListOnly();
            }
          }
          if (this.activeTab === "diagnostics") {
            this.render();
          }
        } else if (msg.type === "diagnostics_report") {
          if (msg.report) {
            this.diagnosticsReport = msg.report;
            if (this.activeTab === "diagnostics") {
              this.render();
            }
          }
        } else if (msg.type === "repair_result") {
          this.isRepairing = false;
          if (msg.report) {
            this.diagnosticsReport = msg.report;
          }
          if (this.activeTab === "diagnostics") {
            this.render();
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

    // Header badge matches All tasks count so badge, filter chips, and list always agree
    const badge = document.getElementById("tasksBadge");
    if (badge) {
      badge.innerText = String(this.downloads.length);
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
      "media_button_master",
      "media_button_youtube",
      "media_button_other_sites",
      "hidden_sites",
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
    this.mediaMaster = data.media_button_master !== false;
    this.mediaYouTube = data.media_button_youtube !== false;
    this.mediaOtherSites = data.media_button_other_sites !== false;
    this.hiddenSites = data.hidden_sites || [];

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
    pill.title = "Click to view Settings & Diagnostics";
    pill.onclick = () => {
      this.activeTab = "settings";
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelector('[data-tab="settings"]')?.classList.add("active");
      this.render();
      setTimeout(() => {
        document.getElementById("settings-diagnostics-card")?.scrollIntoView({ behavior: "smooth" });
      }, 50);
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
      text.innerText = "Waking EDM...";
      pill.title = "EDM is starting up in the background. Please wait...";
    } else if (this.connectionState === "connecting" || this.connectionState === "reconnecting") {
      dot.classList.add("dot-connecting");
      text.innerText = "Connecting...";
    } else if (!this.nmhHealth.ok) {
      dot.classList.add("dot-failed");
      const err = this.nmhHealth.reason || "Native host not registered";
      text.innerText = err.length > 25 ? `Wake error: ${err.slice(0, 18)}...` : `Wake error: ${err}`;
      pill.title = `NMH Error: ${err}. Click to open Diagnostics & Repair.`;
    } else {
      dot.classList.add("dot-asleep");
      text.innerText = "Asleep, wakes automatically";
      pill.title = "EDM is asleep and wakes automatically on download. Click to view Diagnostics.";
    }
  }

  private render() {
    const app = document.getElementById("app");
    if (!app) return;

    if (this.activeTab === "tasks") {
      app.innerHTML = this.renderTasksTab();
      this.attachTasksEvents();
    } else if (this.activeTab === "media") {
      app.innerHTML = this.renderMediaTab();
      this.attachMediaEvents();
    } else if (this.activeTab === "grabber") {
      app.innerHTML = this.renderGrabberTab();
      this.attachGrabberEvents();
    } else {
      app.innerHTML = this.renderSettingsTab();
      this.attachSettingsEvents();
      this.attachDiagnosticsEvents();
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

    const staleBanner =
      this.connectionState !== "connected"
        ? `
        <div class="stale-notice" style="display: flex; align-items: center; gap: 6px; padding: 6px 10px; margin-bottom: 8px; border-radius: 6px; font-size: 10.5px; font-weight: 500; background: rgba(139, 92, 246, 0.12); border: 1px solid rgba(139, 92, 246, 0.25); color: #C4B5FD;">
          <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #A78BFA;"></span>
          <span>EDM is asleep. Showing last known state (actions disabled until connected).</span>
        </div>
      `
        : "";

    return (
      staleBanner +
      filtered
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
        } else if (item.state === "needs_fresh_link" || item.state === "link_expired") {
          metaHtml = `
            <span>${total > 0 ? `${formatBytes(done)} / ${formatBytes(total)} (${pct}%)` : `${formatBytes(done)}`}</span>
            <span>•</span>
            <span style="color: #F59E0B; font-weight: 600;">Link Expired</span>
          `;
        } else {
          const failReason = item.error_msg
            ? escapeHtml(item.error_msg)
            : "Download failed or link expired";
          metaHtml = `
            <span>${formatBytes(done)}</span>
            <span>•</span>
            <span style="color: #F87171; font-weight: 600;" title="${failReason}">
              Failed${item.error_msg ? `: ${failReason}` : ""}
            </span>
          `;
        }

        const isSyncable = this.connectionState === "connected";
        const disAttr = isSyncable ? "" : "disabled";
        const disStyle = isSyncable ? "" : 'style="opacity: 0.35; pointer-events: none; cursor: not-allowed;"';

        let actionsHtml = "";
        if (isDownloading) {
          actionsHtml = `
            <button class="btn-icon-3d act-pause" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Pause Download">${SVG_ICONS.pause}</button>
            <button class="btn-icon-3d btn-icon-danger act-cancel" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Cancel Download">${SVG_ICONS.cancel}</button>
          `;
        } else if (isPaused) {
          actionsHtml = `
            <button class="btn-icon-3d btn-icon-success act-resume" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Resume Download">${SVG_ICONS.play}</button>
            <button class="btn-icon-3d btn-icon-danger act-cancel" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Cancel Download">${SVG_ICONS.cancel}</button>
          `;
        } else if (isCompleted) {
          actionsHtml = `
            <button class="btn-icon-3d act-open-file" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Open File">${SVG_ICONS.openFile}</button>
            <button class="btn-icon-3d act-open-folder" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Open Folder">${SVG_ICONS.openFolder}</button>
          `;
        } else if (isFailed) {
          actionsHtml = `
            <button class="btn-icon-3d btn-icon-primary act-retry" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Retry Download">${SVG_ICONS.retry}</button>
          `;
        } else if (item.state === "needs_fresh_link" || item.state === "link_expired") {
          actionsHtml = `
            <button class="btn-icon-3d act-refresh-link" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" title="Refresh Expired Link">🔄</button>
          `;
        }

        actionsHtml += `
          <button class="btn-icon-3d act-copy" ${disAttr} ${disStyle} data-url="${escapeHtml(item.url || item.filename)}" title="Copy URL">${SVG_ICONS.copy}</button>
          <button class="btn-icon-3d btn-icon-danger act-delete" ${disAttr} ${disStyle} data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.filename)}" title="Remove">${SVG_ICONS.trash}</button>
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
      .join("")
    );
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

    // Refresh Expired Link
    document.querySelectorAll(".act-refresh-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        const freshUrl = prompt("Enter new/refreshed download URL for this file:");
        if (id && freshUrl && freshUrl.trim().startsWith("http")) {
          chrome.runtime.sendMessage({
            action: "refresh_task",
            task_id: id,
            new_url: freshUrl.trim(),
          });
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
  // MEDIA SNIFFER TAB
  // ─────────────────────────────────────────────────────────────
  private renderMediaTab(): string {
    const mediaResources = this.pageResources.filter((r) => r.type === "video" || r.type === "audio" || r.type === "stream");

    return `
      <div class="tasks-toolbar" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 2px;">Media Detected on Active Tab</div>
          <div style="font-size: 11px; color: #94A3B8;">Direct streams and audio tracks sniffed on this web page.</div>
        </div>
        <button id="btnRescanMedia" class="btn-3d" style="font-size:10.5px; padding:3px 8px;">Refresh</button>
      </div>
      <div class="downloads-list">
        ${
          mediaResources.length === 0
            ? `
          <div class="empty-state">
            <div class="empty-icon">🎬</div>
            <div style="font-weight: 600;">No media detected on this page</div>
            <div style="font-size: 11px; max-width: 280px;">Play a video or audio file on the current tab, then click Refresh.</div>
          </div>
        `
            : mediaResources
                .map(
                  (m, idx) => `
          <div class="download-item">
            <div class="file-icon-box tile-video" style="margin-right: 10px;">
              ${CATEGORY_SVGS.video}
            </div>
            <div class="item-main">
              <div class="file-title" title="${escapeHtml(m.url)}">${escapeHtml(m.title)}</div>
              <div class="item-meta">
                <span>${escapeHtml(m.format || m.quality || (m.type === "audio" ? "Audio" : "Video"))}</span>
                <span>•</span>
                <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(m.url)}</span>
              </div>
            </div>
            <button class="btn-3d btn-primary download-media-btn" data-idx="${idx}" style="padding: 4px 10px; font-size: 11px;">
              Download
            </button>
          </div>
        `
                )
                .join("")
        }
      </div>
    `;
  }

  private attachMediaEvents() {
    const rescanBtn = document.getElementById("btnRescanMedia");
    if (rescanBtn) {
      rescanBtn.addEventListener("click", () => {
        rescanBtn.innerText = "Scanning...";
        this.loadActiveTabResources().then(() => {
          setTimeout(() => {
            if (rescanBtn) rescanBtn.innerText = "Refresh";
          }, 800);
        });
      });
    }

    const mediaResources = this.pageResources.filter((r) => r.type === "video" || r.type === "audio" || r.type === "stream");
    document.querySelectorAll(".download-media-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
        const item = mediaResources[idx];
        if (item) {
          chrome.runtime.sendMessage({
            action: "add_download",
            url: item.url,
            filename: item.title + (item.format ? `.${item.format.toLowerCase()}` : ""),
          });
          this.activeTab = "tasks";
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          document.querySelector('[data-tab="tasks"]')?.classList.add("active");
          this.render();
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GRAB LINKS TAB
  // ─────────────────────────────────────────────────────────────
  private renderGrabberTab(): string {
    const filtered = this.pageResources.filter((r) => {
      if (this.grabberFilter === "all") return true;
      if (this.grabberFilter === "media") return r.type === "video" || r.type === "audio" || r.type === "stream";
      if (this.grabberFilter === "archive") return r.type === "archive";
      if (this.grabberFilter === "document") return r.type === "document";
      if (this.grabberFilter === "executable") return r.type === "executable";
      return true;
    });

    const isAllSelected = filtered.length > 0 && filtered.every((r) => this.selectedGrabberUrls.has(r.url));

    return `
      <div class="tasks-toolbar">
        <div class="toolbar-row" style="margin-bottom: 6px;">
          <div class="filter-pills">
            <button class="filter-pill ${this.grabberFilter === "all" ? "active" : ""}" data-grab-filter="all">All (${this.pageResources.length})</button>
            <button class="filter-pill ${this.grabberFilter === "media" ? "active" : ""}" data-grab-filter="media">Media</button>
            <button class="filter-pill ${this.grabberFilter === "archive" ? "active" : ""}" data-grab-filter="archive">Archives</button>
            <button class="filter-pill ${this.grabberFilter === "document" ? "active" : ""}" data-grab-filter="document">Docs</button>
            <button class="filter-pill ${this.grabberFilter === "executable" ? "active" : ""}" data-grab-filter="executable">Software</button>
          </div>
          <button id="selectAllGrabberBtn" class="btn-3d" style="font-size: 11px;">
            ${isAllSelected ? "Deselect All" : "Select All"}
          </button>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <span>Selected: <strong style="color: #60A5FA;">${this.selectedGrabberUrls.size}</strong> link(s)</span>
          <button id="sendBatchBtn" class="btn-3d btn-primary" ${this.selectedGrabberUrls.size === 0 ? "disabled style='opacity:0.4;'" : ""}>
            Download Selected (${this.selectedGrabberUrls.size})
          </button>
        </div>
      </div>
      <div class="downloads-list">
        ${
          filtered.length === 0
            ? `
          <div class="empty-state">
            <div class="empty-icon">🔗</div>
            <div style="font-weight: 600;">No matching links on this page</div>
            <div style="font-size: 11px;">Try another category filter or browse to a page with downloadable content.</div>
          </div>
        `
            : filtered
                .map((r) => {
                  const checked = this.selectedGrabberUrls.has(r.url) ? "checked" : "";
                  return `
            <div class="download-item" style="padding: 6px 10px;">
              <input type="checkbox" class="grabber-check" data-url="${escapeHtml(r.url)}" ${checked} style="margin-right: 8px; cursor: pointer;">
              <div class="item-main">
                <div class="file-title" style="font-size: 11.5px;" title="${escapeHtml(r.url)}">${escapeHtml(r.title)}</div>
                <div class="item-meta">
                  <span>${escapeHtml(r.type.toUpperCase())}</span>
                  <span>•</span>
                  <span>${escapeHtml(r.format || r.type.toUpperCase())}</span>
                  <span>•</span>
                  <span style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(r.url)}</span>
                </div>
              </div>
            </div>
          `;
                })
                .join("")
        }
      </div>
    `;
  }

  private attachGrabberEvents() {
    document.querySelectorAll("[data-grab-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.grabberFilter = btn.getAttribute("data-grab-filter") || "all";
        this.render();
      });
    });

    const selectAllBtn = document.getElementById("selectAllGrabberBtn");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        const filtered = this.pageResources.filter((r) => {
          if (this.grabberFilter === "all") return true;
          if (this.grabberFilter === "media") return r.type === "video" || r.type === "audio" || r.type === "stream";
          if (this.grabberFilter === "archive") return r.type === "archive";
          if (this.grabberFilter === "document") return r.type === "document";
          if (this.grabberFilter === "executable") return r.type === "executable";
          return true;
        });
        const isAllSelected = filtered.length > 0 && filtered.every((r) => this.selectedGrabberUrls.has(r.url));
        if (isAllSelected) {
          filtered.forEach((r) => this.selectedGrabberUrls.delete(r.url));
        } else {
          filtered.forEach((r) => this.selectedGrabberUrls.add(r.url));
        }
        this.render();
      });
    }

    document.querySelectorAll(".grabber-check").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const target = e.target as HTMLInputElement;
        const url = target.getAttribute("data-url");
        if (url) {
          if (target.checked) {
            this.selectedGrabberUrls.add(url);
          } else {
            this.selectedGrabberUrls.delete(url);
          }
        }
        const sendBtn = document.getElementById("sendBatchBtn") as HTMLButtonElement;
        if (sendBtn) {
          sendBtn.textContent = `Download Selected (${this.selectedGrabberUrls.size})`;
          if (this.selectedGrabberUrls.size > 0) {
            sendBtn.removeAttribute("disabled");
            sendBtn.removeAttribute("style");
          } else {
            sendBtn.setAttribute("disabled", "true");
            sendBtn.setAttribute("style", "opacity: 0.4;");
          }
        }
      });
    });

    const sendBatchBtn = document.getElementById("sendBatchBtn");
    if (sendBatchBtn) {
      sendBatchBtn.addEventListener("click", () => {
        if (this.selectedGrabberUrls.size === 0) return;
        const items = Array.from(this.selectedGrabberUrls).map((url) => {
          const res = this.pageResources.find((r) => r.url === url);
          return {
            url,
            filename: res ? res.title : undefined,
          };
        });

        if (items.length > 1000) {
          alert("Cannot queue more than 1,000 items in a single batch.");
          return;
        }

        if (items.length > 200) {
          if (!confirm(`You are about to start ${items.length} downloads. Continue?`)) {
            return;
          }
        }

        chrome.runtime.sendMessage({
          action: "batch_add",
          items,
        });

        this.selectedGrabberUrls.clear();
        this.activeTab = "tasks";
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelector('[data-tab="tasks"]')?.classList.add("active");
        this.render();
      });
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
          <div class="settings-group-title" style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-bottom: 6px;">Extension Version &amp; App Sync</div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 11px;">
            <span style="color: #8fa0be;">Installed Version: <strong style="color: #FFFFFF;">v${this.currentVersion}</strong></span>
            <span style="color: #8fa0be;">Expected: <strong style="color: #FFFFFF;">v${this.expectedVersion || this.currentVersion}</strong></span>
          </div>
          <div style="font-size: 11px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
            <span style="color: #8fa0be;">Status:</span>
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 600; background: ${this.expectedVersion && this.expectedVersion !== this.currentVersion ? '#B45309' : '#065F46'}; color: #FFFFFF;">
              ${this.expectedVersion && this.expectedVersion !== this.currentVersion ? `Update Available (v${this.expectedVersion})` : 'Up to Date'}
            </span>
            <span style="color: #64748B; font-size: 10px; margin-left: auto; text-transform: capitalize;">${escapeHtml(this.detectedBrowser)}</span>
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

        <!-- Media Download Buttons (Master, YouTube, Other Sites, Hidden Sites) -->
        <div class="settings-group" style="padding: 14px; background: #070e1b; border: 1px solid #1a273e; border-radius: 10px;">
          <div class="settings-group-title" style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-bottom: 6px;">Media Download Buttons</div>
          <div class="setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <div class="setting-label" style="font-size: 12px; font-weight: 600;">Enable Download Buttons</div>
              <div class="setting-desc" style="font-size: 11px; color: #8fa0be;">Master switch for in-page download buttons</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="mediaMasterToggle" ${this.mediaMaster ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <div class="setting-label" style="font-size: 12px; font-weight: 600;">YouTube Action Row Pill</div>
              <div class="setting-desc" style="font-size: 11px; color: #8fa0be;">Show EDM pill button next to Subscribe on YouTube</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="mediaYouTubeToggle" ${this.mediaYouTube ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <div class="setting-label" style="font-size: 12px; font-weight: 600;">Other Sites Floating Button</div>
              <div class="setting-desc" style="font-size: 11px; color: #8fa0be;">Show bottom-right floating button on other video sites</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="mediaOtherSitesToggle" ${this.mediaOtherSites ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
          <div style="font-size: 11px; color: #8fa0be; margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
            <span>Hidden Sites: <strong>${this.hiddenSites.length}</strong> site(s)</span>
            ${this.hiddenSites.length > 0 ? `<button id="btnClearHiddenSites" class="btn-3d" style="font-size: 10.5px; padding: 2px 8px;">Clear Hidden Sites</button>` : ''}
          </div>
        </div>

        <!-- Host Diagnostics Card -->
        <div id="settings-diagnostics-card" class="settings-group" style="padding: 14px; background: #070e1b; border: 1px solid #1a273e; border-radius: 10px;">
          ${this.renderDiagnosticsTab()}
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
              updateFeedback.textContent = "Extension is up to date (v0.0.5).";
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

    // Media Button Toggles
    const masterToggle = document.getElementById("mediaMasterToggle") as HTMLInputElement;
    if (masterToggle) {
      masterToggle.addEventListener("change", async () => {
        this.mediaMaster = masterToggle.checked;
        await chrome.storage.local.set({ media_button_master: this.mediaMaster });
      });
    }

    const ytToggle = document.getElementById("mediaYouTubeToggle") as HTMLInputElement;
    if (ytToggle) {
      ytToggle.addEventListener("change", async () => {
        this.mediaYouTube = ytToggle.checked;
        await chrome.storage.local.set({ media_button_youtube: this.mediaYouTube });
      });
    }

    const otherToggle = document.getElementById("mediaOtherSitesToggle") as HTMLInputElement;
    if (otherToggle) {
      otherToggle.addEventListener("change", async () => {
        this.mediaOtherSites = otherToggle.checked;
        await chrome.storage.local.set({ media_button_other_sites: this.mediaOtherSites });
      });
    }

    const clearHiddenBtn = document.getElementById("btnClearHiddenSites");
    if (clearHiddenBtn) {
      clearHiddenBtn.addEventListener("click", async () => {
        this.hiddenSites = [];
        await chrome.storage.local.set({ hidden_sites: [], disabled_video_domains: [] });
        this.render();
      });
    }

    // Attach embedded diagnostics events
    this.attachDiagnosticsEvents();
  }

  // ─────────────────────────────────────────────────────────────
  // 3. DIAGNOSTICS TAB
  // ─────────────────────────────────────────────────────────────
  private renderDiagnosticsTab(): string {
    const rep = this.diagnosticsReport;
    if (!rep) {
      if (this.port) {
        this.port.postMessage({ type: "get_diagnostics" });
      }
      return `
        <div class="diag-view">
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <div style="font-weight:600; font-size:12px;">Querying Native Messaging Host...</div>
            <div style="font-size:11px; color:var(--text-muted);">Inspecting system registry &amp; helper state</div>
          </div>
        </div>
      `;
    }

    const myExtId = (typeof chrome !== "undefined" && chrome.runtime?.id) ? chrome.runtime.id : "ginpdimhcdbojbhemgjedghkeolbcmgj";
    const browsers: any[] = rep.browsers || [];

    const helperOk = rep.helper_path && rep.browsers.some((b: any) => b.helper_registered && b.manifest_exists);
    const appOk = rep.app_installed;
    const wsOk = rep.ws_port_ready || this.connectionState === "connected";

    return `
      <div class="diag-view">
        <div class="diag-header">
          <div style="font-size:12px; font-weight:700;">Host &amp; Wake Diagnostics</div>
          <div class="diag-actions">
            <button id="btnCopyDiag" class="btn-3d" style="font-size:10px; padding:3px 8px;">📋 Copy report</button>
            <button id="btnRepairDiag" class="btn-3d btn-primary" style="font-size:10px; padding:3px 8px;" ${this.isRepairing ? "disabled" : ""}>
              ${this.isRepairing ? "Repairing..." : "🔧 Repair"}
            </button>
          </div>
        </div>

        <div id="diagToast" style="display:none; padding:4px 8px; border-radius:4px; font-size:10.5px; text-align:center;"></div>

        <!-- 1. System & Engine Overview -->
        <div class="diag-card">
          <div class="diag-card-title">
            <span>Core Components</span>
            <span class="diag-badge ${appOk && helperOk ? "diag-badge-ok" : "diag-badge-err"}">
              ${appOk && helperOk ? "HEALTHY" : "ATTENTION NEEDED"}
            </span>
          </div>

          <div class="diag-row">
            <span class="diag-label">EDM Desktop App</span>
            <span class="diag-badge ${appOk ? "diag-badge-ok" : "diag-badge-err"}">${appOk ? "Installed" : "Not Found"}</span>
          </div>
          ${rep.app_exe_path ? `<div class="diag-row"><span class="diag-label">App Executable</span><span class="diag-val" title="${rep.app_exe_path}">${rep.app_exe_path.split(/[\\/]/).pop()}</span></div>` : ""}

          <div class="diag-row">
            <span class="diag-label">Native Messaging Helper</span>
            <span class="diag-badge ${helperOk ? "diag-badge-ok" : "diag-badge-err"}">${helperOk ? "Available" : "Missing / Unregistered"}</span>
          </div>
          ${rep.helper_path ? `<div class="diag-row"><span class="diag-label">Helper Executable</span><span class="diag-val" title="${rep.helper_path}">${rep.helper_path.split(/[\\/]/).pop()}</span></div>` : ""}

          <div class="diag-row">
            <span class="diag-label">WebSocket Engine (14370)</span>
            <span class="diag-badge ${wsOk ? "diag-badge-ok" : "diag-badge-warn"}">${wsOk ? "Listening (Ready)" : "Offline (Asleep)"}</span>
          </div>

          <div class="diag-row">
            <span class="diag-label">Cold-Start Wake Time</span>
            <span class="diag-val">${rep.time_to_ready_ms !== null && rep.time_to_ready_ms !== undefined ? `${rep.time_to_ready_ms} ms` : "Instant / Sleeping"}</span>
          </div>

          <div class="diag-row">
            <span class="diag-label">Last Wake Result</span>
            <span class="diag-badge ${rep.last_wake_error ? "diag-badge-err" : "diag-badge-ok"}">
              ${rep.last_wake_error ? `Failed: ${rep.last_wake_error}` : "OK / Ready"}
            </span>
          </div>
          ${rep.last_wake_timestamp ? `<div class="diag-row"><span class="diag-label">Last Wake Attempt</span><span class="diag-val">${new Date(rep.last_wake_timestamp).toLocaleTimeString()}</span></div>` : ""}
        </div>

        <!-- 2. Browser Registrations -->
        <div class="diag-card">
          <div class="diag-card-title">Browser Registrations (HKCU)</div>
          ${browsers.map((b: any) => {
            const browserName = b.browser.toUpperCase();
            const allOk = b.helper_registered && b.manifest_exists && b.helper_exists;
            return `
              <div style="border-bottom: 1px solid var(--border-subtle); padding-bottom: 6px; margin-bottom: 6px;">
                <div class="diag-row" style="margin-bottom: 4px;">
                  <strong style="color:var(--text-primary); font-size:11px;">${browserName}</strong>
                  <span class="diag-badge ${allOk ? "diag-badge-ok" : "diag-badge-err"}">
                    ${allOk ? "Registered" : "Incomplete"}
                  </span>
                </div>
                <div class="diag-row"><span class="diag-label">Manifest Key:</span><span class="diag-badge ${b.helper_registered ? "diag-badge-ok" : "diag-badge-err"}">${b.helper_registered ? "Present" : "Missing"}</span></div>
                <div class="diag-row"><span class="diag-label">Manifest File:</span><span class="diag-badge ${b.manifest_exists ? "diag-badge-ok" : "diag-badge-err"}">${b.manifest_exists ? "Exists" : "Missing"}</span></div>
                <div class="diag-row"><span class="diag-label">Helper Binary:</span><span class="diag-badge ${b.helper_exists ? "diag-badge-ok" : "diag-badge-err"}">${b.helper_exists ? "Exists" : "Missing"}</span></div>
                <div class="diag-row"><span class="diag-label">Extension Match:</span><span class="diag-badge ${b.origin_matched ? "diag-badge-ok" : "diag-badge-warn"}">${b.origin_matched ? "Matched" : "Unmatched"}</span></div>
                ${b.connected_extension_id ? `<div class="diag-row"><span class="diag-label">Connected ID:</span><span class="diag-val" style="font-size:10px;">${b.connected_extension_id}</span></div>` : ""}
              </div>
            `;
          }).join("")}
        </div>

        <!-- 3. Extension Identity -->
        <div class="diag-card">
          <div class="diag-card-title">Extension Environment</div>
          <div class="diag-row">
            <span class="diag-label">Active Extension ID</span>
            <span class="diag-val" title="${myExtId}">${myExtId}</span>
          </div>
          ${rep.connected_extension_id ? `
          <div class="diag-row">
            <span class="diag-label">Connected Extension ID</span>
            <span class="diag-val" style="color:var(--accent);" title="${rep.connected_extension_id}">${rep.connected_extension_id}</span>
          </div>
          ` : ""}
          <div class="diag-row">
            <span class="diag-label">Extension Version</span>
            <span class="diag-val">v${this.currentVersion || "0.0.7"}</span>
          </div>
          <div class="diag-row">
            <span class="diag-label">Operating System</span>
            <span class="diag-val">${rep.os || "Windows"}</span>
          </div>
        </div>
      </div>
    `;
  }

  private attachDiagnosticsEvents() {
    const btnCopy = document.getElementById("btnCopyDiag");
    const btnRepair = document.getElementById("btnRepairDiag");
    const toast = document.getElementById("diagToast");

    if (btnCopy) {
      btnCopy.addEventListener("click", () => {
        const text = JSON.stringify(this.diagnosticsReport, null, 2);
        navigator.clipboard.writeText(text).then(() => {
          if (toast) {
            toast.style.display = "block";
            toast.style.background = "rgba(16, 185, 129, 0.2)";
            toast.style.border = "1px solid rgba(16, 185, 129, 0.4)";
            toast.style.color = "#34D399";
            toast.innerText = "✓ Diagnostics report copied to clipboard!";
            setTimeout(() => { toast.style.display = "none"; }, 2500);
          }
        });
      });
    }

    if (btnRepair) {
      btnRepair.addEventListener("click", () => {
        this.isRepairing = true;
        btnRepair.setAttribute("disabled", "true");
        btnRepair.innerText = "Repairing...";
        if (this.port) {
          this.port.postMessage({ type: "repair_registration" });
        } else {
          chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "repair_registration" }, (_resp) => {
            this.isRepairing = false;
            this.render();
          });
        }
        if (toast) {
          toast.style.display = "block";
          toast.style.background = "rgba(37, 99, 235, 0.2)";
          toast.style.border = "1px solid rgba(37, 99, 235, 0.4)";
          toast.style.color = "#60A5FA";
          toast.innerText = "Repairing Native Messaging registration...";
        }
      });
    }
  }
}

// Instantiate on popup load
document.addEventListener("DOMContentLoaded", () => {
  (window as any).__app = new PopupController();
});
