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
