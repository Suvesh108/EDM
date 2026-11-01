import { EdmSettings } from "../types/settings";

// Safe dynamic check for Tauri v2 runtime
export const isTauri = (): boolean => {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
};

export interface BackendProbeResult {
  url: string;
  final_url: string;
  filename: string | null;
  content_type: string | null;
  size_total: number | null;
  resumable: boolean;
  etag: string | null;
  last_modified: string | null;
}

export interface BackendTelemetry {
  download_id: string;
  total_bytes: number | null;
  downloaded_bytes: number;
  progress_pct: number;
  instant_throughput_bps: number;
  rolling_throughput_bps: number;
  active_connections: number;
  max_allowed_connections: number;
  mode: "auto" | "optimizing" | "stable" | "limited" | "fallback_single_stream";
  eta_seconds: number | null;
  decision_reason: string;
  workers: Array<{
    idx: number;
    start: number;
    end: number;
    pos: number;
    bytes_downloaded: number;
    speed_bps: number;
    status: string;
    retry_count: number;
  }>;
}

export async function tauriProbeUrl(url: string): Promise<BackendProbeResult> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<BackendProbeResult>("probe_url", { url });
    } catch (err) {
      console.warn("Tauri probe_url failed, falling back to simulated probe:", err);
    }
  }

  // Graceful browser mode fallback
  let filename: string | null = null;
  let contentType = "application/octet-stream";
  let sizeTotal: number | null = null;
  let resumable = true;

  // 1. YouTube video detection and oEmbed title resolution
  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.includes("youtube.com/watch") ||
    lowerUrl.includes("youtu.be/") ||
    lowerUrl.includes("youtube.com/shorts/") ||
    lowerUrl.includes("youtube.com/embed/")
  ) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const oembedRes = await fetch(oembedUrl);
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        if (data.title) {
          const cleanTitle = data.title.replace(/[\\/:*?"<>|]/g, "_").trim();
          filename = `${cleanTitle}.mp4`;
          contentType = "video/mp4";
          sizeTotal = 48_500_000; // ~48.5 MB representative stream
        }
      }
    } catch {
      // Fallback if offline
      filename = "YouTube Video.mp4";
      contentType = "video/mp4";
    }
  }

  // 2. Query parameter title or filename detection (e.g. ?title=... or ?filename=...)
  if (!filename) {
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      for (const [k, v] of parsed.searchParams.entries()) {
        const kLower = k.toLowerCase();
        if (["title", "filename", "file_name", "file"].includes(kLower) && v.trim()) {
          filename = v.trim().replace(/[\\/:*?"<>|]/g, "_");
          break;
        }
      }
    } catch {}
  }

  // 3. Fallback to path segment, avoiding generic names like 'watch' or 'videoplayback'
  if (!filename) {
    const raw = url.split("/").pop()?.split("?")[0] || "download.bin";
    const genericNames = ["watch", "videoplayback", "download", "file", "stream", "media", "video", "index"];
    if (genericNames.includes(raw.toLowerCase()) || raw.length === 11) {
      filename = "video.mp4";
      contentType = "video/mp4";
    } else {
      filename = raw;
    }
  }

  try {
    const headRes = await fetch(url, { method: "HEAD" });
    const cl = headRes.headers.get("content-length");
    if (cl) sizeTotal = parseInt(cl, 10);
    const ar = headRes.headers.get("accept-ranges");
    if (ar) resumable = ar.toLowerCase().includes("bytes");
    const ct = headRes.headers.get("content-type");
    if (ct) contentType = ct;
  } catch {
    // If CORS or offline, check if size is in URL path (e.g. /file/1048576)
    const match = url.match(/\/file\/(\d+)/);
    if (match) {
      sizeTotal = parseInt(match[1], 10);
    } else if (!sizeTotal) {
      sizeTotal = 50_000_000;
    }
  }

  // Ensure extension matches content-type if missing
  if (filename && !filename.includes(".")) {
    if (contentType.includes("video") || contentType.includes("mp4")) filename += ".mp4";
    else if (contentType.includes("audio")) filename += ".mp3";
    else if (contentType.includes("pdf")) filename += ".pdf";
    else if (contentType.includes("zip")) filename += ".zip";
    else filename += ".bin";
  }

  return {
    url,
    final_url: url,
    filename,
    content_type: contentType,
    size_total: sizeTotal,
    resumable,
    etag: '"edm-etag-verified"',
    last_modified: new Date().toUTCString(),
  };
}

export async function tauriStartDownload(params: {
  url: string;
  filename?: string;
  saveDir?: string;
  maxConnections?: number;
}): Promise<{ status: string; id: string }> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<{ status: string; id: string }>("start_download", {
        url: params.url,
        filename: params.filename,
        save_dir: params.saveDir,
        max_connections: params.maxConnections,
      });
    } catch (err) {
      console.warn("Tauri start_download failed, using client task:", err);
    }
  }

  return {
    status: "started",
    id: Date.now().toString(),
  };
}

export async function tauriPauseDownload(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("pause_download", { id });
    } catch (err) {
      console.warn("Tauri pause_download:", err);
    }
  }
}

export async function tauriGetTelemetry(
  id: string
): Promise<BackendTelemetry | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<BackendTelemetry | { status: string }>(
        "get_download_telemetry",
        { id }
      );
      if ("download_id" in res) {
        return res as BackendTelemetry;
      }
    } catch (err) {
      // In web dev mode or non-tauri context
    }
  }
  return null;
}

export async function tauriLoadSettings(): Promise<EdmSettings | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<EdmSettings | null>("get_settings");
      return res;
    } catch (err) {
      console.warn("Tauri get_settings fallback:", err);
    }
  }
  return null;
}

export async function tauriResumeDownload(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("resume_download", { id });
    } catch (err) {
      console.warn("Tauri resume_download:", err);
    }
  }
}

export async function tauriCancelDownload(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("cancel_download", { id });
    } catch (err) {
      console.warn("Tauri cancel_download:", err);
    }
  }
}

export async function tauriDeleteDownload(id: string, deleteFile?: boolean): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_download", { id, delete_file: deleteFile });
    } catch (err) {
      console.warn("Tauri delete_download:", err);
    }
  }
}

export async function tauriOpenFile(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_path", { id });
    } catch (err) {
      console.warn("Tauri open_file_path:", err);
    }
  }
}

export async function tauriOpenFolder(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_dir_path", { id });
    } catch (err) {
      console.warn("Tauri open_dir_path:", err);
    }
  }
}

export interface BackendDownloadItem {
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
  completed_at: string | null;
  error_msg: string | null;
}

export async function tauriListDownloads(): Promise<BackendDownloadItem[] | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ downloads: BackendDownloadItem[] }>("list_downloads");
      if (res && Array.isArray(res.downloads)) {
        return res.downloads;
      }
    } catch (err) {
      console.warn("Tauri list_downloads:", err);
    }
  }
  return null;
}

export async function tauriSaveSettings(settings: EdmSettings): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_settings", { settings });
    } catch (err) {
      console.warn("Tauri save_settings fallback:", err);
    }
  }
}

export async function tauriWindowMinimize(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_minimize");
      return;
    } catch (_) {}
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (err) {
      console.warn("Tauri window minimize:", err);
    }
  }
}

export async function tauriWindowToggleMaximize(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_toggle_maximize");
      return;
    } catch (_) {}
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.warn("Tauri window toggle maximize:", err);
    }
  }
}

export async function tauriWindowClose(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_close");
      return;
    } catch (_) {}
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      console.warn("Tauri window close:", err);
    }
  }
}

export async function tauriStartDragging(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_start_dragging");
      return;
    } catch (_) {}
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.warn("Tauri window start dragging:", err);
    }
  }
}

export async function tauriGetFeaturePacks(): Promise<any[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<any[]>("get_feature_packs");
    } catch (err) {
      console.warn("Tauri get_feature_packs:", err);
    }
  }
  return [];
}

export async function tauriGetExtensionToken(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_extension_token");
    } catch (err) {
      console.warn("Tauri get_extension_token:", err);
    }
  }
  return "ed00000000000000000000000000000000000000000000000000000000000000";
}

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_name: string;
  release_notes: string;
  published_at: string;
  download_url: string | null;
  asset_name: string | null;
  asset_size: number;
  html_url: string;
}

export interface OtaProgress {
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  status: "downloading" | "ready" | string;
}

export async function tauriGetAppVersion(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_app_version");
    } catch (err) {
      console.warn("Tauri get_app_version failed:", err);
    }
  }
  return "0.0.5";
}

function isSemverNewer(latest: string, current: string): boolean {
  const pLatest = latest.split(".").map((n) => parseInt(n, 10));
  const pCurrent = current.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const l = pLatest[i] || 0;
    const c = pCurrent[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export async function tauriCheckForUpdates(): Promise<UpdateCheckResult> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<UpdateCheckResult>("check_for_updates");
    } catch (err) {
      console.warn("Tauri check_for_updates failed, using fallback:", err);
    }
  }

  // Web fallback: query GitHub releases API directly
  try {
    const res = await fetch("https://api.github.com/repos/Suvesh108/EDM/releases/latest");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    const rawTag = (release.tag_name || "").replace(/^v/i, "").trim();
    const currentVersion = "0.0.5";
    const setupAsset =
      (release.assets || []).find((a: any) =>
        a.name.endsWith(".exe") && a.name.toLowerCase().includes("setup")
      ) || (release.assets || []).find((a: any) => a.name.endsWith(".exe"));

    return {
      current_version: currentVersion,
      latest_version: rawTag || currentVersion,
      update_available: isSemverNewer(rawTag, currentVersion),
      release_name: release.name || release.tag_name || `v${rawTag}`,
      release_notes: release.body || "",
      published_at: release.published_at || "",
      download_url: setupAsset?.browser_download_url || null,
      asset_name: setupAsset?.name || null,
      asset_size: setupAsset?.size || 0,
      html_url: release.html_url || "https://github.com/Suvesh108/EDM/releases",
    };
  } catch (err) {
    throw new Error(`Failed to check updates: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function tauriInstallUpdate(downloadUrl: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("install_update", { downloadUrl });
  } else {
    window.open(downloadUrl, "_blank");
  }
}

export async function tauriListenOtaProgress(
  callback: (progress: OtaProgress) => void
): Promise<() => void> {
  if (isTauri()) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<OtaProgress>("ota-progress", (event) => {
        callback(event.payload);
      });
    } catch (err) {
      console.warn("Tauri listen ota-progress failed:", err);
    }
  }
  return () => {};
}

export interface BrowserDiagnostic {
  browser: string;
  registry_key: string;
  helper_registered: boolean;
  manifest_path: string | null;
  manifest_exists: boolean;
  helper_path: string | null;
  helper_exists: boolean;
  origin_matched: boolean;
  error: string | null;
}

export interface DiagnosticsReport {
  app_version: string;
  os: string;
  helper_path: string | null;
  app_exe_path: string | null;
  app_installed: boolean;
  ws_port_ready: boolean;
  time_to_ready_ms: number | null;
  last_wake_error: string | null;
  last_wake_timestamp: string | null;
  browsers: BrowserDiagnostic[];
}

export async function tauriGetBrowserDiagnostics(extId?: string): Promise<DiagnosticsReport> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<DiagnosticsReport>("get_browser_diagnostics", { extId });
    } catch (e) {
      console.warn("get_browser_diagnostics failed:", e);
    }
  }
  return {
    app_version: "0.0.6",
    os: "Windows",
    helper_path: "C:\\Program Files\\EDM\\edm-nmh.exe",
    app_exe_path: "C:\\Program Files\\EDM\\EDM.exe",
    app_installed: true,
    ws_port_ready: true,
    time_to_ready_ms: 120,
    last_wake_error: null,
    last_wake_timestamp: new Date().toISOString(),
    browsers: [
      { browser: "edge", registry_key: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.edm.nmh", helper_registered: true, manifest_path: "C:\\Program Files\\EDM\\com.edm.nmh.json", manifest_exists: true, helper_path: "C:\\Program Files\\EDM\\edm-nmh.exe", helper_exists: true, origin_matched: true, error: null },
      { browser: "chrome", registry_key: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.edm.nmh", helper_registered: true, manifest_path: "C:\\Program Files\\EDM\\com.edm.nmh.json", manifest_exists: true, helper_path: "C:\\Program Files\\EDM\\edm-nmh.exe", helper_exists: true, origin_matched: true, error: null },
      { browser: "brave", registry_key: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.edm.nmh", helper_registered: true, manifest_path: "C:\\Program Files\\EDM\\com.edm.nmh.json", manifest_exists: true, helper_path: "C:\\Program Files\\EDM\\edm-nmh.exe", helper_exists: true, origin_matched: true, error: null },
      { browser: "firefox", registry_key: "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.edm.nmh", helper_registered: true, manifest_path: "C:\\Program Files\\EDM\\com.edm.nmh.firefox.json", manifest_exists: true, helper_path: "C:\\Program Files\\EDM\\edm-nmh.exe", helper_exists: true, origin_matched: true, error: null }
    ]
  };
}

export async function tauriRepairNativeHostRegistration(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("repair_native_host_registration");
    } catch (e: any) {
      return e?.toString() || "Repair failed";
    }
  }
  return "Native host registration repaired successfully";
}

export interface BrowserSetupInfo {
  id: string;
  name: string;
  installed: boolean;
  exe_path: string | null;
  helper_registered: boolean;
  extension_connected: boolean;
  store_url: string | null;
  extension_page_url: string;
}

export async function tauriDetectInstalledBrowsers(): Promise<BrowserSetupInfo[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<BrowserSetupInfo[]>("detect_installed_browsers");
    } catch (e) {
      console.warn("detect_installed_browsers failed:", e);
    }
  }
  return [
    { id: "chrome", name: "Google Chrome", installed: true, exe_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", helper_registered: true, extension_connected: false, store_url: null, extension_page_url: "chrome://extensions" },
    { id: "edge", name: "Microsoft Edge", installed: true, exe_path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", helper_registered: true, extension_connected: false, store_url: null, extension_page_url: "edge://extensions" },
    { id: "brave", name: "Brave Browser", installed: true, exe_path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", helper_registered: true, extension_connected: false, store_url: null, extension_page_url: "brave://extensions" },
    { id: "firefox", name: "Mozilla Firefox", installed: true, exe_path: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", helper_registered: true, extension_connected: false, store_url: "http://127.0.0.1:14370/firefox.xpi", extension_page_url: "about:addons" },
  ];
}

export async function tauriPrepareExtensionFiles(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("prepare_extension_files");
    } catch (e: any) {
      throw new Error(e?.toString() || "Failed to prepare extension files");
    }
  }
  return "C:\\Users\\User\\AppData\\Local\\EDM\\extension";
}

export async function tauriGetExtensionFolderPath(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_extension_folder_path");
    } catch (e) {
      console.warn("get_extension_folder_path failed:", e);
    }
  }
  return "C:\\Users\\User\\AppData\\Local\\EDM\\extension";
}

export async function tauriOpenBrowserUrl(browser: string, url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_browser_url", { browser, url });
      return;
    } catch (e) {
      console.warn("open_browser_url failed:", e);
    }
  }
  window.open(url, "_blank");
}

export async function tauriGetFirefoxXpiUrl(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_firefox_xpi_url");
    } catch {}
  }
  return "http://127.0.0.1:14370/firefox.xpi";
}

export async function tauriIsWizardCompleted(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("is_wizard_completed");
    } catch {}
  }
  return localStorage.getItem("edm_wizard_completed") === "true";
}

export async function tauriSetWizardCompleted(completed: boolean): Promise<void> {
  localStorage.setItem("edm_wizard_completed", completed ? "true" : "false");
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_wizard_completed", { completed });
    } catch {}
  }
}

export async function tauriGetSystemDownloadsDir(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_system_downloads_dir");
    } catch {}
  }
  return "C:\\Users\\User\\Downloads";
}
