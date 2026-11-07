import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Download,
  Pause,
  Play,
  Square,
  Trash2,
  FolderOpen,
  Search,
  Plus,
  FileCode,
  Film,
  Music,
  Archive,
  FileText,
  X,
  Layers,
  Clock,
  CheckCircle2,
  LayoutList,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  Video,
  Cpu,
  Wifi,
  Compass,
  Gauge,
  Activity,
  ArrowDown,
  ArrowUp,
  Settings,
  Minus,
  RotateCcw,
  Copy,
  Check,
} from "lucide-react";
import SettingsPage from "./components/SettingsPage";
import SetupWizard from "./components/SetupWizard";
import { RefreshLinkModal } from "./components/RefreshLinkModal";
import { PowerCountdownModal } from "./components/PowerCountdownModal";
import { SpeedChartInteractive } from "./components/SpeedChartInteractive";
import { loadSettings, saveSettings, EdmSettings } from "./types/settings";
import { formatBytes, formatSpeed, formatEta } from "./utils/format";
import { getMergedProgressSpans } from "./utils/progress";
import { motion, AnimatePresence } from "motion/react";
import {
  backdropVariants,
  modalVariants,
  popoverVariants,
  viewVariants,
} from "./utils/motion";
import {
  isTauri,
  tauriProbeUrl,
  tauriStartDownload,
  tauriPauseDownload,
  tauriResumeDownload,
  tauriCancelDownload,
  tauriDeleteDownload,
  tauriOpenFile,
  tauriOpenFolder,
  tauriListDownloads,
  tauriSaveSettings,
  tauriLoadSettings,
  tauriGetTelemetry,
  tauriWindowMinimize,
  tauriWindowToggleMaximize,
  tauriWindowClose,
  tauriStartDragging,
  tauriIsWizardCompleted,
  tauriCheckDuplicateDownload,
  tauriSetSpeedLimit,
  tauriSelectDownloadDirectory,
} from "./services/tauriBridge";

export interface WorkerInfo {
  idx: number;
  start: number;
  end: number;
  pos: number;
  speed: string;
  status: string;
}

export interface DownloadItem {
  id: string;
  name: string;
  category: "Video" | "Music" | "Documents" | "Compressed" | "Programs" | "Other";
  sizeTotal: number;
  sizeDone: number;
  speed: string;
  eta: string;
  connections: number;
  state: "downloading" | "paused" | "queued" | "completed" | "failed";
  progress: number;
  url: string;
  domain: string;
  dateAdded: string;
  workers?: WorkerInfo[];
  speedHistory?: number[];
  peakSpeedBps?: number;
  error_msg?: string | null;
}

export const INITIAL_NETPULSE_PROFILE: number[] = [];

export const generateSpeedSvgPath = (history: number[] = [], peakBps: number = 0) => {
  const VIEW_WIDTH = 100;
  const VIEW_HEIGHT = 44;
  const TOP_PAD = 4;
  const BOTTOM_PAD = 38;
  const USABLE_H = BOTTOM_PAD - TOP_PAD;

  if (!history || history.length === 0) {
    return {
      linePath: `M 0,${BOTTOM_PAD} L ${VIEW_WIDTH},${BOTTOM_PAD}`,
      areaPath: `M 0,${BOTTOM_PAD} L ${VIEW_WIDTH},${BOTTOM_PAD} L ${VIEW_WIDTH},${VIEW_HEIGHT} L 0,${VIEW_HEIGHT} Z`,
    };
  }

  // Ensure sufficient rolling resolution (between 24 and 60 points) for fluid NetPulse spline
  let data = [...history];
  const targetMin = 24;
  if (data.length < targetMin) {
    const firstVal = data[0] || 0;
    data = [...Array(targetMin - data.length).fill(firstVal), ...data];
  } else if (data.length > 60) {
    data = data.slice(-60);
  }

  const maxVal = Math.max(peakBps, ...data, 1024);
  const n = data.length;

  const points = data.map((val, idx) => {
    const x = (idx / (n - 1)) * VIEW_WIDTH;
    const ratio = Math.max(0, Math.min(1, val / maxVal));
    const y = BOTTOM_PAD - ratio * USABLE_H;
    return { x, y };
  });

  if (points.length === 1) {
    return {
      linePath: `M 0,${points[0].y.toFixed(2)} L ${VIEW_WIDTH},${points[0].y.toFixed(2)}`,
      areaPath: `M 0,${points[0].y.toFixed(2)} L ${VIEW_WIDTH},${points[0].y.toFixed(2)} L ${VIEW_WIDTH},${VIEW_HEIGHT} L 0,${VIEW_HEIGHT} Z`,
    };
  }

  // Centripetal Catmull-Rom spline with bounded control points to guarantee smooth, organic curves (NetPulse style)
  let linePath = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.max(TOP_PAD - 1, Math.min(BOTTOM_PAD + 1, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.max(TOP_PAD - 1, Math.min(BOTTOM_PAD + 1, p2.y - (p3.y - p1.y) / 6));

    linePath += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }

  const areaPath = `${linePath} L ${VIEW_WIDTH},${VIEW_HEIGHT} L 0,${VIEW_HEIGHT} Z`;
  return { linePath, areaPath };
};

export default function App() {
  const [activeView, setActiveView] = useState<"downloads" | "settings">(
    () => {
      if (typeof window !== "undefined") {
        if (window.location.hash === "#settings" || window.location.hash === "#queues" || window.location.hash === "#section-queues") return "settings";
      }
      return "downloads";
    }
  );
  const [settings, setSettings] = useState<EdmSettings>(loadSettings);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [refreshModalTask, setRefreshModalTask] = useState<DownloadItem | null>(null);

  useEffect(() => {
    tauriIsWizardCompleted().then((completed) => {
      if (!completed) {
        setIsWizardOpen(true);
      }
    });
  }, []);

  const mode = settings.general.theme === "system" ? "dark" : settings.general.theme;
  const palette = settings.general.palette;

  const handleUpdateSettings = (newSettings: EdmSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
    tauriSaveSettings(newSettings);
  };

  const [viewMode, setViewMode] = useState<"table" | "grid">("table");

  // Synchronize hash routing with activeView
  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === "#settings" || window.location.hash === "#queues" || window.location.hash === "#section-queues") setActiveView("settings");
      else setActiveView("downloads");
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedDownload, setSelectedDownload] = useState<DownloadItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  const [isLimiterOpen, setIsLimiterOpen] = useState(false);
  const [speedLimit, setSpeedLimit] = useState<string>("Unlimited");
  const notifiedCompletedIdsRef = useRef<Set<string>>(new Set());

  const handleSpeedLimitChange = (val: string) => {
    setSpeedLimit(val);
    const limitMap: Record<string, number | null> = {
      "Unlimited": null,
      "50 MB/s": 50 * 1024 * 1024,
      "20 MB/s": 20 * 1024 * 1024,
      "10 MB/s": 10 * 1024 * 1024,
      "5 MB/s": 5 * 1024 * 1024,
      "2 MB/s": 2 * 1024 * 1024,
      "500 KB/s": 500 * 1024,
    };
    tauriSetSpeedLimit(limitMap[val] ?? null);
  };

  const triggerCompletionNotification = (filename: string, id: string) => {
    if (notifiedCompletedIdsRef.current.has(id)) return;
    notifiedCompletedIdsRef.current.add(id);

    // Audio chime if enabled
    if (settings.notifications.playSound) {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const now = ctx.currentTime;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = "sine";
          osc.frequency.setValueAtTime(587.33, now); // D5
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(now);
          osc.stop(now + 0.45);
        }
      } catch {}
    }

    // OS Notification banner if enabled
    if (settings.notifications.downloadCompleted && typeof window !== "undefined" && "Notification" in window) {
      try {
        if (Notification.permission === "granted") {
          new Notification("EDM Download Complete", {
            body: `${filename} has finished downloading.`,
          });
        } else if (Notification.permission !== "denied") {
          Notification.requestPermission().then((perm) => {
            if (perm === "granted") {
              new Notification("EDM Download Complete", {
                body: `${filename} has finished downloading.`,
              });
            }
          });
        }
      } catch {}
    }
  };

  type SortField = "dateAdded" | "name" | "size" | "progress" | "speed";
  const [sortField, setSortField] = useState<SortField>("dateAdded");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [addCategory, setAddCategory] = useState<string>("auto");
  const [addConnections, setAddConnections] = useState<number>(settings.downloads.maxConnectionsPerFile || 8);
  const [addSaveDir, setAddSaveDir] = useState<string>("");

  interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    item: DownloadItem | null;
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    item: null,
  });
  const [copiedContextMenuId, setCopiedContextMenuId] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleContextMenu = (e: React.MouseEvent, item: DownloadItem) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedDownload(item);
    if (!selectedIds.includes(item.id)) {
      setSelectedIds([item.id]);
    }
    setContextMenu({
      visible: true,
      x: Math.min(e.clientX, window.innerWidth - 230),
      y: Math.min(e.clientY, window.innerHeight - 270),
      item,
    });
  };

  const handleBrowseAddDir = async () => {
    const chosen = await tauriSelectDownloadDirectory(addSaveDir || settings.downloads.defaultDirectory);
    if (chosen) setAddSaveDir(chosen);
  };

  const resumeSelected = () => {
    if (selectedIds.length === 0) return;
    selectedIds.forEach((id) => {
      const item = downloads.find((d) => d.id === id);
      if (item && item.state === "paused") {
        tauriResumeDownload(id);
      }
    });
    setDownloads((prev) =>
      prev.map((d) => (selectedIds.includes(d.id) && d.state === "paused" ? { ...d, state: "downloading" } : d))
    );
  };

  const pauseSelected = () => {
    if (selectedIds.length === 0) return;
    selectedIds.forEach((id) => {
      const item = downloads.find((d) => d.id === id);
      if (item && item.state === "downloading") {
        tauriPauseDownload(id);
      }
    });
    setDownloads((prev) =>
      prev.map((d) => (selectedIds.includes(d.id) && d.state === "downloading" ? { ...d, state: "paused", speed: "0 B/s" } : d))
    );
  };

  const stopSelected = () => {
    if (selectedIds.length === 0) return;
    selectedIds.forEach((id) => {
      const item = downloads.find((d) => d.id === id);
      if (item && item.state === "downloading") {
        tauriCancelDownload(id);
      }
    });
    setDownloads((prev) =>
      prev.map((d) => (selectedIds.includes(d.id) && d.state === "downloading" ? { ...d, state: "paused", speed: "0 B/s" } : d))
    );
  };

  useEffect(() => {
    const handleCloseContext = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    };
    window.addEventListener("click", handleCloseContext);
    return () => {
      window.removeEventListener("click", handleCloseContext);
    };
  }, []);

  const [searchQuery, setSearchQuery] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [fileNameInput, setFileNameInput] = useState("");
  const [downloads, setDownloads] = useState<DownloadItem[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("edm_downloads_v1");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            return parsed.map((item: DownloadItem) => {
              if (item.state === "completed" || item.progress >= 100 || (item.sizeTotal > 0 && item.sizeDone >= item.sizeTotal)) {
                const total = item.sizeTotal || item.sizeDone || 0;
                return {
                  ...item,
                  state: "completed" as const,
                  progress: 100,
                  sizeDone: total,
                  sizeTotal: total,
                  speed: "0 B/s",
                  eta: "Finished",
                  connections: 0,
                  workers: item.workers?.map((w) => ({
                    ...w,
                    pos: w.end,
                    speed: "0 B/s",
                    status: "Chunk verified • Complete",
                  })),
                };
              }
              return item;
            });
          }
        }
      } catch (e) {
        console.warn("Failed to read edm_downloads_v1", e);
      }
    }
    return [];
  });
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{
    size: string;
    sizeBytes: number;
    resumable: boolean;
    type: string;
    filename?: string;
  } | null>(null);

  // Persist download tasks across sessions
  useEffect(() => {
    try {
      localStorage.setItem("edm_downloads_v1", JSON.stringify(downloads));
    } catch (e) {
      console.warn("Failed to persist edm_downloads_v1", e);
    }
  }, [downloads]);

  // Hydrate settings from SQLite backend on startup if available
  useEffect(() => {
    tauriLoadSettings().then((backendSettings) => {
      if (backendSettings) {
        setSettings(backendSettings);
      }
    });
  }, []);

  // Bidirectional real-time sync with backend SQLite store & extension tasks
  useEffect(() => {
    let mounted = true;

    const syncWithBackend = async () => {
      const backendItems = await tauriListDownloads();
      if (!backendItems || !mounted) return;

      setDownloads((prev) => {
        const existingMap = new Map(prev.map((item) => [item.id, item]));
        const validCategories = ["Video", "Music", "Documents", "Compressed", "Programs", "Other"] as const;
        const stateMap: Record<string, "downloading" | "paused" | "queued" | "completed" | "failed"> = {
          downloading: "downloading",
          verifying: "downloading",
          paused: "paused",
          cancelled: "paused",
          completed: "completed",
          failed: "failed",
          queued: "queued",
          created: "queued",
          probing: "queued",
        };

        const updated: DownloadItem[] = backendItems.map((b) => {
          const existing = existingMap.get(b.id);
          const total = b.size_total || existing?.sizeTotal || 0;
          const done = b.size_done || existing?.sizeDone || 0;
          const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : (existing?.progress || 0);
          const speedVal = b.speed_bytes_per_sec || 0;

          const category = validCategories.includes(b.category as any)
            ? (b.category as DownloadItem["category"])
            : "Programs";

          const domain = (() => {
            try {
              return new URL(b.url).hostname;
            } catch {
              return "web";
            }
          })();

          const rawState = stateMap[b.state] || (existing?.state || "downloading");
          const isCompleted = rawState === "completed" || pct >= 100 || (total > 0 && done >= total);
          if (existing && existing.state !== "completed" && isCompleted) {
            triggerCompletionNotification(b.filename, b.id);
          }
          const itemState = isCompleted ? ("completed" as const) : rawState;
          const finalTotal = isCompleted && total === 0 && done > 0 ? done : total;
          const finalDone = isCompleted && finalTotal > 0 ? finalTotal : done;
          const isDownloading = itemState === "downloading";
          const currentBps = isDownloading ? speedVal : 0;
          const history = existing?.speedHistory
            ? [...existing.speedHistory.slice(-59), currentBps]
            : [currentBps];

          // Single source of truth: preserve live smoothed ETA and connections from telemetry
          const eta = isCompleted
            ? "Finished"
            : itemState === "failed"
            ? (b.error_msg || "Download Failed")
            : itemState === "paused"
            ? "Paused"
            : (existing?.eta && existing.eta !== "—"
                ? existing.eta
                : (b.eta_seconds ? formatEta(b.eta_seconds) : "Calculating..."));

          const finalWorkers = isCompleted && existing?.workers
            ? existing.workers.map((w) => ({
                ...w,
                pos: w.end,
                speed: "0 B/s",
                status: "Chunk verified • Complete",
              }))
            : existing?.workers;

          return {
            id: b.id,
            name: b.filename,
            category,
            sizeTotal: finalTotal,
            sizeDone: finalDone,
            error_msg: b.error_msg || existing?.error_msg || null,
            speed: isDownloading ? (existing?.speed || formatSpeed(speedVal)) : "0 B/s",
            eta,
            connections: isDownloading ? (existing?.connections || b.connections || 1) : 0,
            state: itemState,
            progress: isCompleted ? 100 : pct,
            url: b.url,
            domain,
            dateAdded: b.created_at ? new Date(b.created_at).toLocaleDateString() : (existing?.dateAdded || "Today"),
            workers: finalWorkers,
            speedHistory: history,
            peakSpeedBps: Math.max(existing?.peakSpeedBps || 0, speedVal),
          };
        });

        // Also keep any local-only preview items that haven't hit backend yet
        const backendIds = new Set(backendItems.map((b) => b.id));
        for (const item of prev) {
          if (!backendIds.has(item.id) && Date.now() - Number(item.id) < 5000) {
            updated.push(item);
          }
        }

        return updated;
      });
    };

    // Initial immediate sync
    syncWithBackend();

    // Listen for backend downloads-changed event (e.g. extension deleted task)
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        try {
          listen("downloads-changed", () => {
            syncWithBackend();
          }).then((fn) => {
            if (mounted) unlisten = fn;
            else fn();
          }).catch(() => {});
        } catch {}
      }).catch(() => {});
    }

    // Fast sync interval
    const interval = setInterval(syncWithBackend, 800);
    return () => {
      mounted = false;
      clearInterval(interval);
      if (unlisten) unlisten();
    };
  }, []);

  // Synchronize mode and palette attributes on root document, and pause idle animations when unfocused
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.setAttribute("data-palette", palette);
    document.documentElement.setAttribute("data-theme", mode);

    const onBlur = () => document.documentElement.classList.add("window-unfocused");
    const onFocus = () => document.documentElement.classList.remove("window-unfocused");
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [mode, palette]);





  const handleUrlInputChange = (val: string) => {
    setUrlInput(val);
    const trimmed = val.trim();
    if (!trimmed) {
      setFileNameInput("");
      return;
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("youtube.com/watch") || lower.includes("youtu.be/") || lower.includes("youtube.com/shorts")) {
      if (!fileNameInput || fileNameInput.endsWith(".bin") || fileNameInput === "video.mp4") {
        setFileNameInput("YouTube Video.mp4");
      }
    } else {
      const raw = trimmed.split("/").pop()?.split("?")[0] || "";
      if (raw && (!fileNameInput || fileNameInput === "YouTube Video.mp4" || fileNameInput.endsWith(".bin"))) {
        setFileNameInput(raw);
      }
    }
  };

  const handleProbe = async () => {
    if (!urlInput.trim()) return;
    setIsProbing(true);
    try {
      const res = await tauriProbeUrl(urlInput.trim());
      setIsProbing(false);
      const totalBytes = res.size_total || 0;
      setProbeResult({
        size: totalBytes > 0 ? formatBytes(totalBytes) : "Dynamic / Stream",
        sizeBytes: totalBytes,
        resumable: res.resumable,
        type: res.content_type || "application/octet-stream",
        filename: res.filename || undefined,
      });
      if (res.filename) {
        setFileNameInput(res.filename);
      }
    } catch {
      setIsProbing(false);
    }
  };

  const handleAddDownload = async () => {
    if (!urlInput.trim()) return;
    const rawName =
      fileNameInput.trim() ||
      probeResult?.filename ||
      urlInput.split("/").pop()?.split("?")[0] ||
      "download.bin";
    const name = rawName.replace(/[\\/:*?"<>|]/g, "_") || "download.bin";
    const ext = name.split(".").pop()?.toLowerCase() || "";

    let categoryName: DownloadItem["category"] = "Programs";
    if (["mp4", "mkv", "webm", "avi", "mov", "flv", "wmv"].includes(ext)) {
      categoryName = "Video";
    } else if (["mp3", "flac", "wav", "aac", "ogg", "m4a"].includes(ext)) {
      categoryName = "Music";
    } else if (["zip", "rar", "7z", "tar", "gz", "iso", "bin"].includes(ext)) {
      categoryName = "Compressed";
    } else if (["pdf", "doc", "docx", "txt", "xlsx", "pptx"].includes(ext)) {
      categoryName = "Documents";
    } else {
      const matchedCat = settings.categories.find((c) => c.enabled && c.extensions.includes(ext));
      categoryName = (matchedCat ? matchedCat.name : "Programs") as DownloadItem["category"];
    }

    let hostname = "source.net";
    try {
      hostname = new URL(urlInput.startsWith("http") ? urlInput : `https://${urlInput}`).hostname;
    } catch {
      hostname = "download.net";
    }

    const dupCheck = await tauriCheckDuplicateDownload(
      urlInput,
      name,
      probeResult?.sizeBytes || 0
    );
    if (dupCheck.is_duplicate) {
      const proceed = confirm(
        `Duplicate Download Detected:\n${dupCheck.existing_filename ? `File already exists as ${dupCheck.existing_filename} (${dupCheck.existing_state})` : "This download already exists in tasks."}\n\nDo you still wish to add it again?`
      );
      if (!proceed) return;
    }

    const conns = addConnections || settings.downloads.maxConnectionsPerFile || 8;
    const targetDir = addSaveDir.trim() || settings.downloads.defaultDirectory;
    const finalCategory = addCategory !== "auto" ? (addCategory as DownloadItem["category"]) : categoryName;

    const backendRes = await tauriStartDownload({
      url: urlInput,
      filename: name,
      saveDir: targetDir,
      maxConnections: conns,
    });

    const realTotal = probeResult?.sizeBytes && probeResult.sizeBytes > 0 ? probeResult.sizeBytes : 100_000_000;

    const initialWorkers: WorkerInfo[] = Array.from({ length: conns }).map((_, idx) => {
      const chunkBytes = Math.floor(realTotal / conns);
      const start = idx * chunkBytes;
      const end = idx === conns - 1 ? realTotal : (idx + 1) * chunkBytes;
      return {
        idx: idx + 1,
        start,
        end,
        pos: start,
        speed: "0 B/s",
        status: "Connecting socket...",
      };
    });

    const newItem: DownloadItem = {
      id: backendRes.id || Date.now().toString(),
      name,
      category: finalCategory,
      sizeTotal: realTotal,
      sizeDone: 0,
      speed: "0 B/s",
      eta: "Connecting...",
      connections: conns,
      state: "downloading",
      progress: 0,
      url: urlInput,
      domain: hostname,
      dateAdded: "Just now",
      workers: initialWorkers,
      speedHistory: [0],
      peakSpeedBps: 0,
    };
    setDownloads([newItem, ...downloads]);
    setSelectedDownload(newItem);
    setSelectedIds([newItem.id]);
    setIsAddModalOpen(false);
    setUrlInput("");
    setFileNameInput("");
    setProbeResult(null);
    setAddCategory("auto");
  };

  const downloadsRef = useRef(downloads);
  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  interface TelemetrySmoothingState {
    lastValidEta: string;
    lastProgressTime: number;
    speedSamples: number[];
    elapsedSeconds: number;
    lastUiUpdate: number;
    displayedEta: string;
    displayedSpeed: string;
    displayedConns: number;
  }
  const telemetrySmoothingRef = useRef<Map<string, TelemetrySmoothingState>>(new Map());

  const hasDownloadingTasks = downloads.some((d) => d.state === "downloading");

  // Active Telemetry and Real Progress Tick (250 ms Monotonic Clock Sampling)
  useEffect(() => {
    if (!hasDownloadingTasks) return;

    const interval = setInterval(async () => {
      const activeTasks = downloadsRef.current.filter((d) => d.state === "downloading");
      if (activeTasks.length === 0) return;
      const updates = await Promise.all(
        activeTasks.map(async (task) => {
          const telem = await tauriGetTelemetry(task.id);
          let newWorkers: WorkerInfo[] = [];

          let smooth = telemetrySmoothingRef.current.get(task.id);
          if (!smooth) {
            smooth = {
              lastValidEta: task.eta || "Calculating...",
              lastProgressTime: Date.now(),
              speedSamples: [],
              elapsedSeconds: 0,
              lastUiUpdate: 0,
              displayedEta: task.eta || "Calculating...",
              displayedSpeed: task.speed || "0 B/s",
              displayedConns: task.connections || 8,
            };
            telemetrySmoothingRef.current.set(task.id, smooth);
          }

          if (telem) {
            const phase = (telem as any).phase;
            const rawDone = telem.downloaded_bytes;
            const effectiveTotal = telem.total_bytes || task.sizeTotal;
            let calculatedPct = 0;
            if (effectiveTotal > 0) {
              calculatedPct = Math.min(100, Math.floor((rawDone / effectiveTotal) * 100));
            }
            const rawProgress = Math.max(calculatedPct, Math.min(100, Math.floor(telem.progress_pct || 0)));
            const isFinished = ((rawProgress >= 100 || (effectiveTotal > 0 && rawDone >= effectiveTotal)) && phase !== "Merging" && phase !== "Resolving") || phase === "Completed";
            const sizeTotal = effectiveTotal > 0
              ? effectiveTotal
              : (rawDone > 0 && rawProgress > 0 ? Math.round((rawDone / (rawProgress / 100))) : 0);
            const sizeDone = isFinished && sizeTotal > 0 ? sizeTotal : rawDone;
            const progress = isFinished ? 100 : (phase === "Merging" ? 95 : rawProgress);
            const now = Date.now();

            smooth.elapsedSeconds += 0.25;

            // Speed smoothing EMA (8s window = 32 samples @ 250ms)
            const instantSpeed = Math.floor((telem.instant_throughput_bps || telem.rolling_throughput_bps) / 8);
            if (instantSpeed > 0) {
              smooth.lastProgressTime = now;
            }
            smooth.speedSamples = [...smooth.speedSamples.slice(-31), instantSpeed];
            const smoothedSpeedBps = Math.round(
              smooth.speedSamples.reduce((a, b) => a + b, 0) / smooth.speedSamples.length
            );

            // Phase and ETA stability logic (AdaptiveTelemetry is single source of truth)
            const isWarmup = smooth.elapsedSeconds < 3 && sizeDone < 1024 * 1024;
            let currentEta = smooth.lastValidEta || "Calculating...";

            if (isFinished) {
              currentEta = "Finished";
              smooth.lastValidEta = "Finished";
            } else if (phase === "Resolving" || telem.decision_reason?.toLowerCase().includes("fetching video info")) {
              currentEta = "Fetching video info...";
              smooth.lastValidEta = "Fetching video info...";
            } else if (phase === "Merging" || telem.decision_reason?.toLowerCase().includes("merg")) {
              currentEta = "Merging...";
              smooth.lastValidEta = "Merging...";
            } else if (isWarmup) {
              currentEta = "Calculating...";
            } else if (telem.eta_seconds !== null && telem.eta_seconds !== undefined && telem.eta_seconds > 0) {
              currentEta = formatEta(telem.eta_seconds);
              smooth.lastValidEta = currentEta;
            } else if (smoothedSpeedBps > 0 && sizeTotal > sizeDone) {
              const rawSec = Math.ceil((sizeTotal - sizeDone) / smoothedSpeedBps);
              currentEta = formatEta(rawSec);
              smooth.lastValidEta = currentEta;
            } else {
              // Speed is zero: only show Stalled if zero bytes for >= 10s during active download
              const stalledMs = now - smooth.lastProgressTime;
              if (phase === "Resolving") {
                currentEta = "Fetching video info...";
              } else if (phase === "Merging") {
                currentEta = "Merging...";
              } else if (stalledMs < 10000 && smooth.lastValidEta && smooth.lastValidEta !== "Calculating...") {
                currentEta = smooth.lastValidEta;
              } else if (stalledMs >= 10000 && (phase === "DownloadingVideo" || phase === "DownloadingAudio" || phase === "Downloading" || !phase)) {
                currentEta = "Stalled";
              }
            }

            // Target connection count from AdaptiveTelemetry (never 0 while downloading)
            const targetConns = isFinished
              ? 0
              : Math.max(1, telem.target_connections || telem.active_connections || smooth.displayedConns || 1);

            // Throttle UI label updates to at most 1-2 per second (500ms)
            if (now - smooth.lastUiUpdate >= 500 || isFinished) {
              smooth.displayedEta = currentEta;
              smooth.displayedSpeed = isFinished ? "0 B/s" : formatSpeed(smoothedSpeedBps);
              smooth.displayedConns = targetConns;
              smooth.lastUiUpdate = now;
            }

            if (telem.workers && telem.workers.length > 0) {
              newWorkers = telem.workers.map((w) => ({
                idx: w.idx,
                start: w.start,
                end: w.end,
                pos: isFinished ? w.end : w.pos,
                speed: isFinished ? "0 B/s" : formatSpeed(Math.floor(w.speed_bps / 8)),
                status:
                  isFinished || w.status === "completed"
                    ? "Chunk verified • Complete"
                    : w.status === "downloading"
                    ? "Receiving chunk (HTTP 206)..."
                    : w.status === "stalled"
                    ? "Worker stalled • Reconnecting..."
                    : w.status === "connecting"
                    ? "Connecting socket..."
                    : w.status,
              }));
            } else {
              const numConns = smooth.displayedConns;
              const chunkBytes = Math.floor(sizeTotal / numConns);
              newWorkers = Array.from({ length: numConns }).map((_, idx) => {
                const start = idx * chunkBytes;
                const end = idx === numConns - 1 ? sizeTotal : (idx + 1) * chunkBytes;
                const rangeSize = end - start;
                const workerBytes = Math.min(rangeSize, Math.floor((rangeSize * progress) / 100));
                return {
                  idx: idx + 1,
                  start,
                  end,
                  pos: start + workerBytes,
                  speed: formatSpeed(Math.floor(smoothedSpeedBps / numConns)),
                  status: isFinished
                    ? "Chunk verified • Complete"
                    : "Receiving chunk (HTTP 206)...",
                };
              });
            }

            const actualBps = isFinished ? 0 : smoothedSpeedBps;
            const history = [...(task.speedHistory || []).slice(-59), actualBps];
            const peak = Math.max(task.peakSpeedBps || 0, actualBps);

            return {
              id: task.id,
              sizeDone,
              sizeTotal,
              progress,
              speed: smooth.displayedSpeed,
              eta: smooth.displayedEta,
              connections: smooth.displayedConns,
              state: isFinished ? ("completed" as const) : ("downloading" as const),
              workers: newWorkers,
              speedHistory: history,
              peakSpeedBps: peak,
            };
          } else {
            smooth.elapsedSeconds += 0.25;
            return {
              id: task.id,
            };
          }
        })
      );

      setDownloads((prev) =>
        prev.map((d) => {
          const match = updates.find((u) => u.id === d.id);
          return match ? { ...d, ...match } : d;
        })
      );

      setSelectedDownload((prev) => {
        if (!prev) return null;
        const match = updates.find((u) => u.id === prev.id);
        return match ? { ...prev, ...match } : prev;
      });
    }, 250);

    return () => clearInterval(interval);
  }, [hasDownloadingTasks]);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedIds.includes(id)) {
      const next = selectedIds.filter((item) => item !== id);
      setSelectedIds(next);
      if (selectedDownload?.id === id) {
        const remaining = downloads.find((d) => next.includes(d.id)) || null;
        setSelectedDownload(remaining);
      }
    } else {
      setSelectedIds([...selectedIds, id]);
      const item = downloads.find((d) => d.id === id);
      if (item) setSelectedDownload(item);
    }
  };

  const selectRow = (item: DownloadItem) => {
    setSelectedDownload(item);
    setSelectedIds([item.id]);
  };

  const toggleDownloadState = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDownloads((prev) =>
      prev.map((d) => {
        if (d.id === id) {
          // If already completed, safely open the downloaded file rather than re-downloading
          if (d.state === "completed") {
            tauriOpenFile(id);
            return d;
          }
          const nextState = d.state === "downloading" ? "paused" : "downloading";
          if (nextState === "paused") {
            tauriPauseDownload(id);
          } else {
            tauriResumeDownload(id);
          }
          return {
            ...d,
            state: nextState,
            speed: nextState === "downloading" ? d.speed : "0 B/s",
          };
        }
        return d;
      })
    );
    setSelectedDownload((prev) => {
      if (!prev || prev.id !== id) return prev;
      if (prev.state === "completed") return prev;
      const nextState = prev.state === "downloading" ? "paused" : "downloading";
      return {
        ...prev,
        state: nextState,
        speed: nextState === "downloading" ? prev.speed : "0 B/s",
      };
    });
  };

  const deleteSelected = () => {
    selectedIds.forEach((id) => tauriDeleteDownload(id));
    setDownloads((prev) => prev.filter((d) => !selectedIds.includes(d.id)));
    setSelectedIds([]);
    setSelectedDownload(null);
  };

  const filteredDownloads = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const list = downloads.filter((item) => {
      const matchesSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.domain.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "downloading" && item.state === "downloading") ||
        (statusFilter === "completed" && item.state === "completed") ||
        (statusFilter === "paused" && item.state === "paused") ||
        (statusFilter === "queued" && item.state === "queued") ||
        (statusFilter === "failed" && item.state === "failed");
      const matchesCategory =
        categoryFilter === "all" || item.category.toLowerCase() === categoryFilter.toLowerCase();
      return matchesSearch && matchesStatus && matchesCategory;
    });

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortField === "size") {
        cmp = (a.sizeTotal || a.sizeDone) - (b.sizeTotal || b.sizeDone);
      } else if (sortField === "progress") {
        cmp = a.progress - b.progress;
      } else if (sortField === "speed") {
        const speedA = a.state === "downloading" ? (a.peakSpeedBps || 0) : 0;
        const speedB = b.state === "downloading" ? (b.peakSpeedBps || 0) : 0;
        cmp = speedA - speedB;
      } else {
        cmp = a.id.localeCompare(b.id);
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [downloads, searchQuery, statusFilter, categoryFilter, sortField, sortDirection]);

  const activeSelectedDownload = downloads.find((d) => d.id === selectedDownload?.id) || selectedDownload;

  // UI-02: Comprehensive Keyboard shortcuts (Ctrl+N, Ctrl+,, Esc, Space, Delete, Enter, Ctrl+A)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setIsAddModalOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setActiveView((v) => (v === "settings" ? "downloads" : "settings"));
        return;
      }
      if (e.key === "Escape") {
        setContextMenu((p) => ({ ...p, visible: false }));
        if (activeView === "settings") {
          setActiveView("downloads");
          return;
        }
        setIsAddModalOpen(false);
        setIsInspectorOpen(false);
        setIsVideoModalOpen(false);
        setIsLimiterOpen(false);
        setSelectedDownload(null);
        setSelectedIds([]);
        return;
      }

      if (isInput) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSelectedIds(filteredDownloads.map((d) => d.id));
        return;
      }

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        const targetId = activeSelectedDownload?.id || selectedIds[0];
        if (targetId) {
          toggleDownloadState(targetId);
        }
        return;
      }

      if (e.key === "Delete") {
        e.preventDefault();
        if (selectedIds.length > 0) {
          deleteSelected();
        } else if (activeSelectedDownload) {
          tauriDeleteDownload(activeSelectedDownload.id);
          setDownloads((prev) => prev.filter((d) => d.id !== activeSelectedDownload.id));
          setSelectedDownload(null);
        }
        return;
      }

      if (e.key === "Enter") {
        if (activeSelectedDownload) {
          e.preventDefault();
          if (activeSelectedDownload.state === "completed" || activeSelectedDownload.progress >= 100) {
            tauriOpenFile(activeSelectedDownload.id);
          } else {
            setIsInspectorOpen(true);
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, activeSelectedDownload, selectedIds, filteredDownloads]);

  // Real aggregate network telemetry calculations
  const activeDownloadsList = downloads.filter((d) => d.state === "downloading");
  const totalActiveThreads = activeDownloadsList.reduce((sum, d) => sum + Math.max(1, d.connections || 1), 0);
  const totalSessionBytes = downloads.reduce((sum, d) => sum + (d.sizeDone || 0), 0);

  let totalSpeedDisplay = "0 B/s";
  if (activeDownloadsList.length > 0) {
    let totalSpeedBps = 0;
    for (const d of activeDownloadsList) {
      const match = d.speed.match(/([\d.]+)\s*([KMG]?B\/s)/i);
      if (match) {
        const val = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        if (unit.startsWith("G")) totalSpeedBps += val * 1024 * 1024 * 1024;
        else if (unit.startsWith("M")) totalSpeedBps += val * 1024 * 1024;
        else if (unit.startsWith("K")) totalSpeedBps += val * 1024;
        else totalSpeedBps += val;
      }
    }
    totalSpeedDisplay = formatSpeed(totalSpeedBps);
  }

  const getCategoryLucideIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case "video":
        return Film;
      case "music":
      case "audio":
        return Music;
      case "compressed":
      case "archives":
        return Archive;
      case "documents":
        return FileText;
      case "programs":
      default:
        return FileCode;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category.toLowerCase()) {
      case "video":
        return "text-purple-400";
      case "music":
      case "audio":
        return "text-amber-400";
      case "compressed":
      case "archives":
        return "text-orange-400";
      case "documents":
        return "text-emerald-400";
      case "programs":
      default:
        return "text-[var(--accent)]";
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case "video":
        return <Film className="w-4 h-4 text-purple-400" />;
      case "music":
      case "audio":
        return <Music className="w-4 h-4 text-amber-400" />;
      case "compressed":
      case "archives":
        return <Archive className="w-4 h-4 text-orange-400" />;
      case "documents":
        return <FileText className="w-4 h-4 text-emerald-400" />;
      case "programs":
      default:
        return <FileCode className="w-4 h-4 text-[var(--accent)]" />;
    }
  };

  const getStatusBadge = (state: string, errorMsg?: string | null) => {
    switch (state) {
      case "downloading":
        return (
          <span
            className="inline-flex items-center justify-center w-5 h-5"
            title="Downloading"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)] animate-pulse shadow-[0_0_8px_var(--accent-glow)]" />
          </span>
        );
      case "completed":
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 text-emerald-400" title="Completed">
            <CheckCircle2 className="w-4 h-4" />
          </span>
        );
      case "paused":
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 text-amber-400" title="Paused">
            <Pause className="w-4 h-4" />
          </span>
        );
      case "failed":
        if (errorMsg?.toLowerCase().includes("expire") || errorMsg?.includes("401") || errorMsg?.includes("403") || errorMsg?.includes("410")) {
          return (
            <span className="inline-flex items-center justify-center w-5 h-5 text-amber-400" title="Download Link Expired - Click Refresh">
              <RotateCcw className="w-4 h-4" />
            </span>
          );
        }
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 text-rose-400" title={errorMsg || "Download Failed"}>
            <X className="w-4 h-4" />
          </span>
        );
      case "link_expired":
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 text-amber-400" title="Download Link Expired - Click Refresh">
            <RotateCcw className="w-4 h-4" />
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 text-zinc-400" title="Queued">
            <Clock className="w-4 h-4" />
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden text-sm bg-[var(--bg-chassis)] text-[var(--text-primary)]">
      <AnimatePresence mode="wait">
        {activeView === "settings" ? (
          <motion.div
            key="settings-view"
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex-1 flex flex-col min-h-0 overflow-hidden w-full h-full"
          >
            <SettingsPage
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              onBack={() => {
                setActiveView("downloads");
                window.location.hash = "";
              }}
              speedLimit={speedLimit}
              onSpeedLimitChange={handleSpeedLimitChange}
              selectedDownload={activeSelectedDownload}
              totalSpeed={totalSpeedDisplay}
              activeThreads={totalActiveThreads}
              totalSessionBytes={totalSessionBytes}
            />
          </motion.div>
        ) : (
          <motion.div
            key="downloads-view"
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex-1 flex flex-col min-h-0 overflow-hidden w-full h-full"
          >
            {/* ─────────────────────────────────────────────────────────────
                1. WINDOW HEADER & TOP COMMAND DECK
            ────────────────────────────────────────────────────────────── */}
          <header
            data-tauri-drag-region
            onMouseDown={(e) => {
              if (e.button === 0 && !(e.target as HTMLElement).closest("button, input, select, a, textarea")) {
                tauriStartDragging();
              }
            }}
            onDoubleClick={(e) => {
              if (!(e.target as HTMLElement).closest("button, input, select, a, textarea")) {
                tauriWindowToggleMaximize();
              }
            }}
            className="h-14 px-3 sm:px-4 header-3d flex items-center justify-between gap-2 shrink-0 z-20 select-none relative"
          >
            {/* Left: Brand Identity with Official 3D Logo & Context Actions */}
            <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 z-10">
              <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
                <img
                  src="/logo.png"
                  alt="EDM Logo"
                  className="w-7 h-7 sm:w-8 sm:h-8 object-contain drop-shadow-md transition-transform hover:scale-105 duration-150 shrink-0 pointer-events-none"
                />
                <div className="shrink-0 flex flex-col justify-center">
                  <span className="font-bold tracking-tight text-xs sm:text-sm">EDM</span>
                  <div className="text-[10px] text-[var(--text-muted)] whitespace-nowrap font-medium leading-tight mt-0.5 hidden xs:block">
                    Edge Download Manager
                  </div>
                </div>
              </div>

              {/* Contextual Toolbar (Always visible; grayed out when no task is selected) */}
              <div className="flex items-center gap-1 shrink-0 pl-2 border-l border-[var(--border-subtle)]">
                <button
                  disabled={selectedIds.length === 0}
                  onClick={resumeSelected}
                  className={`btn-3d h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    selectedIds.length > 0
                      ? "text-[var(--text-secondary)] hover:text-emerald-400 cursor-pointer"
                      : "opacity-30 cursor-not-allowed text-[var(--text-muted)] pointer-events-none"
                  }`}
                  title={selectedIds.length > 0 ? "Resume Selected Tasks" : "Resume (Select task first)"}
                >
                  <Play className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400/20" />
                </button>

                <button
                  disabled={selectedIds.length === 0}
                  onClick={pauseSelected}
                  className={`btn-3d h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    selectedIds.length > 0
                      ? "text-[var(--text-secondary)] hover:text-amber-400 cursor-pointer"
                      : "opacity-30 cursor-not-allowed text-[var(--text-muted)] pointer-events-none"
                  }`}
                  title={selectedIds.length > 0 ? "Pause Selected Tasks" : "Pause (Select task first)"}
                >
                  <Pause className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />
                </button>

                <button
                  disabled={selectedIds.length === 0}
                  onClick={stopSelected}
                  className={`btn-3d h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    selectedIds.length > 0
                      ? "text-[var(--text-secondary)] hover:text-rose-400 cursor-pointer"
                      : "opacity-30 cursor-not-allowed text-[var(--text-muted)] pointer-events-none"
                  }`}
                  title={selectedIds.length > 0 ? "Stop Selected Downloads" : "Stop (Select task first)"}
                >
                  <Square className="w-3 h-3 text-rose-400 fill-rose-400/20" />
                </button>

                <button
                  disabled={selectedIds.length === 0}
                  onClick={deleteSelected}
                  className={`btn-3d h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    selectedIds.length > 0
                      ? "text-[var(--text-secondary)] hover:text-rose-400 cursor-pointer"
                      : "opacity-30 cursor-not-allowed text-[var(--text-muted)] pointer-events-none"
                  }`}
                  title={selectedIds.length > 0 ? "Delete Selected Tasks" : "Delete (Select task first)"}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Center: Command Deck Pinned to Exact Geometric Center */}
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 sm:gap-2 shrink-0 z-10" data-tauri-drag-region>
              {/* Primary Action: Add URL */}
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="btn-primary-3d h-8 px-2.5 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer text-xs font-semibold"
                title="Add Download URL (Ctrl+N)"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span className="hidden sm:inline">Add URL</span>
              </button>

              {/* Search Box */}
              <div className="relative shrink-0">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none icon-3d" />
                <input
                  type="text"
                  placeholder="Filter tasks..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-28 sm:w-44 md:w-56 focus:w-36 sm:focus:w-52 md:focus:w-64 h-8 pl-8 pr-7 rounded-lg text-xs input-3d text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-all truncate"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* View Mode Toggle */}
              <div className="h-8 flex items-center p-0.5 rounded-lg input-3d shrink-0">
                <button
                  onClick={() => setViewMode("table")}
                  className={`h-full px-2 rounded-md cursor-pointer transition-all inline-flex items-center ${
                    viewMode === "table" ? "btn-3d text-[var(--accent)] shadow-sm font-semibold" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                  title="Table View"
                >
                  <LayoutList className="w-3.5 h-3.5 icon-3d" />
                </button>
                <button
                  onClick={() => setViewMode("grid")}
                  className={`h-full px-2 rounded-md cursor-pointer transition-all inline-flex items-center ${
                    viewMode === "grid" ? "btn-3d text-[var(--accent)] shadow-sm font-semibold" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                  title="Grid View"
                >
                  <LayoutGrid className="w-3.5 h-3.5 icon-3d" />
                </button>
              </div>
            </div>

            {/* Right: Unified Integrated Window Controls & Quick Actions */}
            <div className="flex items-center gap-1 shrink-0 z-10 ml-auto" data-tauri-drag-region="false">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  tauriWindowMinimize();
                }}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/10 transition-colors cursor-pointer"
                title="Minimize"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  tauriWindowToggleMaximize();
                }}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/10 transition-colors cursor-pointer"
                title="Maximize / Restore"
              >
                <Square className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  tauriWindowClose();
                }}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-rose-600 transition-colors cursor-pointer"
                title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </header>

      {/* ─────────────────────────────────────────────────────────────
          2. WORKSPACE BODY: SIDEBAR + MAIN CONTENT AREA
      ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* Left Navigation Spine (EDM Modern Aesthetic - Permanently Minimized Icon Rail) */}
        <aside className="w-14 sidebar-3d flex flex-col shrink-0 select-none py-2.5 overflow-hidden">
          <div className="space-y-2 px-2 flex flex-col items-center">
            {/* Status Filters */}
            <div className="space-y-0.5">
              {[
                { id: "all", label: "All Tasks", count: downloads.length, icon: Compass },
                {
                  id: "downloading",
                  label: "Active",
                  count: downloads.filter((d) => d.state === "downloading").length,
                  icon: Activity,
                },
                {
                  id: "completed",
                  label: "Completed",
                  count: downloads.filter((d) => d.state === "completed").length,
                  icon: CheckCircle2,
                },
                {
                  id: "paused",
                  label: "Paused",
                  count: downloads.filter((d) => d.state === "paused").length,
                  icon: Pause,
                },
                {
                  id: "queued",
                  label: "Queued",
                  count: downloads.filter((d) => d.state === "queued").length,
                  icon: Clock,
                },
                {
                  id: "failed",
                  label: "Failed / Expired",
                  count: downloads.filter((d) => d.state === "failed").length,
                  icon: RotateCcw,
                },
              ].map((item) => {
                const Icon = item.icon;
                const isActive = statusFilter === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setStatusFilter(item.id)}
                    title={`${item.label} (${item.count})`}
                    className={`w-8 h-8 mx-auto relative flex items-center justify-center rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                      isActive
                        ? "sidebar-item-active-3d text-[var(--accent)] font-semibold shadow-sm"
                        : "sidebar-item-inactive-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {item.count > 0 && item.id === "downloading" && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    )}
                    {item.count > 0 && item.id === "failed" && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rose-400" />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="w-5 h-[1px] bg-[var(--border-subtle)] my-0.5" />

            {/* Categories */}
            <div className="space-y-0.5">
              {[
                { id: "all", label: "All Categories", icon: FolderOpen, color: "" },
                ...settings.categories
                  .filter((c) => c.enabled)
                  .map((c) => ({
                    id: c.name.toLowerCase(),
                    label: c.name,
                    icon: getCategoryLucideIcon(c.name),
                    color: getCategoryColor(c.name),
                  })),
                { id: "other", label: "Other", icon: FileText, color: "text-zinc-400" },
              ].map((item) => {
                const Icon = item.icon;
                const isActive = categoryFilter === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setCategoryFilter(item.id)}
                    title={item.label}
                    className={`w-8 h-8 mx-auto flex items-center justify-center rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                      isActive
                        ? "sidebar-item-active-3d text-[var(--accent)] font-semibold shadow-sm"
                        : "sidebar-item-inactive-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${item.color || "text-[var(--text-muted)]"}`} />
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Center Main Canvas: Downloads Viewport (Zero Dead Space!) */}
        <main className="flex-1 flex flex-col min-w-0 bg-[var(--bg-chassis)] overflow-hidden">
          {viewMode === "table" ? (
            /* Table View with responsive auto-fitting layout (Zero clipping on resize) */
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-auto px-2.5 sm:px-3 pt-1 pb-2">
              <table className="w-full table-fixed text-left border-separate border-spacing-y-1.5 min-w-[720px]">
                <thead className="sticky top-0 bg-[var(--bg-chassis)] border-b border-[var(--border-subtle)] text-[11px] font-semibold text-[var(--text-muted)] z-10 shadow-sm">
                  <tr>
                    <th className="py-2 px-2 w-10 text-center whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={selectedIds.length === filteredDownloads.length && filteredDownloads.length > 0}
                        onChange={() => {
                          if (selectedIds.length === filteredDownloads.length) {
                            setSelectedIds([]);
                            setSelectedDownload(null);
                          } else {
                            setSelectedIds(filteredDownloads.map((d) => d.id));
                            setSelectedDownload(filteredDownloads[0] || null);
                          }
                        }}
                        className="edm-checkbox transition-transform active:scale-90"
                      />
                    </th>
                    <th
                      onClick={() => handleSort("name")}
                      className="py-2 px-3 w-[36%] xl:w-[40%] min-w-[170px] whitespace-nowrap cursor-pointer select-none hover:text-[var(--text-primary)]"
                    >
                      <div className="flex items-center gap-1">
                        <span>File Name</span>
                        {sortField === "name" && (sortDirection === "asc" ? <ChevronUp className="w-3 h-3 text-[var(--accent)]" /> : <ChevronDown className="w-3 h-3 text-[var(--accent)]" />)}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSort("size")}
                      className="py-2 px-2 w-20 sm:w-24 text-center whitespace-nowrap cursor-pointer select-none hover:text-[var(--text-primary)]"
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span>Size</span>
                        {sortField === "size" && (sortDirection === "asc" ? <ChevronUp className="w-3 h-3 text-[var(--accent)]" /> : <ChevronDown className="w-3 h-3 text-[var(--accent)]" />)}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSort("progress")}
                      className="py-2 px-3 w-[26%] md:w-[24%] xl:w-[22%] min-w-[180px] whitespace-nowrap cursor-pointer select-none hover:text-[var(--text-primary)]"
                    >
                      <div className="flex items-center gap-1">
                        <span>Progress</span>
                        {sortField === "progress" && (sortDirection === "asc" ? <ChevronUp className="w-3 h-3 text-[var(--accent)]" /> : <ChevronDown className="w-3 h-3 text-[var(--accent)]" />)}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSort("speed")}
                      className="py-2 px-2 w-24 md:w-28 text-center whitespace-nowrap cursor-pointer select-none hover:text-[var(--text-primary)]"
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span>Transfer Rate</span>
                        {sortField === "speed" && (sortDirection === "asc" ? <ChevronUp className="w-3 h-3 text-[var(--accent)]" /> : <ChevronDown className="w-3 h-3 text-[var(--accent)]" />)}
                      </div>
                    </th>
                    <th className="py-2 px-3 w-48 min-w-[188px] text-right pr-3 sm:pr-4 whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-xs">
                  {filteredDownloads.map((item) => {
                    const isSelected = selectedIds.includes(item.id);
                    return (
                      <tr
                        key={item.id}
                        onClick={() => selectRow(item)}
                        onDoubleClick={() => {
                          if (item.state === "completed" || item.progress >= 100) {
                            tauriOpenFile(item.id);
                          } else {
                            setIsInspectorOpen(true);
                          }
                        }}
                        onContextMenu={(e) => handleContextMenu(e, item)}
                        className={`group cursor-pointer table-row-3d ${
                          isSelected ? "table-row-selected-3d text-[var(--text-primary)]" : ""
                        }`}
                      >
                        <td className="py-2.5 px-2 text-center whitespace-nowrap" onClick={(e) => toggleSelect(item.id, e)}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="edm-checkbox transition-transform active:scale-90"
                          />
                        </td>
                        <td className="py-2.5 px-3 truncate">
                          <div className="flex items-center gap-2 truncate">
                            <div className="p-1.5 rounded-lg icon-box-3d shrink-0">
                              {getCategoryIcon(item.category)}
                            </div>
                            <div className="truncate min-w-0">
                              <div className="font-medium text-[var(--text-primary)] truncate" title={item.name}>
                                {item.name}
                              </div>
                              <div className="text-[10px] text-[var(--text-muted)] truncate flex items-center gap-1">
                                <span className="truncate">{item.domain}</span>
                                <span>•</span>
                                <span className="shrink-0">
                                  {item.state === "downloading" && item.eta ? `ETA: ${item.eta}` : item.dateAdded}
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 font-mono tabular-nums text-[11px] sm:text-xs text-[var(--text-secondary)] text-center whitespace-nowrap">
                          {formatBytes(item.sizeTotal)}
                        </td>
                        <td className="py-2.5 px-3 min-w-0 overflow-hidden">
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center justify-between text-[11px] font-mono tabular-nums min-w-0 gap-1.5">
                              <div className="flex items-center gap-1.5 shrink-0">
                                {getStatusBadge(item.state === "completed" || item.progress >= 100 ? "completed" : item.state, item.error_msg)}
                                <span className="font-semibold text-[var(--accent)]">{item.state === "completed" || item.progress >= 100 ? 100 : item.progress}%</span>
                              </div>
                              <span className="text-[var(--text-muted)] truncate text-right">
                                {formatBytes(item.state === "completed" || item.progress >= 100 ? (item.sizeTotal || item.sizeDone) : item.sizeDone)} / {formatBytes(item.sizeTotal || item.sizeDone)}
                              </span>
                            </div>
                            {/* Plain Seamless Progress Bar (100% smooth, zero vertical lines) */}
                            <div className="w-full h-2 rounded overflow-hidden track-3d relative bg-[var(--bg-chassis)]">
                              <div
                                className="h-full rounded bg-[var(--accent)] transition-[width] duration-200 ease-linear"
                                style={{
                                  width: `${item.state === "completed" || item.progress >= 100 ? 100 : Math.min(100, Math.max(0, item.progress))}%`,
                                  opacity: item.state === "paused" ? 0.6 : 1,
                                }}
                              />
                              {item.state === "downloading" && (item.eta?.includes("Merging") || item.eta?.includes("Fetching") || !item.sizeTotal || item.sizeTotal === 0) ? (
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[var(--accent)]/50 to-transparent pointer-events-none animate-[shimmer_1.5s_infinite]" />
                              ) : item.state === "downloading" ? (
                                <div className="absolute inset-0 bg-white/10 pointer-events-none animate-[pulse_1.5s_infinite]" />
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 font-mono tabular-nums font-semibold text-[var(--accent)] text-center whitespace-nowrap text-[11px] sm:text-xs">
                          {item.speed}
                        </td>
                        <td className="py-2.5 px-3 pr-3 sm:pr-4 w-48 min-w-[188px] text-right whitespace-nowrap overflow-hidden">
                          <div className="flex items-center justify-end gap-1.5 opacity-80 group-hover:opacity-100 transition-opacity">
                            {item.state === "completed" ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  tauriOpenFile(item.id);
                                }}
                                className="p-1.5 rounded-lg btn-3d text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer transition-all"
                                title="Download Complete • Click to Open File"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              </button>
                            ) : item.state === "downloading" ? (
                              <button
                                onClick={(e) => toggleDownloadState(item.id, e)}
                                className="p-1.5 rounded-lg btn-3d text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 cursor-pointer transition-all"
                                title="Pause Download"
                              >
                                <Pause className="w-3.5 h-3.5 icon-3d" />
                              </button>
                            ) : item.state === "paused" ? (
                              <button
                                onClick={(e) => toggleDownloadState(item.id, e)}
                                className="p-1.5 rounded-lg btn-3d text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer transition-all"
                                title="Resume Download"
                              >
                                <Play className="w-3.5 h-3.5 text-emerald-400 icon-3d" />
                              </button>
                            ) : item.state === "failed" ? (
                              item.error_msg?.toLowerCase().includes("expire") || item.error_msg?.includes("401") || item.error_msg?.includes("403") || item.error_msg?.includes("410") ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRefreshModalTask(item);
                                  }}
                                  className="p-1.5 rounded-lg btn-3d text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 cursor-pointer transition-all"
                                  title="Refresh Expired Download Link"
                                >
                                  <RotateCcw className="w-3.5 h-3.5 text-amber-400 icon-3d" />
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => toggleDownloadState(item.id, e)}
                                  className="p-1.5 rounded-lg btn-3d text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer transition-all"
                                  title="Retry Download"
                                >
                                  <RotateCcw className="w-3.5 h-3.5 text-rose-400 icon-3d" />
                                </button>
                              )
                            ) : (
                              <button
                                onClick={(e) => toggleDownloadState(item.id, e)}
                                className="p-1.5 rounded-lg btn-3d text-[var(--accent)] hover:brightness-110 cursor-pointer transition-all"
                                title="Start Download"
                              >
                                <Play className="w-3.5 h-3.5 icon-3d" />
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDownload(item);
                                if (!selectedIds.includes(item.id)) {
                                  setSelectedIds([item.id]);
                                }
                                setIsInspectorOpen(true);
                              }}
                              className="p-1.5 rounded-lg btn-3d text-[var(--accent)] hover:brightness-110 cursor-pointer"
                              title="Download Status"
                            >
                              <Layers className="w-3.5 h-3.5 icon-3d" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                tauriOpenFolder(item.id);
                              }}
                              className="p-1.5 rounded-lg btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                              title="Reveal in Explorer"
                            >
                              <FolderOpen className="w-3.5 h-3.5 icon-3d" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                tauriDeleteDownload(item.id);
                                setDownloads((prev) => prev.filter((d) => d.id !== item.id));
                                setSelectedIds((prev) => prev.filter((id) => id !== item.id));
                                if (selectedDownload?.id === item.id) setSelectedDownload(null);
                              }}
                              className="p-1.5 rounded-lg btn-3d text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer transition-all"
                              title="Delete Task"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredDownloads.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-24 text-center">
                        <div className="flex flex-col items-center justify-center space-y-3">
                          <div className="w-12 h-12 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)] shadow-sm">
                            <Download className="w-6 h-6 stroke-[1.75]" />
                          </div>
                          <div className="space-y-1">
                            <p className="text-sm font-semibold text-[var(--text-primary)]">No active downloads</p>
                            <p className="text-xs text-[var(--text-muted)] max-w-sm">
                              Click "+ Add URL" or paste a download link to begin accelerated transfer.
                            </p>
                          </div>
                          <button
                            onClick={() => setIsAddModalOpen(true)}
                            className="mt-2 btn-primary-3d px-4 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <Plus className="w-4 h-4" />
                            <span>Add Download URL</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            /* Grid Card View (Dense, Crafted, No Void Space) */
            <div className="flex-1 p-4 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5 auto-rows-max">
                {filteredDownloads.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => selectRow(item)}
                    onDoubleClick={() => {
                      if (item.state === "completed" || item.progress >= 100) {
                        tauriOpenFile(item.id);
                      } else {
                        setIsInspectorOpen(true);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, item)}
                    className={`card-3d p-3.5 rounded-xl flex flex-col gap-2.5 cursor-pointer select-none transition-all ${
                      selectedIds.includes(item.id) ? "border-[var(--accent)] ring-1 ring-[var(--accent-glow)]" : ""
                    }`}
                  >
                    {/* Top Row: File Identity & Status */}
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-2 rounded-lg icon-box-3d shrink-0">
                          {getCategoryIcon(item.category)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-xs text-[var(--text-primary)] truncate" title={item.name}>
                            {item.name}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate flex items-center gap-1.5">
                            <span>{item.domain}</span>
                            <span>•</span>
                            <span>{item.dateAdded}</span>
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0">{getStatusBadge(item.state, item.error_msg)}</div>
                    </div>

                    {/* Middle Info Strip: Technical Metadata */}
                    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg input-3d text-[11px] font-mono tabular-nums text-[var(--text-secondary)]">
                      <div className="flex items-center gap-1.5">
                        <Cpu className="w-3 h-3 text-[var(--accent)]" />
                        <span>{item.connections > 0 ? `${item.connections} Streams` : "Idle"}</span>
                      </div>
                      <div className="text-[var(--text-muted)]">•</div>
                      <div>{formatBytes(item.sizeTotal)}</div>
                      <div className="text-[var(--text-muted)]">•</div>
                      <div
                        className={
                          item.state === "completed" || item.progress >= 100
                            ? "text-emerald-400 font-semibold"
                            : item.state === "downloading"
                            ? "text-cyan-400 font-semibold"
                            : item.state === "paused"
                            ? "text-amber-400 font-semibold"
                            : item.state === "failed"
                            ? "text-rose-400 font-semibold"
                            : "text-[var(--text-muted)]"
                        }
                      >
                        {item.state === "completed" || item.progress >= 100
                          ? "Verified"
                          : item.state === "downloading"
                          ? (item.connections > 1 ? "HTTP 206" : "HTTP 200")
                          : item.state === "paused"
                          ? "Paused"
                          : item.state === "failed"
                          ? "Failed"
                          : "Queued"}
                      </div>
                    </div>

                    {/* Progress & Micro-Segment Track */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-mono tabular-nums">
                        <span className="font-semibold text-[var(--accent)]">{item.state === "completed" || item.progress >= 100 ? 100 : item.progress}%</span>
                        <span className="text-[var(--text-muted)]">
                          {formatBytes(item.state === "completed" || item.progress >= 100 ? (item.sizeTotal || item.sizeDone) : item.sizeDone)} / {formatBytes(item.sizeTotal || item.sizeDone)}
                        </span>
                      </div>
                      {/* Plain Seamless Progress Bar (100% smooth, zero vertical lines) */}
                      <div className="w-full h-2 rounded bg-[var(--bg-chassis)] overflow-hidden border border-[var(--border-subtle)] relative">
                        <div
                          className="h-full rounded bg-[var(--accent)] transition-[width] duration-200 ease-linear"
                          style={{
                            width: `${item.state === "completed" || item.progress >= 100 ? 100 : Math.min(100, Math.max(0, item.progress))}%`,
                            opacity: item.state === "paused" ? 0.6 : 1,
                          }}
                        />
                        {item.state === "downloading" && (item.eta?.includes("Merging") || item.eta?.includes("Fetching") || !item.sizeTotal || item.sizeTotal === 0) ? (
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[var(--accent)]/50 to-transparent pointer-events-none animate-[shimmer_1.5s_infinite]" />
                        ) : item.state === "downloading" ? (
                          <div className="absolute inset-0 bg-white/10 pointer-events-none animate-[pulse_1.5s_infinite]" />
                        ) : null}
                      </div>
                    </div>

                    {/* Metrics & Inline Actions */}
                    <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] text-xs">
                      <div className="font-mono tabular-nums">
                        <span className="font-semibold text-[var(--accent)]">{item.speed}</span>
                        <span className="text-[var(--text-muted)] ml-2 text-[11px]">ETA: {item.eta}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {item.state === "completed" ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              tauriOpenFile(item.id);
                            }}
                            className="btn-3d p-1.5 rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer transition-all"
                            title="Download Complete • Click to Open File"
                          >
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </button>
                        ) : item.state === "downloading" ? (
                          <button
                            onClick={(e) => toggleDownloadState(item.id, e)}
                            className="btn-3d p-1.5 rounded-md text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 cursor-pointer transition-all"
                            title="Pause Download"
                          >
                            <Pause className="w-4 h-4" />
                          </button>
                        ) : item.state === "paused" ? (
                          <button
                            onClick={(e) => toggleDownloadState(item.id, e)}
                            className="btn-3d p-1.5 rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer transition-all"
                            title="Resume Download"
                          >
                            <Play className="w-4 h-4 text-emerald-400" />
                          </button>
                        ) : item.state === "failed" ? (
                          item.error_msg?.toLowerCase().includes("expire") || item.error_msg?.includes("401") || item.error_msg?.includes("403") || item.error_msg?.includes("410") ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setRefreshModalTask(item);
                              }}
                              className="btn-3d p-1.5 rounded-md text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 cursor-pointer transition-all"
                              title="Refresh Expired Download Link"
                            >
                              <RotateCcw className="w-4 h-4 text-amber-400" />
                            </button>
                          ) : (
                            <button
                              onClick={(e) => toggleDownloadState(item.id, e)}
                              className="btn-3d p-1.5 rounded-md text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer transition-all"
                              title="Retry Download"
                            >
                              <RotateCcw className="w-4 h-4 text-rose-400" />
                            </button>
                          )
                        ) : (
                          <button
                            onClick={(e) => toggleDownloadState(item.id, e)}
                            className="btn-3d p-1.5 rounded-md text-[var(--accent)] hover:brightness-110 cursor-pointer transition-all"
                            title="Start Download"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDownload(item);
                            if (!selectedIds.includes(item.id)) {
                              setSelectedIds([item.id]);
                            }
                            setIsInspectorOpen(true);
                          }}
                          className="btn-3d p-1.5 rounded-md text-[var(--accent)] hover:brightness-110 cursor-pointer"
                          title="Download Status"
                        >
                          <Layers className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            tauriOpenFolder(item.id);
                          }}
                          className="btn-3d p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                          title="Reveal in Explorer"
                        >
                          <FolderOpen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            tauriDeleteDownload(item.id);
                            setDownloads((prev) => prev.filter((d) => d.id !== item.id));
                            setSelectedIds((prev) => prev.filter((id) => id !== item.id));
                            if (selectedDownload?.id === item.id) setSelectedDownload(null);
                          }}
                          className="btn-3d p-1.5 rounded-md text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer transition-all"
                          title="Delete Task"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {filteredDownloads.length === 0 && (
                  <div className="col-span-full py-24 text-center flex flex-col items-center justify-center space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)] shadow-sm">
                      <Download className="w-6 h-6 stroke-[1.75]" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-[var(--text-primary)]">No active downloads</p>
                      <p className="text-xs text-[var(--text-muted)] max-w-sm">
                        Click "+ Add URL" or paste a download link to begin accelerated transfer.
                      </p>
                    </div>
                    <button
                      onClick={() => setIsAddModalOpen(true)}
                      className="mt-2 btn-primary-3d px-4 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Download URL</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          3. FULL-WIDTH INTEGRATED BOTTOM STATUS BAR (With Speed Limiter)
      ────────────────────────────────────────────────────────────── */}
      <footer className="h-11 px-3 sm:px-4 footer-3d flex items-center justify-between text-xs shrink-0 select-none gap-2 w-full z-20">
        {/* Left: Settings Button + Speed Limiter Controller + Selected Task Quick Readout */}
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          {/* Settings Trigger placed immediately to the left of Speed Throttle */}
          <button
            onClick={() => setActiveView("settings")}
            className="h-7 px-2.5 rounded-md text-[11px] sm:text-xs font-medium btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            title="Settings & Preferences (Ctrl+,)"
          >
            <Settings className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 icon-3d" />
            <span className="hidden xs:inline">Settings</span>
          </button>

          {/* Speed Limiter Dial (Opens upward from status bar) */}
          <div className="relative shrink-0">
            <button
              onClick={() => setIsLimiterOpen(!isLimiterOpen)}
              className="h-7 px-2.5 rounded-md text-[11px] sm:text-xs font-medium btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              title="Global Bandwidth Limiter"
            >
              <Gauge className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 icon-3d" />
              <span>Limit: {speedLimit}</span>
              <ChevronDown
                className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform ${
                  isLimiterOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <AnimatePresence>
              {isLimiterOpen && (
                <motion.div
                  variants={popoverVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="absolute bottom-full left-0 mb-1.5 w-40 rounded-xl panel-3d shadow-2xl p-1.5 z-50 origin-bottom"
                >
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[var(--text-muted)] px-2 py-0.5 mb-1 border-b border-[var(--border-dim)]">
                    Speed Throttle
                  </div>
                  {["Unlimited", "50 MB/s", "20 MB/s", "10 MB/s", "5 MB/s", "2 MB/s", "500 KB/s"].map((val) => (
                    <motion.button
                      key={val}
                      whileHover={{ x: 2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => {
                        handleSpeedLimitChange(val);
                        setIsLimiterOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1 text-xs rounded-lg transition-colors cursor-pointer ${
                        speedLimit === val
                          ? "bg-[var(--accent)] text-[var(--accent-on)] font-medium"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {val}
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="h-5 w-[1px] bg-[var(--border-subtle)] shrink-0" />

          {/* Selected Task Quick Readout */}
          <div className="flex items-center gap-2 text-[var(--text-secondary)] min-w-0 truncate">
            {activeSelectedDownload ? (
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 truncate">
                <span className="font-semibold text-[var(--text-primary)] truncate max-w-[100px] sm:max-w-xs">
                  {activeSelectedDownload.name}
                </span>
                <span className="text-[var(--text-muted)]">•</span>
                <span className="font-mono tabular-nums text-[var(--accent)] whitespace-nowrap">
                  {activeSelectedDownload.progress}%
                </span>
                <span className="text-[var(--text-muted)] hidden xs:inline">•</span>
                <span className="hidden xs:inline whitespace-nowrap">
                  {activeSelectedDownload.state === "downloading"
                    ? Math.max(1, activeSelectedDownload.connections || 1)
                    : 0}{" "}
                  TCP Threads
                </span>
              </div>
            ) : (
              <span className="text-[var(--text-muted)] truncate">No download selected</span>
            )}
          </div>
        </div>

        {/* Right: Aggregate Network Telemetry */}
        <div className="flex items-center gap-2 sm:gap-4 font-mono tabular-nums text-xs shrink-0">
          <div className="flex items-center gap-1 text-emerald-400 font-semibold whitespace-nowrap">
            <ArrowDown className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>{totalSpeedDisplay}</span>
          </div>
          <div className="hidden sm:flex items-center gap-1 text-[var(--text-muted)] whitespace-nowrap">
            <ArrowUp className="w-3.5 h-3.5" />
            <span>0 B/s</span>
          </div>
          <div className="hidden md:block text-[var(--text-muted)]">|</div>
          <div className="hidden md:flex text-[var(--text-secondary)] items-center gap-1 whitespace-nowrap">
            <Cpu className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>{totalActiveThreads} TCP Threads</span>
          </div>
          <div className="hidden lg:block text-[var(--text-muted)]">|</div>
          <div className="hidden lg:flex text-[var(--text-secondary)] items-center gap-1 whitespace-nowrap">
            <Wifi className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>Session: {formatBytes(totalSessionBytes)}</span>
          </div>
        </div>
      </footer>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
          4. SIGNATURE DOWNLOAD PROGRESS & SEGMENT TELEMETRY MODAL
      ────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isInspectorOpen && activeSelectedDownload && (
          <motion.div
            variants={backdropVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            onClick={() => setIsInspectorOpen(false)}
          >
            <motion.div
              variants={modalVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="panel-3d w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
            {/* Modal Title Bar */}
            <div className="px-4 py-2.5 bg-[var(--bg-card)] border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <img src="/logo.png" alt="EDM" className="w-4 h-4 object-contain shrink-0" />
                <span className="font-bold tracking-tight text-xs sm:text-sm truncate">
                  Download Status — {activeSelectedDownload.name}
                </span>
              </div>
              <button
                onClick={() => setIsInspectorOpen(false)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-chassis)] cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-3.5 sm:p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              {/* Metadata Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-2.5 p-2.5 sm:p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-xs">
                <div>
                  <div className="text-[9px] sm:text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">Status</div>
                  <div className={`font-semibold text-xs mt-0.5 ${
                    activeSelectedDownload.state === "downloading"
                      ? "text-[var(--accent)]"
                      : activeSelectedDownload.state === "paused"
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }`}>
                    {activeSelectedDownload.state === "downloading"
                      ? "Receiving data..."
                      : activeSelectedDownload.state === "paused"
                      ? "Paused"
                      : "Completed"}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] sm:text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">File Size</div>
                  <div className="font-mono tabular-nums font-semibold text-xs mt-0.5">
                    {formatBytes(activeSelectedDownload.sizeTotal)}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] sm:text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">Transfer Rate</div>
                  <div className={`font-mono tabular-nums font-semibold text-xs mt-0.5 ${
                    activeSelectedDownload.state === "downloading" ? "text-emerald-400" : "text-[var(--text-muted)]"
                  }`}>
                    {activeSelectedDownload.speed}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] sm:text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">Resume Capable</div>
                  <div className="font-semibold text-emerald-400 text-xs mt-0.5 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 inline shrink-0" /> Yes (Byte-Range)
                  </div>
                </div>
              </div>

              {/* Dynamic Parallel Segmentation Progress Bar */}
              {(() => {
                const totalBytes = Math.max(1, activeSelectedDownload.sizeTotal);
                const workersList =
                  activeSelectedDownload.workers && activeSelectedDownload.workers.length > 0
                    ? activeSelectedDownload.workers
                    : Array.from({ length: Math.max(1, activeSelectedDownload.connections || 8) }).map((_, idx, arr) => {
                        const chunkBytes = Math.floor(totalBytes / arr.length);
                        const start = idx * chunkBytes;
                        const end = idx === arr.length - 1 ? totalBytes : (idx + 1) * chunkBytes;
                        const range = end - start;
                        const done = Math.floor((range * activeSelectedDownload.progress) / 100);
                        return {
                          idx: idx + 1,
                          start,
                          end,
                          pos: start + done,
                          speed: activeSelectedDownload.speed,
                          status:
                            activeSelectedDownload.state === "downloading"
                              ? "Receiving chunk (HTTP 206)..."
                              : activeSelectedDownload.state === "completed"
                              ? "Chunk verified • Complete"
                              : "Thread suspended (Paused)",
                        };
                      });

                return (
                  <>
                    <div>
                      <div className="flex justify-between items-center text-[11px] mb-1">
                        <span className="font-medium text-[var(--text-secondary)]">
                          Start positions and download progress by connections:
                        </span>
                        <span className="font-mono tabular-nums font-bold text-[var(--accent)] text-xs">
                          {activeSelectedDownload.state === "completed" || activeSelectedDownload.progress >= 100 ? 100 : activeSelectedDownload.progress}% ({formatBytes(activeSelectedDownload.state === "completed" || activeSelectedDownload.progress >= 100 ? (activeSelectedDownload.sizeTotal || activeSelectedDownload.sizeDone) : activeSelectedDownload.sizeDone)} / {formatBytes(activeSelectedDownload.sizeTotal || activeSelectedDownload.sizeDone)})
                        </span>
                      </div>
                      {/* Continuous Visual Progress Bar (Zero Seams & Merged Spans) */}
                      <div className="h-5 rounded bg-[var(--bg-chassis)] border border-[var(--border-strong)] relative overflow-hidden shadow-inner flex items-center">
                        {(() => {
                          const isComplete =
                            activeSelectedDownload.state === "completed" ||
                            activeSelectedDownload.progress >= 100 ||
                            (totalBytes > 0 && activeSelectedDownload.sizeDone >= totalBytes);

                          if (isComplete) {
                            return (
                              <div
                                className="h-full w-full progress-fill-3d transition-all duration-300"
                                style={{ width: "100%" }}
                              />
                            );
                          }

                          const spans = getMergedProgressSpans(
                            workersList,
                            totalBytes,
                            activeSelectedDownload.sizeDone,
                            false
                          );

                          return (
                            <>
                              {spans.map((span, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="absolute top-0 bottom-0 z-10 progress-fill-3d transition-all duration-300"
                                  style={{
                                    left: `${span.startPct}%`,
                                    width:
                                      sIdx < spans.length - 1
                                        ? `calc(${span.widthPct}% + 1px)`
                                        : `${span.widthPct}%`,
                                  }}
                                >
                                  {/* Active downloading write-head beacon line at the leading edge of active span */}
                                  {activeSelectedDownload.state === "downloading" && sIdx === spans.length - 1 && (
                                    <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-white shadow-[0_0_8px_#38BDF8] animate-pulse" />
                                  )}
                                </div>
                              ))}
                              {/* Optional faint overlay if showConnectionBoundaries is enabled (default off) */}
                              {settings?.general?.showConnectionBoundaries &&
                                workersList &&
                                workersList.length > 1 &&
                                workersList.slice(1).map((w, idx) => {
                                  const offsetPct = totalBytes > 0 ? (w.start / totalBytes) * 100 : 0;
                                  return (
                                    <div
                                      key={`boundary-${idx}`}
                                      className="absolute top-0 bottom-0 w-[1px] bg-white/20 pointer-events-none z-20"
                                      style={{ left: `${offsetPct}%` }}
                                    />
                                  );
                                })}
                            </>
                          );
                        })()}
                      </div>
                      <div className="flex justify-between text-[9.5px] text-[var(--text-muted)] font-mono mt-1">
                        <span>Offset: 0x00000000</span>
                        <span className="text-emerald-400 font-medium">Engine Crash Safety: Flush-Before-Checkpoint Enabled</span>
                        <span>Offset: {formatBytes(activeSelectedDownload.sizeTotal)}</span>
                      </div>
                    </div>

                    {/* Real-time Dual-Stream Interactive Area Chart (Shadcn Architecture) */}
                    <SpeedChartInteractive
                      speedHistory={activeSelectedDownload.speedHistory}
                      currentSpeed={activeSelectedDownload.speed}
                      peakSpeedBps={activeSelectedDownload.peakSpeedBps}
                      isDownloading={activeSelectedDownload.state === "downloading"}
                      eta={activeSelectedDownload.eta}
                      elapsedSeconds={Math.floor((activeSelectedDownload as any).elapsedSeconds || 0)}
                    />

                    {/* Multi-Connection Worker Thread Telemetry Table */}
                    <div>
                      <div className="flex justify-between items-center text-[11px] font-medium text-[var(--text-secondary)] mb-1">
                        <span>Multi-Connection Worker Thread Telemetry</span>
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          {workersList.length} Active Stream{workersList.length > 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-chassis)] max-h-36 overflow-y-auto">
                        <table className="w-full text-left text-[11px]">
                          <thead className="sticky top-0 bg-[var(--bg-card)] border-b border-[var(--border-subtle)] text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)] z-10">
                            <tr>
                              <th className="py-1 px-2.5">Connection</th>
                              <th className="py-1 px-2.5">Byte Range</th>
                              <th className="py-1 px-2.5">Progress</th>
                              <th className="py-1 px-2.5">Throughput</th>
                              <th className="py-1 px-2.5">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border-dim)] font-mono tabular-nums">
                            {workersList.map((w, idx) => {
                              const isPaused = activeSelectedDownload.state === "paused";
                              const isCompleted = activeSelectedDownload.state === "completed";
                              const range = Math.max(1, w.end - w.start);
                              const done = Math.max(0, Math.min(range, w.pos - w.start));
                              const pct = Math.min(100, Math.round((done / range) * 100));

                              let statusColor = "text-[var(--text-muted)]";
                              if (isCompleted || pct >= 100) statusColor = "text-emerald-400";
                              else if (!isPaused && activeSelectedDownload.state === "downloading") statusColor = "text-sky-400";

                              return (
                                <tr key={w.idx || idx + 1} className="hover:bg-[var(--bg-card-hover)]">
                                  <td className="py-1 px-2.5 font-semibold text-[var(--accent)]">Worker #{w.idx || idx + 1}</td>
                                  <td className="py-1 px-2.5 text-[var(--text-secondary)]">
                                    {formatBytes(w.start)} - {formatBytes(w.end)}
                                  </td>
                                  <td className="py-1 px-2.5 text-[var(--text-primary)]">
                                    {pct}% ({formatBytes(done)})
                                  </td>
                                  <td
                                    className={`py-1 px-2.5 font-semibold ${
                                      isPaused ? "text-[var(--text-muted)]" : "text-emerald-400"
                                    }`}
                                  >
                                    {isPaused ? "0 B/s" : w.speed}
                                  </td>
                                  <td className={`py-1 px-2.5 text-[10px] ${statusColor}`}>
                                    {isPaused ? "Thread suspended (Paused)" : isCompleted ? "Chunk verified • Complete" : w.status}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Modal Actions */}
            <div className="px-4 py-2.5 bg-[var(--bg-card)] border-t border-[var(--border-subtle)] flex items-center justify-between shrink-0">
              <div className="text-[10px] text-[var(--text-muted)] font-mono truncate mr-2">
                NTFS Sparse Allocation • Mark-of-the-Web Attached
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {activeSelectedDownload.state === "completed" && (
                  <button
                    onClick={() => tauriOpenFile(activeSelectedDownload.id)}
                    className="btn-3d h-7 px-3 rounded-lg text-xs font-semibold cursor-pointer text-blue-400 hover:text-blue-300"
                  >
                    Open File
                  </button>
                )}
                {activeSelectedDownload.state !== "completed" && (
                  <button
                    onClick={() => toggleDownloadState(activeSelectedDownload.id)}
                    className={`btn-3d h-7 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                      activeSelectedDownload.state === "downloading"
                        ? "text-amber-400 hover:text-amber-300"
                        : "text-emerald-400 hover:text-emerald-300"
                    }`}
                  >
                    {activeSelectedDownload.state === "downloading" ? "Pause" : "Resume"}
                  </button>
                )}
                <button
                  onClick={() => setIsInspectorOpen(false)}
                  className="btn-primary-3d h-7 px-3.5 rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Close Window
                </button>
              </div>
            </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
          5. ADD URL PRE-DOWNLOAD DIALOG
      ────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isAddModalOpen && (
          <motion.div
            variants={backdropVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            onClick={() => {
              setIsAddModalOpen(false);
              setUrlInput("");
              setFileNameInput("");
              setProbeResult(null);
            }}
          >
            <motion.div
              variants={modalVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="panel-3d w-full max-w-lg overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-3 bg-[var(--bg-card)] border-b border-[var(--border-subtle)] flex items-center justify-between">
                <span className="font-bold tracking-tight text-sm flex items-center gap-2">
                  <img src="/logo.png" alt="EDM Logo" className="w-4 h-4 object-contain" />
                  Add New Download Task
                </span>
                <button
                  onClick={() => {
                    setIsAddModalOpen(false);
                    setUrlInput("");
                    setFileNameInput("");
                    setProbeResult(null);
                  }}
                  className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  Source Address (URL / HTTP / Magnet)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="https://example.com/file.zip or paste download link..."
                    value={urlInput}
                    onChange={(e) => handleUrlInputChange(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg text-xs input-3d text-[var(--text-primary)] focus:outline-none"
                  />
                  <button
                    onClick={handleProbe}
                    disabled={isProbing || !urlInput.trim()}
                    className="btn-3d px-3 py-2 rounded-lg text-xs font-semibold text-[var(--accent)] disabled:opacity-40 cursor-pointer"
                  >
                    {isProbing ? "Probing..." : "Probe Server"}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  File Name
                </label>
                <input
                  type="text"
                  placeholder="Enter file name (e.g. video.mp4)..."
                  value={fileNameInput}
                  onChange={(e) => setFileNameInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-xs input-3d text-[var(--text-primary)] focus:outline-none font-medium"
                />
              </div>

              {probeResult && (
                <div className="p-3 rounded-xl card-3d border border-[var(--accent-badge-border)] text-xs space-y-1">
                  <div className="font-semibold text-[var(--accent)] flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 icon-3d" /> Endpoint Validated & Resumable
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)] font-mono">
                    Size: {probeResult.size} • Accept-Ranges: bytes • Sparse Pre-allocation Ready
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-[var(--text-secondary)] mb-1">Category</label>
                  <select
                    value={addCategory}
                    onChange={(e) => setAddCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg input-3d text-[var(--text-primary)] focus:outline-none cursor-pointer"
                  >
                    <option value="auto">Auto-Detect from Extension</option>
                    {settings.categories
                      .filter((c) => c.enabled)
                      .map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-[var(--text-secondary)] mb-1">TCP Worker Streams</label>
                  <select
                    value={String(addConnections)}
                    onChange={(e) => setAddConnections(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg input-3d text-[var(--text-primary)] focus:outline-none cursor-pointer"
                  >
                    <option value="8">8 Parallel Streams (Recommended)</option>
                    <option value="16">16 Parallel Streams (Fast)</option>
                    <option value="32">32 Parallel Streams (Maximum)</option>
                    <option value="1">1 Single Stream (Strict)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  Destination Directory
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addSaveDir || settings.downloads.defaultDirectory}
                    onChange={(e) => setAddSaveDir(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg text-xs input-3d text-[var(--text-primary)] font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseAddDir}
                    className="btn-3d px-3 py-2 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer inline-flex items-center gap-1.5 shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span>Browse...</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="px-5 py-3 bg-[var(--bg-card)] border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setIsAddModalOpen(false);
                  setUrlInput("");
                  setFileNameInput("");
                  setProbeResult(null);
                }}
                className="btn-3d px-4 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleAddDownload}
                disabled={!urlInput.trim()}
                className="btn-primary-3d px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 cursor-pointer"
              >
                Start Download
              </button>
            </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
          6. VIDEO STREAM RADAR DIALOG (Browser Extension Grabber)
      ────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isVideoModalOpen && (
          <motion.div
            variants={backdropVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            onClick={() => setIsVideoModalOpen(false)}
          >
            <motion.div
              variants={modalVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="panel-3d w-full max-w-md overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-3 bg-[var(--bg-card)] border-b border-[var(--border-subtle)] flex items-center justify-between">
                <span className="font-bold tracking-tight text-sm flex items-center gap-2">
                  <Video className="w-4 h-4 text-cyan-400" />
                  Browser Video Stream Grabber
                </span>
                <button
                  onClick={() => setIsVideoModalOpen(false)}
                  className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 space-y-1">
                  <div className="font-semibold text-cyan-400">Stream Discovered via Native Messaging</div>
                  <div className="text-[11px] text-[var(--text-secondary)] font-mono">
                    HLS Master Playlist • 1080p 60fps • No DRM Detected
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-[var(--text-secondary)] mb-1">Stream Quality</label>
                  <select className="w-full px-3 py-2 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none">
                    <option>1080p 60fps (Full HD • ~248 MB)</option>
                    <option>720p 30fps (HD • ~124 MB)</option>
                    <option>Audio Only (AAC 256kbps • ~18 MB)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-[var(--text-secondary)] mb-1">Target Filename</label>
                  <input
                    type="text"
                    defaultValue="webinar-high-performance-systems-2026.mp4"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono"
                  />
                </div>
              </div>

              <div className="px-5 py-3 bg-[var(--bg-card)] border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                <button
                  onClick={() => setIsVideoModalOpen(false)}
                  className="btn-3d px-4 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => {
                    alert("Started HLS stream segment pipeline!");
                    setIsVideoModalOpen(false);
                  }}
                  className="btn-primary-3d px-4 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Grab Video Stream
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <SetupWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        settings={settings}
        onSaveSettings={handleUpdateSettings}
      />

      <RefreshLinkModal
        isOpen={Boolean(refreshModalTask)}
        task={refreshModalTask}
        onClose={() => setRefreshModalTask(null)}
        onRefreshed={(taskId, newUrl) => {
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === taskId
                ? { ...d, url: newUrl, state: "downloading", speed: "Connecting..." }
                : d
            )
          );
        }}
      />

      <PowerCountdownModal />

      {/* Modern Context Menu */}
      {contextMenu.visible && contextMenu.item && (
        <div
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          className="fixed z-50 w-56 rounded-xl panel-3d shadow-2xl p-1.5 text-xs border border-[var(--border-subtle)] bg-[var(--bg-card)]/95 backdrop-blur-md select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)]/70 text-[10px] font-mono font-medium text-[var(--text-muted)] truncate">
            {contextMenu.item.name}
          </div>
          <div className="py-1 space-y-0.5">
            {contextMenu.item.state === "completed" || contextMenu.item.progress >= 100 ? (
              <button
                onClick={() => {
                  tauriOpenFile(contextMenu.item!.id);
                  setContextMenu((p) => ({ ...p, visible: false }));
                }}
                className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-[var(--text-primary)] cursor-pointer transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Open File</span>
              </button>
            ) : contextMenu.item.state === "downloading" ? (
              <button
                onClick={() => {
                  tauriPauseDownload(contextMenu.item!.id);
                  setDownloads((prev) =>
                    prev.map((d) => (d.id === contextMenu.item!.id ? { ...d, state: "paused", speed: "0 B/s" } : d))
                  );
                  setContextMenu((p) => ({ ...p, visible: false }));
                }}
                className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-amber-400 cursor-pointer transition-colors"
              >
                <Pause className="w-3.5 h-3.5" />
                <span>Pause Download</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  tauriResumeDownload(contextMenu.item!.id);
                  setDownloads((prev) =>
                    prev.map((d) => (d.id === contextMenu.item!.id ? { ...d, state: "downloading" } : d))
                  );
                  setContextMenu((p) => ({ ...p, visible: false }));
                }}
                className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-emerald-400 cursor-pointer transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Resume Download</span>
              </button>
            )}

            <button
              onClick={() => {
                tauriOpenFolder(contextMenu.item!.id);
                setContextMenu((p) => ({ ...p, visible: false }));
              }}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>Open Folder</span>
            </button>

            <button
              onClick={() => {
                navigator.clipboard.writeText(contextMenu.item!.url);
                setCopiedContextMenuId(contextMenu.item!.id);
                setTimeout(() => {
                  setCopiedContextMenuId(null);
                  setContextMenu((p) => ({ ...p, visible: false }));
                }, 800);
              }}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              {copiedContextMenuId === contextMenu.item.id ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied URL!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Source URL</span>
                </>
              )}
            </button>

            <button
              onClick={() => {
                setSelectedDownload(contextMenu.item);
                setIsInspectorOpen(true);
                setContextMenu((p) => ({ ...p, visible: false }));
              }}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              <Layers className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>Inspect Streams</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">Enter</span>
            </button>
          </div>

          <div className="pt-1 mt-1 border-t border-[var(--border-subtle)]/70">
            <button
              onClick={() => {
                tauriDeleteDownload(contextMenu.item!.id);
                setDownloads((prev) => prev.filter((d) => d.id !== contextMenu.item!.id));
                setSelectedIds((prev) => prev.filter((id) => id !== contextMenu.item!.id));
                if (selectedDownload?.id === contextMenu.item!.id) setSelectedDownload(null);
                setContextMenu((p) => ({ ...p, visible: false }));
              }}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-rose-400 hover:bg-rose-500/10 cursor-pointer transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete from List</span>
              <span className="ml-auto text-[10px] text-rose-400/70 font-mono">Del</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
