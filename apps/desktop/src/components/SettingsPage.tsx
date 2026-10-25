import { useState, useRef, useCallback } from "react";
import {
  ArrowLeft,
  Moon,
  Sun,
  Laptop,
  Sliders,
  Download,
  Upload,
  Folder,
  FolderOpen,
  Globe,
  Clock,
  ShieldCheck,
  Cpu,
  Info,
  RotateCcw,
  Search,
  Plus,
  Gauge,
  ChevronDown,
  ExternalLink,
  ArrowDown,
  ArrowUp,
  HardDrive,
  Trash2,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";
import { EdmSettings, defaultSettings, saveSettings } from "../types/settings";
import type { DownloadItem } from "../App";

interface SettingsPageProps {
  settings: EdmSettings;
  onUpdateSettings: (newSettings: EdmSettings) => void;
  onBack: () => void;
  speedLimit?: string;
  onSpeedLimitChange?: (val: string) => void;
  selectedDownload?: DownloadItem | null;
  onInspectDownload?: () => void;
  totalSpeed?: string;
  activeThreads?: number;
}

type SettingsSection =
  | "general"
  | "downloads"
  | "network"
  | "automation"
  | "engine"
  | "about";

const paletteOptions = [
  { id: "blue", label: "Sapphire Blue", color: "#2563EB" },
  { id: "emerald", label: "Nordic Emerald", color: "#10B981" },
  { id: "amber", label: "Cyberpunk Amber", color: "#F59E0B" },
  { id: "violet", label: "Velvet Violet", color: "#8B5CF6" },
  { id: "rose", label: "Crimson Flame", color: "#F43F5E" },
  { id: "titanium", label: "Titanium Slate", color: "#64748B" },
] as const;

const languageOptions = [
  { code: "en-US", label: "English (United States)", flag: "🇺🇸" },
  { code: "es-ES", label: "Español (Spanish)", flag: "🇪🇸" },
  { code: "de-DE", label: "Deutsch (German)", flag: "🇩🇪" },
  { code: "fr-FR", label: "Français (French)", flag: "🇫🇷" },
  { code: "ja-JP", label: "日本語 (Japanese)", flag: "🇯🇵" },
  { code: "zh-CN", label: "简体中文 (Chinese)", flag: "🇨🇳" },
  { code: "pt-BR", label: "Português (Brazil)", flag: "🇧🇷" },
  { code: "ru-RU", label: "Русский (Russian)", flag: "🇷🇺" },
  { code: "hi-IN", label: "हिन्दी (Hindi)", flag: "🇮🇳" },
];

export default function SettingsPage({
  settings,
  onUpdateSettings,
  onBack,
  speedLimit = "Unlimited",
  onSpeedLimitChange,
  selectedDownload,
  onInspectDownload,
  totalSpeed = "0 B/s",
  activeThreads = 0,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [customCatName, setCustomCatName] = useState("");
  const [customCatExt, setCustomCatExt] = useState("");
  const [isLimiterOpen, setIsLimiterOpen] = useState(false);
  const [showTranslatorNotice, setShowTranslatorNotice] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "up-to-date">("idle");
  const [lastCheckedTime, setLastCheckedTime] = useState<string>("Today, 7:42 PM");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScrollRef = useRef(false);

  const navItems = [
    {
      id: "general" as const,
      label: "General & Interface",
      icon: Sliders,
      desc: "Theme, accents, UI density, language, startup lifecycle",
    },
    {
      id: "downloads" as const,
      label: "Downloads & Storage",
      icon: Download,
      desc: "Smart folder routing, multi-stream concurrency, conflict policy",
    },
    {
      id: "network" as const,
      label: "Network & Browser",
      icon: Globe,
      desc: "Browser extension bridge, stream sniffer, proxy protocols",
    },
    {
      id: "automation" as const,
      label: "Automation & Queues",
      icon: Clock,
      desc: "Off-peak scheduler, power actions, desktop notifications",
    },
    {
      id: "engine" as const,
      label: "Security & Engine",
      icon: ShieldCheck,
      desc: "Checksums, MOTW attachment, sparse I/O, keyboard shortcuts",
    },
    {
      id: "about" as const,
      label: "About & Maintenance",
      icon: Info,
      desc: "Version telemetry, backup/restore JSON, factory reset",
    },
  ];

  const isSectionVisible = (id: SettingsSection) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const navItem = navItems.find((item) => item.id === id);
    if (!navItem) return true;
    return (
      navItem.label.toLowerCase().includes(q) ||
      navItem.desc.toLowerCase().includes(q) ||
      navItem.id.toLowerCase().includes(q)
    );
  };

  const scrollToSection = (sectionId: SettingsSection) => {
    setActiveSection(sectionId);
    const target = document.getElementById(`section-${sectionId}`);
    if (target) {
      isProgrammaticScrollRef.current = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 700);
    }
  };

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    if (container.scrollHeight - container.scrollTop <= container.clientHeight + 40) {
      setActiveSection(navItems[navItems.length - 1].id);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    let current: SettingsSection = navItems[0].id;
    for (const item of navItems) {
      const el = document.getElementById(`section-${item.id}`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top - containerTop <= 160) {
        current = item.id;
      }
    }
    setActiveSection(current);
  }, [navItems]);

  const update = <K extends keyof EdmSettings>(section: K, patch: Partial<EdmSettings[K]>) => {
    const updated = {
      ...settings,
      [section]: {
        ...(settings[section] as any),
        ...patch,
      },
    };
    onUpdateSettings(updated);
    saveSettings(updated);
  };

  const resetCurrentSection = () => {
    if (confirm(`Reset ${activeSection.toUpperCase()} settings to factory defaults?`)) {
      let updated = { ...settings };
      if (activeSection === "general") {
        updated.general = defaultSettings.general;
      } else if (activeSection === "downloads") {
        updated.downloads = defaultSettings.downloads;
        updated.storage = defaultSettings.storage;
        updated.categories = defaultSettings.categories;
      } else if (activeSection === "network") {
        updated.network = defaultSettings.network;
        updated.browser = defaultSettings.browser;
      } else if (activeSection === "automation") {
        updated.queues = defaultSettings.queues;
        updated.notifications = defaultSettings.notifications;
      } else if (activeSection === "engine") {
        updated.security = defaultSettings.security;
        updated.advanced = defaultSettings.advanced;
      } else if (activeSection === "about") {
        updated = defaultSettings;
      }
      onUpdateSettings(updated);
      saveSettings(updated);
    }
  };

  const handleExport = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(settings, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `edm-settings-v${settings.schemaVersion}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (parsed.schemaVersion) {
          onUpdateSettings(parsed);
          saveSettings(parsed);
          alert("Settings imported successfully!");
        } else {
          alert("Invalid EDM settings file format.");
        }
      } catch (err) {
        alert("Failed to parse settings JSON file.");
      }
    };
    reader.readAsText(file);
  };

  const handleCheckUpdate = () => {
    setUpdateStatus("checking");
    setTimeout(() => {
      setUpdateStatus("up-to-date");
      const now = new Date();
      setLastCheckedTime(`Today, ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    }, 1200);
  };

  const handleAddCategory = () => {
    if (!customCatName.trim() || !customCatExt.trim()) return;
    const exts = customCatExt
      .split(",")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    if (!exts.length) return;

    const newCat = {
      id: customCatName.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      name: customCatName.trim(),
      enabled: true,
      extensions: exts,
      destinationDirectory: `${settings.downloads.defaultDirectory}\\${customCatName.trim()}`,
      priority: "normal" as const,
    };

    const updated = {
      ...settings,
      categories: [...settings.categories, newCat],
    };
    onUpdateSettings(updated);
    saveSettings(updated);
    setCustomCatName("");
    setCustomCatExt("");
  };

  const handleDeleteCategory = (catId: string) => {
    const updated = {
      ...settings,
      categories: settings.categories.filter((c) => c.id !== catId),
    };
    onUpdateSettings(updated);
    saveSettings(updated);
  };

  const filteredNavItems = navItems.filter(
    (item) =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full w-full min-h-0 overflow-hidden text-sm bg-[var(--bg-chassis)] text-[var(--text-primary)]">
      {/* ─────────────────────────────────────────────────────────────
          1. HEADER WITH BACK NAVIGATION & SEARCH
      ────────────────────────────────────────────────────────────── */}
      <header className="h-14 px-3 sm:px-6 bg-[var(--bg-header)] border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 z-20 gap-2 overflow-x-auto select-none">
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={onBack}
            className="btn-3d h-9 px-2.5 sm:px-3 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 sm:gap-2 cursor-pointer transition-all whitespace-nowrap"
            title="Return to Downloads View (Esc)"
          >
            <ArrowLeft className="w-4 h-4 text-[var(--accent)]" />
            <span className="hidden xs:inline">Back to Downloads</span>
            <span className="xs:hidden">Back</span>
          </button>

          <div className="h-5 w-[1px] bg-[var(--border-subtle)] mx-0.5 sm:mx-1" />

          <div className="flex items-center gap-2 shrink-0">
            <span className="font-bold text-xs sm:text-sm text-[var(--text-primary)] whitespace-nowrap">
              EDM Preferences
            </span>
            <span className="px-1.5 sm:px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--accent-badge-bg)] text-[var(--accent-badge-text)] border border-[var(--accent-badge-border)] hidden sm:inline">
              v0.0.1 PRO
            </span>
          </div>
        </div>

        {/* Search & Global Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              placeholder="Search settings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-28 sm:w-44 md:w-56 focus:w-36 sm:focus:w-60 h-8 pl-8 pr-2.5 rounded-lg text-xs bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-all truncate"
            />
          </div>

          <button
            onClick={resetCurrentSection}
            className="btn-3d h-8 px-2 sm:px-2.5 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-amber-400 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            title="Reset current section to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Reset Section</span>
          </button>

          <button
            onClick={handleExport}
            className="btn-3d h-8 px-2 sm:px-2.5 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            title="Export full settings to JSON"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>
        </div>
      </header>

      {/* ─────────────────────────────────────────────────────────────
          2. SPLIT LAYOUT: CONSOLIDATED SIDEBAR + MAIN CONFIG CANVAS
      ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-56 md:w-64 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col shrink-0 overflow-y-auto p-2.5 sm:p-3 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-2.5 py-1.5">
            Settings Navigation
          </div>
          {filteredNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => scrollToSection(item.id)}
                className={`w-full flex items-start gap-2.5 p-2 rounded-xl text-left transition-all cursor-pointer ${
                  isActive
                    ? "sidebar-item-active-3d text-[var(--text-primary)] font-semibold"
                    : "sidebar-item-inactive-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <div
                  className={`p-1.5 rounded-lg mt-0.5 shrink-0 ${
                    isActive
                      ? "bg-[var(--accent)] text-[var(--accent-on)] shadow-sm"
                      : "bg-[var(--bg-card)] text-[var(--text-muted)] border border-[var(--border-subtle)]"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className={`font-semibold text-xs leading-tight ${isActive ? "text-[var(--text-primary)]" : ""}`}>
                    {item.label}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5 hidden sm:block">
                    {item.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </aside>

        {/* Main Configuration Viewport */}
        <main
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 bg-[var(--bg-chassis)] overflow-y-auto px-4 py-6 sm:px-8 md:px-12 scroll-smooth custom-scrollbar"
        >
          <div className="max-w-4xl xl:max-w-5xl w-full mx-auto space-y-10">
          {/* ═════════════════════════════════════════════════════════
              SECTION 1: GENERAL & INTERFACE
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("general") && (
            <section id="section-general" className="space-y-6 pt-1 pb-8 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <Sliders className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">General & Interface</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Configure visual appearance, theme modes, language localization, and system startup lifecycle.
                </p>
              </div>

              {/* Theme & Palette Card */}
              <div className="card-3d p-4 rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">Theme Mode</label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      A high-contrast dark theme will be used if the system theme is unknown.
                    </span>
                  </div>
                </div>

                {/* Mode Segmented Pills */}
                <div className="grid grid-cols-3 gap-2 max-w-md">
                  {[
                    { id: "dark" as const, label: "Dark", icon: Moon },
                    { id: "light" as const, label: "Light", icon: Sun },
                    { id: "system" as const, label: "System", icon: Laptop },
                  ].map((m) => {
                    const Icon = m.icon;
                    const isSel = settings.general.theme === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => update("general", { theme: m.id })}
                        className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer transition-all ${
                          isSel
                            ? "bg-[var(--accent)] text-[var(--accent-on)] border-[var(--accent)] shadow-sm"
                            : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{m.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Accent Color Palettes */}
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <label className="text-xs font-semibold text-[var(--text-primary)] block mb-2">
                    Accent Color Palette
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {paletteOptions.map((p) => {
                      const isSel = settings.general.palette === p.id;
                      return (
                        <button
                          key={p.id}
                          onClick={() => update("general", { palette: p.id as any })}
                          className={`p-2 rounded-lg border text-left cursor-pointer transition-all flex items-center gap-2 ${
                            isSel
                              ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)]"
                              : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                          }`}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full shrink-0 shadow-sm"
                            style={{ backgroundColor: p.color }}
                          />
                          <span className="text-[11px] font-medium truncate">{p.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* UI Style / Density */}
                <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">UI Style & Density</label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Control spacing density and information visual hierarchy.
                    </span>
                  </div>
                  <div className="flex rounded-lg p-0.5 bg-[var(--bg-chassis)] border border-[var(--border-subtle)]">
                    {[
                      { id: "pro" as const, label: "Pro High-Density" },
                      { id: "compact" as const, label: "Compact" },
                      { id: "modern" as const, label: "Comfortable" },
                    ].map((s) => (
                      <button
                        key={s.id}
                        onClick={() => update("general", { uiStyle: s.id })}
                        className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all cursor-pointer ${
                          settings.general.uiStyle === s.id
                            ? "bg-[var(--accent)] text-[var(--accent-on)] font-semibold shadow-sm"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Language & Localization Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">Display Language</label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Select your preferred language interface.
                    </span>
                  </div>
                  <div className="w-full sm:w-64">
                    <select
                      value={settings.general.language}
                      onChange={(e) => update("general", { language: e.target.value })}
                      className="w-full h-8 px-2.5 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
                    >
                      {languageOptions.map((lang) => (
                        <option key={lang.code} value={lang.code} className="bg-[var(--bg-card)]">
                          {lang.flag} {lang.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-xs">
                  <span className="text-[var(--text-secondary)] text-[11px]">
                    Your language is not listed or the translation isn't complete?
                  </span>
                  <button
                    onClick={() => setShowTranslatorNotice(true)}
                    className="text-[var(--accent)] hover:underline font-semibold text-[11px] cursor-pointer whitespace-nowrap ml-2"
                  >
                    Let's fix it!
                  </button>
                </div>
              </div>

              {/* Startup & Lifecycle Options Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  Application Lifecycle Options
                </label>

                <div className="space-y-2.5">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.general.launchAtStartup}
                      onChange={(e) => update("general", { launchAtStartup: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Launch EDM automatically at Windows startup
                      </span>
                    </div>
                  </label>

                  {/* Dependent Sub-option */}
                  <label className="flex items-center gap-3 cursor-pointer group pl-6">
                    <input
                      type="checkbox"
                      checked={settings.general.startMinimized}
                      disabled={!settings.general.launchAtStartup}
                      onChange={(e) => update("general", { startMinimized: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90 disabled:opacity-40"
                    />
                    <div className="text-xs">
                      <span
                        className={`font-medium ${
                          settings.general.launchAtStartup
                            ? "text-[var(--text-primary)] group-hover:text-[var(--accent)]"
                            : "text-[var(--text-muted)]"
                        } transition-colors`}
                      >
                        Start minimized in system notification tray
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.general.minimizeToTray}
                      onChange={(e) => update("general", { minimizeToTray: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Minimize to system tray on window close (keeps downloads running in background)
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.general.restoreDownloadsOnLaunch}
                      onChange={(e) => update("general", { restoreDownloadsOnLaunch: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Automatically restore unfinished downloads on application launch
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.general.confirmBeforeExit}
                      onChange={(e) => update("general", { confirmBeforeExit: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Confirm before exiting while active downloads are in progress
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            </section>
          )}

          {/* ═════════════════════════════════════════════════════════
              SECTION 2: DOWNLOADS & STORAGE (Smart Storage & Routing)
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("downloads") && (
            <section id="section-downloads" className="space-y-6 pt-1 pb-8 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <Download className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">Downloads & Storage</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Manage intelligent folder routing, multi-stream concurrency limits, conflict handling, and category maps.
                </p>
              </div>

              {/* Default Download Folder (Signature Dual Card Selector) */}
              <div className="card-3d p-4 rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[var(--text-primary)] block">
                    Default Download Folder Strategy
                  </label>
                  <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-[var(--accent-badge-bg)] text-[var(--accent-badge-text)] font-semibold border border-[var(--accent-badge-border)]">
                    Smart Engine
                  </span>
                </div>

                {/* Option 1: Automatic Folder Routing Card */}
                <div
                  onClick={() => update("storage", { folderMode: "auto" })}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    settings.storage.folderMode === "auto"
                      ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)] shadow-md"
                      : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-4 h-4 rounded-full border mt-0.5 flex items-center justify-center shrink-0 ${
                        settings.storage.folderMode === "auto"
                          ? "border-[var(--accent)] bg-[var(--accent)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-card)]"
                      }`}
                    >
                      {settings.storage.folderMode === "auto" && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-[var(--text-primary)]">
                          Choose default download folder automatically
                        </span>
                        <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          Recommended
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                        EDM inspects MIME headers and source domain to intelligently organize files into dedicated categories.
                      </p>

                      {/* Sub-Checkboxes for Auto Routing */}
                      <div className="mt-3 space-y-2 pt-2 border-t border-[var(--border-subtle)]/60">
                        <label
                          className="flex items-center gap-2.5 cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={settings.storage.suggestFoldersByType}
                            onChange={(e) => update("storage", { suggestFoldersByType: e.target.checked })}
                            className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                          />
                          <span className="text-xs text-[var(--text-secondary)] font-medium">
                            Suggest subfolders based on file category (Programs, Video, Audio, Archives, Documents)
                          </span>
                        </label>

                        <label
                          className="flex items-center gap-2.5 cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={settings.storage.suggestFoldersByDomain}
                            onChange={(e) => update("storage", { suggestFoldersByDomain: e.target.checked })}
                            className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                          />
                          <span className="text-xs text-[var(--text-secondary)] font-medium">
                            Suggest subfolders based on download URL hostname (e.g. \Downloads\github.com\)
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Option 2: Fixed Folder Card */}
                <div
                  onClick={() => update("storage", { folderMode: "fixed" })}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    settings.storage.folderMode === "fixed"
                      ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)] shadow-md"
                      : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-4 h-4 rounded-full border mt-0.5 flex items-center justify-center shrink-0 ${
                        settings.storage.folderMode === "fixed"
                          ? "border-[var(--accent)] bg-[var(--accent)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-card)]"
                      }`}
                    >
                      {settings.storage.folderMode === "fixed" && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-xs text-[var(--text-primary)]">
                        Fixed default download folder
                      </span>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                        All files will be saved directly into a single designated directory.
                      </p>

                      {/* Folder Directory Input with Browse Button */}
                      <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex-1 relative">
                          <Folder className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                          <input
                            type="text"
                            value={settings.downloads.defaultDirectory}
                            onChange={(e) => update("downloads", { defaultDirectory: e.target.value })}
                            className="w-full h-8 pl-8 pr-3 rounded-lg text-xs font-mono bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                          />
                        </div>
                        <button
                          onClick={() => {
                            alert("Native folder picker opened: Folder location confirmed.");
                          }}
                          className="btn-3d h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
                          <span>Browse...</span>
                        </button>
                      </div>

                      {/* Storage Quota Bar */}
                      <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--text-muted)] font-mono">
                        <div className="flex items-center gap-1.5">
                          <HardDrive className="w-3 h-3 text-emerald-400" />
                          <span>NTFS Volume (C:) • 412.8 GB Available of 1.0 TB</span>
                        </div>
                        <span className="text-emerald-400 font-semibold">59% Free</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sub-option: Ask Every Time */}
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.storage.askForSaveLocation}
                      onChange={(e) => update("storage", { askForSaveLocation: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Always display pre-download dialog to confirm folder location and filename
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Filename Conflict Policy Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  File Collision & Conflict Policy
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: "ask" as const, label: "Ask Every Time", desc: "Show resolution dialog" },
                    { id: "rename" as const, label: "Auto-Rename (1)", desc: "Append numerical counter" },
                    { id: "overwrite" as const, label: "Overwrite File", desc: "Replace target completely" },
                    { id: "skip" as const, label: "Skip Download", desc: "Ignore duplicate tasks" },
                  ].map((p) => {
                    const isSel = settings.storage.filenameConflictPolicy === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => update("storage", { filenameConflictPolicy: p.id })}
                        className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                          isSel
                            ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)] font-semibold"
                            : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                        }`}
                      >
                        <div className="text-xs text-[var(--text-primary)]">{p.label}</div>
                        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{p.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Multi-Stream Concurrency & Segment Acceleration Card */}
              <div className="card-3d p-4 rounded-xl space-y-4">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  Multi-Stream Acceleration & Concurrency Limits
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Active Concurrency */}
                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-medium text-[var(--text-secondary)]">Max Simultaneous Tasks</span>
                      <span className="font-mono font-bold text-[var(--accent)] text-sm">
                        {settings.downloads.maxActiveDownloads} Downloads
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={settings.downloads.maxActiveDownloads}
                      onChange={(e) => update("downloads", { maxActiveDownloads: Number(e.target.value) })}
                      className="w-full accent-[var(--accent)] cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] font-mono">
                      <span>1 (Sequential)</span>
                      <span>5</span>
                      <span>10 (Maximum)</span>
                    </div>
                  </div>

                  {/* Streams Per File */}
                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-medium text-[var(--text-secondary)]">Streams Per Download</span>
                      <span className="font-mono font-bold text-[var(--accent)] text-sm">
                        {settings.downloads.maxConnectionsPerFile} Streams
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={32}
                      value={settings.downloads.maxConnectionsPerFile}
                      onChange={(e) => update("downloads", { maxConnectionsPerFile: Number(e.target.value) })}
                      className="w-full accent-[var(--accent)] cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] font-mono">
                      <span>1 Stream</span>
                      <span>16 Streams</span>
                      <span>32 Streams</span>
                    </div>
                  </div>
                </div>

                {/* Segmentation Strategy Segmented Control */}
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <label className="text-xs font-semibold text-[var(--text-primary)] block mb-2">
                    Dynamic Byte-Range Splitting Strategy
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {[
                      {
                        id: "automatic" as const,
                        label: "Automatic (Dynamic Range)",
                        desc: "Splits into byte-ranges when HTTP 206 advertised",
                      },
                      {
                        id: "aggressive" as const,
                        label: "Aggressive Multi-Stream",
                        desc: "Immediately probes and partitions chunks",
                      },
                      {
                        id: "disabled" as const,
                        label: "Single Stream Only",
                        desc: "Strict 1-thread mode for fragile servers",
                      },
                    ].map((mode) => (
                      <button
                        key={mode.id}
                        onClick={() => update("downloads", { segmentedDownloads: mode.id })}
                        className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                          settings.downloads.segmentedDownloads === mode.id
                            ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)] font-semibold"
                            : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                        }`}
                      >
                        <div className="text-xs text-[var(--text-primary)]">{mode.label}</div>
                        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{mode.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Smart Category Rules Table Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[var(--text-primary)] block">
                    Extension-to-Folder Mapping Rules
                  </label>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {settings.categories.length} Registered Categories
                  </span>
                </div>

                <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-chassis)]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--bg-card)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      <tr>
                        <th className="py-2 px-3 w-8">Active</th>
                        <th className="py-2 px-3">Category</th>
                        <th className="py-2 px-3">Extensions</th>
                        <th className="py-2 px-3">Destination Path</th>
                        <th className="py-2 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-dim)] font-mono text-[11px]">
                      {settings.categories.map((cat) => (
                        <tr key={cat.id} className="hover:bg-[var(--bg-card-hover)]">
                          <td className="py-2 px-3 text-center">
                            <input
                              type="checkbox"
                              checked={cat.enabled}
                              onChange={(e) => {
                                const updatedCats = settings.categories.map((c) =>
                                  c.id === cat.id ? { ...c, enabled: e.target.checked } : c
                                );
                                onUpdateSettings({ ...settings, categories: updatedCats });
                                saveSettings({ ...settings, categories: updatedCats });
                              }}
                              className="w-4 h-4 rounded accent-[var(--accent)] cursor-pointer"
                            />
                          </td>
                          <td className="py-2 px-3 font-semibold text-[var(--text-primary)]">{cat.name}</td>
                          <td className="py-2 px-3">
                            <div className="flex flex-wrap gap-1">
                              {cat.extensions.map((ext) => (
                                <span
                                  key={ext}
                                  className="px-1 py-0.2 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[10px]"
                                >
                                  .{ext}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-[var(--text-muted)] truncate max-w-xs">
                            {cat.destinationDirectory}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => handleDeleteCategory(cat.id)}
                              className="p-1 rounded text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                              title="Delete Rule"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Add Custom Rule Strip */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="New Category (e.g. Torrents)"
                    value={customCatName}
                    onChange={(e) => setCustomCatName(e.target.value)}
                    className="flex-1 h-8 px-2.5 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    type="text"
                    placeholder="Extensions (e.g. torrent, magnet)"
                    value={customCatExt}
                    onChange={(e) => setCustomCatExt(e.target.value)}
                    className="flex-1 h-8 px-2.5 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={handleAddCategory}
                    className="btn-3d h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span>Add Rule</span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* ═════════════════════════════════════════════════════════
              SECTION 3: NETWORK & BROWSER
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("network") && (
            <section id="section-network" className="space-y-6 pt-1 pb-8 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <Globe className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">Network & Browser Integration</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Browser extension companion status, clipboard URL sniffer, proxy gateways, and connection timeouts.
                </p>
              </div>

              {/* Browser Extension Companion Status Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[var(--text-primary)] block">
                    Browser Extension Bridge
                  </label>
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Native Messaging Host v0.0.1 Connected
                  </div>
                </div>

                <div className="space-y-2.5 pt-1">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.browser.integrationEnabled}
                      onChange={(e) => update("browser", { integrationEnabled: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Automatically intercept download clicks in Chrome, Edge, Brave, and Firefox
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.browser.interceptMediaStreams}
                      onChange={(e) => update("browser", { interceptMediaStreams: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Detect and capture streaming video/audio media (HLS, DASH, MP4)
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.browser.clipboardMonitoringEnabled}
                      onChange={(e) => update("browser", { clipboardMonitoringEnabled: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer align-middle transition-transform active:scale-90"
                    />
                    <div className="text-xs">
                      <span className="font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        Monitor system clipboard for downloadable URLs and open Add Task dialog
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Proxy & Protocol Card */}
              <div className="card-3d p-4 rounded-xl space-y-4">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">Proxy Configuration</label>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { id: "direct" as const, label: "Direct Connection", desc: "No proxy intermediary" },
                    { id: "system" as const, label: "Use System Proxy", desc: "Inherit OS network settings" },
                    { id: "manual" as const, label: "Manual Proxy", desc: "Custom SOCKS5 / HTTP proxy" },
                  ].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => update("network", { proxyMode: p.id })}
                      className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                        settings.network.proxyMode === p.id
                          ? "bg-[var(--bg-active)] border-[var(--accent)] ring-1 ring-[var(--accent-glow)] font-semibold"
                          : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                      }`}
                    >
                      <div className="text-xs text-[var(--text-primary)]">{p.label}</div>
                      <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{p.desc}</div>
                    </button>
                  ))}
                </div>

                {settings.network.proxyMode === "manual" && (
                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase block mb-1">
                        Protocol
                      </label>
                      <select
                        value={settings.network.proxyProtocol}
                        onChange={(e) => update("network", { proxyProtocol: e.target.value as any })}
                        className="w-full h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]"
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP</option>
                        <option value="https">HTTPS</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase block mb-1">
                        Proxy Host
                      </label>
                      <input
                        type="text"
                        value={settings.network.proxyHost}
                        onChange={(e) => update("network", { proxyHost: e.target.value })}
                        className="w-full h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-mono text-[var(--text-primary)]"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase block mb-1">
                        Port
                      </label>
                      <input
                        type="number"
                        value={settings.network.proxyPort || ""}
                        onChange={(e) => update("network", { proxyPort: Number(e.target.value) || null })}
                        className="w-full h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-mono text-[var(--text-primary)]"
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ═════════════════════════════════════════════════════════
              SECTION 4: AUTOMATION & QUEUES
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("automation") && (
            <section id="section-automation" className="space-y-6 pt-1 pb-8 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">Automation, Queues & Alerts</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Schedule off-peak downloads, trigger automated power events on completion, and customize desktop notifications.
                </p>
              </div>

              {/* Download Scheduler Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">
                      Scheduled Downloads & Off-Peak Bandwidth
                    </label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Automatically start queue during designated low-cost hours.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.queues.schedulerEnabled}
                    onChange={(e) => update("queues", { schedulerEnabled: e.target.checked })}
                    className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                  />
                </div>

                {settings.queues.schedulerEnabled && (
                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase block mb-1">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={settings.queues.offPeakStart}
                        onChange={(e) => update("queues", { offPeakStart: e.target.value })}
                        className="w-full h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-mono text-[var(--text-primary)]"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase block mb-1">
                        End Time
                      </label>
                      <input
                        type="time"
                        value={settings.queues.offPeakEnd}
                        onChange={(e) => update("queues", { offPeakEnd: e.target.value })}
                        className="w-full h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-mono text-[var(--text-primary)]"
                      />
                    </div>
                  </div>
                )}

                {/* Post Completion Action */}
                <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">
                      Action When All Downloads Complete
                    </label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Execute automated OS power action upon queue drain.
                    </span>
                  </div>
                  <select
                    value={settings.queues.postCompletionAction}
                    onChange={(e) => update("queues", { postCompletionAction: e.target.value as any })}
                    className="h-8 px-2.5 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]"
                  >
                    <option value="none">Do Nothing</option>
                    <option value="sleep">Sleep Computer</option>
                    <option value="hibernate">Hibernate</option>
                    <option value="shutdown">Shut Down PC</option>
                  </select>
                </div>
              </div>

              {/* Desktop Notifications Card */}
              <div className="card-3d p-4 rounded-xl space-y-2.5">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  Notification & Audio Alerts
                </label>

                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.notifications.downloadCompleted}
                      onChange={(e) => update("notifications", { downloadCompleted: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Show OS desktop banner when a download finishes
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.notifications.playSound}
                      onChange={(e) => update("notifications", { playSound: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Play acoustic completion chime on success
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.notifications.lowDiskSpace}
                      onChange={(e) => update("notifications", { lowDiskSpace: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Warn when disk free space falls below threshold (&lt; 2 GB)
                    </span>
                  </label>
                </div>
              </div>
            </section>
          )}

          {/* ═════════════════════════════════════════════════════════
              SECTION 5: SECURITY & ENGINE
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("engine") && (
            <section id="section-engine" className="space-y-6 pt-1 pb-8 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">Security & Core Engine</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Integrity checksum verification, Windows MOTW protection, and NTFS sparse file disk pre-allocation.
                </p>
              </div>

              {/* Security Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">File Integrity & MOTW</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.security.verifyChecksums}
                      onChange={(e) => update("security", { verifyChecksums: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Automatically calculate and verify SHA-256 / MD5 checksums after transfer
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.security.blockInsecureHttp}
                      onChange={(e) => update("security", { blockInsecureHttp: e.target.checked })}
                      className="w-[18px] h-[18px] rounded accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Warn and block unencrypted plain HTTP downloads
                    </span>
                  </label>
                </div>
              </div>

              {/* Engine Tuning Card */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  High-Performance Engine Tuning
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)]">
                    <span className="text-xs font-semibold text-[var(--text-primary)] block">
                      NTFS Sparse Allocation
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)] mt-0.5 block">
                      Instantly reserves cluster offsets with 0ms disk overhead and zero file fragmentation.
                    </span>
                    <span className="mt-2 inline-block text-[10px] font-mono text-emerald-400">
                      FSCTL_SET_SPARSE Enabled
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)]">
                    <span className="text-xs font-semibold text-[var(--text-primary)] block">
                      Flush-Before-Checkpoint
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)] mt-0.5 block">
                      Guarantees clean recovery without corruption during sudden system crashes or power outages.
                    </span>
                    <span className="mt-2 inline-block text-[10px] font-mono text-emerald-400">
                      Crash-Consistent WAL
                    </span>
                  </div>
                </div>
              </div>

              {/* Global Shortcuts Matrix */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  Keyboard Shortcuts Reference
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  {[
                    { key: "Ctrl + N", desc: "Add New URL" },
                    { key: "Space", desc: "Pause / Resume" },
                    { key: "Delete", desc: "Remove Task" },
                    { key: "Ctrl + ,", desc: "Preferences" },
                    { key: "Enter", desc: "Download Status" },
                    { key: "Esc", desc: "Close / Back" },
                  ].map((s) => (
                    <div
                      key={s.key}
                      className="p-2 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] flex items-center justify-between font-mono"
                    >
                      <span className="text-[var(--text-muted)] text-[11px] font-sans">{s.desc}</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[10px] text-[var(--accent)] font-bold">
                        {s.key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* ═════════════════════════════════════════════════════════
              SECTION 6: ABOUT & MAINTENANCE
          ══════════════════════════════════════════════════════════ */}
          {isSectionVisible("about") && (
            <section id="section-about" className="space-y-6 pt-1 pb-8">
              <div>
                <div className="flex items-center gap-2">
                  <Info className="w-5 h-5 text-[var(--accent)]" />
                  <h2 className="text-base font-bold text-[var(--text-primary)]">About & Maintenance</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Engine telemetry, version specifications, configuration backup/restore, and reset operations.
                </p>
              </div>

              {/* Version & Build Spec Card */}
              <div className="card-3d p-4 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img src="/logo.png" alt="EDM Logo" className="w-10 h-10 object-contain drop-shadow" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-[var(--text-primary)]">Edge Download Manager</span>
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-[var(--accent-badge-bg)] text-[var(--accent-badge-text)] border border-[var(--accent-badge-border)]">
                        PRO v0.0.1
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] mt-0.5 font-mono">
                      x86_64-pc-windows-msvc • Tokio 1.40 • SQLite 3.46 WAL
                    </p>
                  </div>
                </div>
                <div className="text-right text-[11px] font-mono text-[var(--text-muted)] hidden sm:block">
                  <div>Tauri 2.0 Native Shell</div>
                  <div className="text-emerald-400">Zero Telemetry Leaks</div>
                </div>
              </div>

              {/* Software Updates & Check for Updates Card */}
              <div className="card-3d p-4 rounded-xl space-y-3.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <label className="text-xs font-semibold text-[var(--text-primary)] block">
                      Software Updates
                    </label>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {updateStatus === "checking"
                        ? "Checking upstream GitHub releases and signature manifests..."
                        : updateStatus === "up-to-date"
                        ? "EDM is up to date. You are running the latest production build."
                        : `Current channel: Stable. Last checked: ${lastCheckedTime}`}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {updateStatus === "up-to-date" && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        Up to Date
                      </span>
                    )}

                    <button
                      onClick={handleCheckUpdate}
                      disabled={updateStatus === "checking"}
                      className="btn-3d h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      title="Check for newer EDM versions"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 text-[var(--accent)] ${
                          updateStatus === "checking" ? "animate-spin" : ""
                        }`}
                      />
                      <span>{updateStatus === "checking" ? "Checking..." : "Check for Updates"}</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 border-t border-[var(--border-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={settings.general.autoCheckUpdates}
                      onChange={(e) => update("general", { autoCheckUpdates: e.target.checked })}
                      className="edm-checkbox"
                    />
                    <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                      Automatically check for updates on application launch
                    </span>
                  </label>

                  <span className="text-[10px] font-mono text-[var(--text-muted)]">
                    Channel: <span className="text-[var(--accent)] font-semibold">Stable (Production)</span>
                  </span>
                </div>
              </div>

              {/* Backup & Import Configuration */}
              <div className="card-3d p-4 rounded-xl space-y-3">
                <label className="text-xs font-semibold text-[var(--text-primary)] block">
                  Configuration Backup & Migration
                </label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleExport}
                    className="btn-3d h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span>Backup Settings (JSON)</span>
                  </button>

                  <label className="btn-3d h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
                    <Upload className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Restore Settings...</span>
                    <input type="file" accept=".json" onChange={handleImport} className="hidden" />
                  </label>
                </div>
              </div>

              {/* Danger Zone: Factory Reset */}
              <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/5 space-y-2">
                <div className="flex items-center gap-2 text-rose-400 font-semibold text-xs">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Factory Reset</span>
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Permanently restores all EDM preferences, categories, and network configs to original defaults.
                </p>
                <button
                  onClick={() => {
                    if (confirm("Reset ALL settings to factory defaults? This action cannot be undone.")) {
                      onUpdateSettings(defaultSettings);
                      saveSettings(defaultSettings);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 cursor-pointer transition-colors"
                >
                  Factory Reset All Settings
                </button>
              </div>
            </section>
          )}
          </div>
        </main>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          3. TRANSLATOR COMMUNITY MODAL
      ────────────────────────────────────────────────────────────── */}
      {showTranslatorNotice && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="panel-3d w-full max-w-md p-5 rounded-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-[var(--accent)]" />
              <h3 className="font-bold text-sm text-[var(--text-primary)]">Contribute Translation</h3>
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              EDM locale strings are stored in open JSON files. You can add a new language or improve existing locale
              packs by creating a translation file in{" "}
              <code className="text-emerald-400 font-mono text-[11px]">crates/edm-locales/</code>.
            </p>
            <div className="p-2.5 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] font-mono">
              Locale Template: en-US.json → es-ES.json, hi-IN.json
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowTranslatorNotice(false)}
                className="btn-primary-3d h-7 px-4 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          4. PINNED FOOTER TELEMETRY STATUS BAR (PERMANENTLY VISIBLE)
      ────────────────────────────────────────────────────────────── */}
      <footer className="h-7 px-3 bg-[var(--bg-footer)] border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-muted)] shrink-0 z-20 select-none overflow-x-auto">
        <div className="flex items-center gap-3 shrink-0">
          {/* Quick Speed Limiter Popover */}
          <div className="relative">
            <button
              onClick={() => setIsLimiterOpen(!isLimiterOpen)}
              className="hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer transition-colors"
              title="Global Speed Limiter"
            >
              <Gauge className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span className="font-mono text-xs text-[var(--text-secondary)]">Limit: {speedLimit}</span>
              <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
            </button>
            {isLimiterOpen && (
              <div className="absolute bottom-8 left-0 w-36 rounded-xl bg-[var(--bg-panel)] border border-[var(--border-subtle)] p-1.5 shadow-2xl z-50 text-xs font-mono space-y-0.5 animate-in fade-in zoom-in-95 duration-100">
                {["Unlimited", "50 MB/s", "20 MB/s", "10 MB/s", "5 MB/s", "1 MB/s"].map((val) => (
                  <button
                    key={val}
                    onClick={() => {
                      if (onSpeedLimitChange) onSpeedLimitChange(val);
                      setIsLimiterOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-1 text-xs rounded-lg transition-colors cursor-pointer ${
                      speedLimit === val
                        ? "bg-[var(--accent)] text-[var(--accent-on)] font-medium"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-4 w-[1px] bg-[var(--border-subtle)] shrink-0" />

          {/* Selected Task Quick Readout */}
          <div className="flex items-center gap-2 text-[var(--text-secondary)] min-w-0 truncate">
            {selectedDownload ? (
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 truncate">
                <span className="font-semibold text-[var(--text-primary)] truncate max-w-[100px] sm:max-w-xs">
                  {selectedDownload.name}
                </span>
                <span className="text-[var(--text-muted)]">•</span>
                <span className="font-mono tabular-nums text-[var(--accent)] whitespace-nowrap">
                  {selectedDownload.progress}%
                </span>
                <span className="text-[var(--text-muted)] hidden xs:inline">•</span>
                <span className="hidden xs:inline whitespace-nowrap">{selectedDownload.connections} TCP Threads</span>
                {onInspectDownload && (
                  <button
                    onClick={onInspectDownload}
                    className="ml-1 text-xs text-[var(--accent)] hover:underline hidden sm:flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    <span>View Segments</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                )}
              </div>
            ) : (
              <span className="text-[var(--text-muted)] truncate">Preferences Ready</span>
            )}
          </div>
        </div>

        {/* Right: Aggregate Network Telemetry */}
        <div className="flex items-center gap-2 sm:gap-4 font-mono tabular-nums text-xs shrink-0">
          <div className="flex items-center gap-1 text-emerald-400 font-semibold whitespace-nowrap">
            <ArrowDown className="w-3 h-3" />
            <span>{totalSpeed}</span>
          </div>
          <div className="flex items-center gap-1 text-[var(--text-muted)] whitespace-nowrap">
            <ArrowUp className="w-3 h-3" />
            <span>0 B/s</span>
          </div>
          <div className="h-4 w-[1px] bg-[var(--border-subtle)] hidden sm:block shrink-0" />
          <div className="hidden sm:flex items-center gap-1.5 text-[var(--text-secondary)] whitespace-nowrap">
            <Cpu className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>{activeThreads} TCP Threads</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
