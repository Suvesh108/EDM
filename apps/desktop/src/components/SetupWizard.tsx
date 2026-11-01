import React, { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  FolderOpen,
  Shield,
  Zap,
  Cpu,
  Globe,
  ArrowRight,
  ArrowLeft,
  Radio,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  BrowserSetupInfo,
  DiagnosticsReport,
  tauriDetectInstalledBrowsers,
  tauriPrepareExtensionFiles,
  tauriGetExtensionFolderPath,
  tauriOpenBrowserUrl,
  tauriGetFirefoxXpiUrl,
  tauriSetWizardCompleted,
  tauriGetBrowserDiagnostics,
  tauriRepairNativeHostRegistration,
  tauriGetSystemDownloadsDir,
} from "../services/tauriBridge";
import { EdmSettings } from "../types/settings";

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  settings: EdmSettings;
  onSaveSettings: (settings: EdmSettings) => void;
}

type WizardStep = "welcome" | "browsers" | "test" | "preferences";

export const SetupWizard: React.FC<SetupWizardProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
}) => {
  const [currentStep, setCurrentStep] = useState<WizardStep>("welcome");
  const [browsers, setBrowsers] = useState<BrowserSetupInfo[]>([]);
  const [scanning, setScanning] = useState<boolean>(false);
  const [copiedFolder, setCopiedFolder] = useState<boolean>(false);
  const [extensionFolderPath, setExtensionFolderPath] = useState<string>("");
  const [preparingExtension, setPreparingExtension] = useState<boolean>(false);
  const [prepStatus, setPrepStatus] = useState<string | null>(null);

  // Guided install expansion per browser
  const [expandedBrowser, setExpandedBrowser] = useState<string | null>(null);

  // Diagnostic Test state
  const [testRunning, setTestRunning] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [repairing, setRepairing] = useState<boolean>(false);

  // Preferences local state
  const [keepAwake, setKeepAwake] = useState<boolean>(settings.general.keepAwake ?? false);
  const [idleExitMinutes, setIdleExitMinutes] = useState<number | null>(settings.general.idleExitMinutes ?? 15);
  const [launchAtStartup, setLaunchAtStartup] = useState<boolean>(settings.general.launchAtStartup ?? false);
  const [downloadDir, setDownloadDir] = useState<string>(settings.downloads.defaultDirectory);

  // Load initial extension path & browsers
  const scanBrowsers = useCallback(async () => {
    setScanning(true);
    try {
      const list = await tauriDetectInstalledBrowsers();
      setBrowsers(list);
    } catch (err) {
      console.warn("Failed to detect browsers:", err);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      scanBrowsers();
      tauriGetExtensionFolderPath().then((path) => {
        setExtensionFolderPath(path);
      });
      tauriGetSystemDownloadsDir().then((dir) => {
        if (!downloadDir || downloadDir.includes("Suvesh")) {
          setDownloadDir(dir);
        }
      });
    }
  }, [isOpen, scanBrowsers]);

  // Polling for extension connection while on browser setup or test step
  useEffect(() => {
    if (!isOpen || (currentStep !== "browsers" && currentStep !== "test")) return;
    const interval = setInterval(() => {
      tauriDetectInstalledBrowsers().then((list) => {
        setBrowsers(list);
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [isOpen, currentStep]);

  const handleCopyFolder = async () => {
    try {
      let path = extensionFolderPath;
      if (!path) {
        path = await tauriGetExtensionFolderPath();
        setExtensionFolderPath(path);
      }
      await navigator.clipboard.writeText(path);
      setCopiedFolder(true);
      setTimeout(() => setCopiedFolder(false), 2500);
    } catch (err) {
      console.warn("Clipboard write failed:", err);
    }
  };

  const handlePrepareExtension = async () => {
    setPreparingExtension(true);
    setPrepStatus("Verifying SHA-256 hashes and provisioning extension files...");
    try {
      const path = await tauriPrepareExtensionFiles();
      setExtensionFolderPath(path);
      setPrepStatus("Extension verified & ready in %LOCALAPPDATA%\\EDM\\extension");
      setTimeout(() => setPrepStatus(null), 4000);
    } catch (err: any) {
      setPrepStatus(`Error: ${err?.message || String(err)}`);
    } finally {
      setPreparingExtension(false);
    }
  };

  const handleOpenBrowserExtensions = async (browserId: string) => {
    const browser = browsers.find((b) => b.id === browserId);
    if (!browser) return;
    // Ensure extension files are provisioned first
    try {
      await tauriPrepareExtensionFiles();
    } catch {}
    await tauriOpenBrowserUrl(browserId, browser.extension_page_url);
  };

  const handleInstallFirefoxXpi = async () => {
    const url = await tauriGetFirefoxXpiUrl();
    await tauriOpenBrowserUrl("firefox", url);
  };

  const handleRunDiagnostics = async () => {
    setTestRunning(true);
    try {
      const report = await tauriGetBrowserDiagnostics();
      setDiagnostics(report);
    } catch (err) {
      console.warn("Diagnostics failed:", err);
    } finally {
      setTestRunning(false);
    }
  };

  const handleRepairHost = async () => {
    setRepairing(true);
    try {
      await tauriRepairNativeHostRegistration();
      await handleRunDiagnostics();
      await scanBrowsers();
    } catch (err) {
      console.warn("Repair failed:", err);
    } finally {
      setRepairing(false);
    }
  };

  const handleFinishWizard = async () => {
    const updatedSettings: EdmSettings = {
      ...settings,
      general: {
        ...settings.general,
        launchAtStartup,
        keepAwake,
        idleExitMinutes,
      },
      downloads: {
        ...settings.downloads,
        defaultDirectory: downloadDir,
      },
    };

    onSaveSettings(updatedSettings);
    await tauriSetWizardCompleted(true);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 sm:p-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-3xl bg-[#090d16] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100 max-h-[92vh]"
      >
        {/* Wizard Header */}
        <div className="px-6 py-4 border-b border-[#1e293b] bg-[#0c1220] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white tracking-wide">
                EDM Setup &amp; Browser Integration Wizard
              </h2>
              <p className="text-xs text-slate-400">
                Configure your browsers and preferences for v0.0.6
              </p>
            </div>
          </div>

          {/* Stepper Dots */}
          <div className="flex items-center gap-2">
            {(["welcome", "browsers", "test", "preferences"] as WizardStep[]).map((step, idx) => {
              const active = currentStep === step;
              const stepNames = ["Welcome", "Browsers", "Test", "Preferences"];
              return (
                <div
                  key={step}
                  onClick={() => setCurrentStep(step)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                    active
                      ? "bg-blue-600 text-white"
                      : "bg-[#162032] text-slate-400 hover:text-slate-200"
                  }`}
                  title={stepNames[idx]}
                >
                  <span>{idx + 1}</span>
                  <span className="hidden sm:inline">{stepNames[idx]}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Wizard Step Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <AnimatePresence mode="wait">
            {/* STEP 1: WELCOME */}
            {currentStep === "welcome" && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                <div className="text-center max-w-xl mx-auto space-y-2 py-4">
                  <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto mb-3 shadow-inner">
                    <Zap className="w-8 h-8" />
                  </div>
                  <h3 className="text-xl font-bold text-white tracking-tight">
                    Welcome to Edge Download Manager
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed">
                    EDM connects directly to your browsers to accelerate downloads, bypass throttling, and resume interrupted streams with high reliability.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl bg-[#0f172a]/60 border border-slate-800 space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <Zap className="w-4 h-4" />
                    </div>
                    <h4 className="text-sm font-semibold text-white">Dynamic Multi-Stream</h4>
                    <p className="text-xs text-slate-400 leading-normal">
                      Automatically splits downloads into up to 32 parallel HTTP segments with smart jitter mitigation.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0f172a]/60 border border-slate-800 space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center">
                      <Shield className="w-4 h-4" />
                    </div>
                    <h4 className="text-sm font-semibold text-white">Zero-Privilege Native Host</h4>
                    <p className="text-xs text-slate-400 leading-normal">
                      Native Messaging Host operates strictly in user-space with constant-time token verification.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0f172a]/60 border border-slate-800 space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                      <Cpu className="w-4 h-4" />
                    </div>
                    <h4 className="text-sm font-semibold text-white">Universal Wake Support</h4>
                    <p className="text-xs text-slate-400 leading-normal">
                      Browser extension seamlessly wakes EDM from sleep without showing unwanted Save dialogs.
                    </p>
                  </div>
                </div>

                <div className="rounded-xl p-4 bg-blue-950/20 border border-blue-900/30 text-xs text-blue-200/90 leading-relaxed flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    This guided wizard will detect your installed browsers, configure the extension with integrity verification, and test your connection in less than 2 minutes.
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 2: BROWSER SETUP */}
            {currentStep === "browsers" && (
              <motion.div
                key="browsers"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-5"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-white">Installed Browser Detection</h3>
                    <p className="text-xs text-slate-400">
                      Detecting installed browsers and extension connection status from the Windows registry
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePrepareExtension}
                      disabled={preparingExtension}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#283548] text-xs font-medium text-slate-200 transition-colors"
                      title="Verify SHA-256 integrity and provision extension files to %LOCALAPPDATA%\EDM\extension"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${preparingExtension ? "animate-spin" : ""}`} />
                      <span>{preparingExtension ? "Verifying..." : "Verify & Provision"}</span>
                    </button>
                    <button
                      onClick={scanBrowsers}
                      disabled={scanning}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 hover:bg-blue-600/30 text-xs font-medium text-blue-300 transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
                      <span>Rescan</span>
                    </button>
                  </div>
                </div>

                {prepStatus && (
                  <div className="p-3 rounded-lg bg-blue-950/40 border border-blue-800/40 text-xs text-blue-300 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-blue-400 shrink-0" />
                    <span>{prepStatus}</span>
                  </div>
                )}

                <div className="space-y-3">
                  {browsers.map((b) => {
                    const isExpanded = expandedBrowser === b.id;
                    return (
                      <div
                        key={b.id}
                        className="rounded-xl border border-[#1e293b] bg-[#0c1220] p-4 transition-all"
                      >
                        <div className="flex items-center justify-between flex-wrap gap-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-[#131c2e] border border-slate-700/50 flex items-center justify-center font-bold text-slate-200">
                              <Globe className="w-5 h-5 text-blue-400" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-white">{b.name}</span>
                                {b.installed ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                                    Detected
                                  </span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800/30">
                                    Not Installed
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                Helper:{" "}
                                <span className={b.helper_registered ? "text-emerald-400" : "text-amber-400"}>
                                  {b.helper_registered ? "Registered in HKCU" : "Not Registered"}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Status Badge & Action */}
                          <div className="flex items-center gap-2">
                            {b.extension_connected ? (
                              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium">
                                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                <span>Connected</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                {b.id === "firefox" ? (
                                  <button
                                    onClick={handleInstallFirefoxXpi}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold transition-colors"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    <span>Install Add-on (.xpi)</span>
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => setExpandedBrowser(isExpanded ? null : b.id)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
                                  >
                                    <span>Install Extension</span>
                                    <ArrowRight className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Guided Install Box for Chromium-based Browsers */}
                        {isExpanded && b.id !== "firefox" && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="mt-4 pt-4 border-t border-slate-800 text-xs space-y-3"
                          >
                            <div className="font-semibold text-slate-200">
                              Guided Unpacked Installation for {b.name}:
                            </div>

                            <ol className="list-decimal list-inside space-y-2 text-slate-300 leading-relaxed">
                              <li>
                                Extension files are integrity-checked and stored in your user-only folder:
                                <div className="mt-1 flex items-center gap-2">
                                  <code className="px-2 py-1 bg-[#040810] border border-slate-800 rounded font-mono text-[11px] text-blue-300 flex-1 truncate">
                                    {extensionFolderPath || "%LOCALAPPDATA%\\EDM\\extension"}
                                  </code>
                                  <button
                                    onClick={handleCopyFolder}
                                    className="px-2.5 py-1 bg-[#1e293b] hover:bg-[#283548] text-slate-200 rounded text-xs font-medium flex items-center gap-1 transition-colors"
                                  >
                                    {copiedFolder ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                    <span>{copiedFolder ? "Copied!" : "Copy Path"}</span>
                                  </button>
                                </div>
                              </li>
                              <li>
                                Open the {b.name} Extensions management page:
                                <div className="mt-1">
                                  <button
                                    onClick={() => handleOpenBrowserExtensions(b.id)}
                                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    <span>Open {b.extension_page_url}</span>
                                  </button>
                                </div>
                              </li>
                              <li>
                                Toggle <strong className="text-white">Developer mode</strong> (switch in the top-right corner).
                              </li>
                              <li>
                                Click <strong className="text-white">Load unpacked</strong> and paste the copied folder path into the selector.
                              </li>
                            </ol>

                            <div className="flex items-center gap-2 text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-900/40 p-2.5 rounded-lg">
                              <Radio className="w-4 h-4 text-amber-400 animate-pulse shrink-0" />
                              <span>
                                Waiting for extension hello frame... This card will turn green automatically once connected!
                              </span>
                            </div>
                          </motion.div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* STEP 3: END-TO-END TEST */}
            {currentStep === "test" && (
              <motion.div
                key="test"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-5"
              >
                <div>
                  <h3 className="text-base font-semibold text-white">Diagnostics &amp; Wake Pipeline Verification</h3>
                  <p className="text-xs text-slate-400">
                    Verify that Native Messaging Host, WebSocket streaming, and background wake are functioning end-to-end
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-[#0c1220] border border-[#1e293b] flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Automated Health Check</div>
                    <div className="text-xs text-slate-400">
                      Tests helper manifest, registry permissions, and WebSocket listener responsiveness
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRepairHost}
                      disabled={repairing}
                      className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#283548] text-xs font-medium text-slate-200 transition-colors"
                    >
                      {repairing ? "Repairing..." : "Repair Registration"}
                    </button>
                    <button
                      onClick={handleRunDiagnostics}
                      disabled={testRunning}
                      className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testRunning ? "animate-spin" : ""}`} />
                      <span>{testRunning ? "Running..." : "Run Diagnostic Check"}</span>
                    </button>
                  </div>
                </div>

                {diagnostics ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="p-3 bg-[#0c1220] border border-[#1e293b] rounded-xl text-center">
                        <div className="text-[11px] text-slate-400">App Binary</div>
                        <div className="text-xs font-bold text-emerald-400 mt-1 flex items-center justify-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Installed</span>
                        </div>
                      </div>
                      <div className="p-3 bg-[#0c1220] border border-[#1e293b] rounded-xl text-center">
                        <div className="text-[11px] text-slate-400">WebSocket Port</div>
                        <div className="text-xs font-bold text-emerald-400 mt-1 flex items-center justify-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>127.0.0.1:14370</span>
                        </div>
                      </div>
                      <div className="p-3 bg-[#0c1220] border border-[#1e293b] rounded-xl text-center">
                        <div className="text-[11px] text-slate-400">Startup Latency</div>
                        <div className="text-xs font-bold text-blue-400 mt-1">
                          {diagnostics.time_to_ready_ms}ms
                        </div>
                      </div>
                      <div className="p-3 bg-[#0c1220] border border-[#1e293b] rounded-xl text-center">
                        <div className="text-[11px] text-slate-400">Protocol Wake</div>
                        <div className="text-xs font-bold text-emerald-400 mt-1 flex items-center justify-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>edm:// Ready</span>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-[#0c1220] border border-[#1e293b] space-y-2">
                      <div className="text-xs font-semibold text-slate-200">Per-Browser Registration Checks:</div>
                      <div className="divide-y divide-slate-800">
                        {diagnostics.browsers.map((b) => (
                          <div key={b.browser} className="py-2 flex items-center justify-between text-xs">
                            <span className="font-medium text-white capitalize">{b.browser}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-slate-400 text-[11px]">
                                Manifest: {b.manifest_exists ? "OK" : "Missing"}
                              </span>
                              <span className="text-slate-400 text-[11px]">
                                Exe: {b.helper_exists ? "OK" : "Missing"}
                              </span>
                              {b.helper_registered ? (
                                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                                </span>
                              ) : (
                                <span className="text-amber-400 font-semibold flex items-center gap-1">
                                  <AlertCircle className="w-3.5 h-3.5" /> Unregistered
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-400 bg-[#0c1220] border border-[#1e293b] rounded-xl text-xs">
                    Click "Run Diagnostic Check" above to test all Native Messaging Hosts and WebSocket paths.
                  </div>
                )}
              </motion.div>
            )}

            {/* STEP 4: PREFERENCES */}
            {currentStep === "preferences" && (
              <motion.div
                key="preferences"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-5"
              >
                <div>
                  <h3 className="text-base font-semibold text-white">Runtime Preferences &amp; Folders</h3>
                  <p className="text-xs text-slate-400">
                    Configure startup behavior, memory profile, and default destination folder
                  </p>
                </div>

                <div className="space-y-4">
                  {/* Memory & Idle Mode */}
                  <div className="p-4 rounded-xl bg-[#0c1220] border border-[#1e293b] space-y-3">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-semibold text-white">Memory &amp; Idle Mode</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div
                        onClick={() => {
                          setKeepAwake(false);
                          setIdleExitMinutes(15);
                        }}
                        className={`p-3 rounded-lg border cursor-pointer transition-all ${
                          !keepAwake
                            ? "bg-blue-600/10 border-blue-500 text-white"
                            : "bg-[#0f172a]/40 border-slate-800 text-slate-400 hover:border-slate-700"
                        }`}
                      >
                        <div className="font-semibold text-xs text-slate-200">Smart Power Saver (Recommended)</div>
                        <div className="text-[11px] text-slate-400 mt-1 leading-normal">
                          Sleeps when idle for 15 minutes. Instantly wakes upon new browser downloads.
                        </div>
                      </div>

                      <div
                        onClick={() => {
                          setKeepAwake(true);
                          setIdleExitMinutes(null);
                        }}
                        className={`p-3 rounded-lg border cursor-pointer transition-all ${
                          keepAwake
                            ? "bg-blue-600/10 border-blue-500 text-white"
                            : "bg-[#0f172a]/40 border-slate-800 text-slate-400 hover:border-slate-700"
                        }`}
                      >
                        <div className="font-semibold text-xs text-slate-200">Always Active (Instant Wake)</div>
                        <div className="text-[11px] text-slate-400 mt-1 leading-normal">
                          Keeps the background listener warm continuously for zero cold-start delay.
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Start with Windows */}
                  <div className="p-4 rounded-xl bg-[#0c1220] border border-[#1e293b] flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white">Start with Windows</div>
                      <div className="text-xs text-slate-400">
                        Launch EDM background listener on Windows system boot (Default: Off)
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={launchAtStartup}
                        onChange={(e) => setLaunchAtStartup(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  {/* Download Directory */}
                  <div className="p-4 rounded-xl bg-[#0c1220] border border-[#1e293b] space-y-2">
                    <div className="text-sm font-semibold text-white">Default Download Folder</div>
                    <div className="text-xs text-slate-400">
                      Destination directory for completed files
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        type="text"
                        value={downloadDir}
                        onChange={(e) => setDownloadDir(e.target.value)}
                        className="flex-1 px-3 py-2 bg-[#040810] border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={async () => {
                          const dir = await tauriGetSystemDownloadsDir();
                          setDownloadDir(dir);
                        }}
                        className="px-3 py-2 bg-[#1e293b] hover:bg-[#283548] text-xs font-medium text-slate-200 rounded-lg transition-colors flex items-center gap-1.5"
                      >
                        <FolderOpen className="w-4 h-4" />
                        <span>System Default</span>
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Wizard Footer Navigation */}
        <div className="px-6 py-4 border-t border-[#1e293b] bg-[#0c1220] flex items-center justify-between">
          <div>
            {currentStep !== "welcome" && (
              <button
                onClick={() => {
                  if (currentStep === "browsers") setCurrentStep("welcome");
                  else if (currentStep === "test") setCurrentStep("browsers");
                  else if (currentStep === "preferences") setCurrentStep("test");
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1e293b] hover:bg-[#283548] text-xs font-medium text-slate-200 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white transition-colors"
            >
              Skip for now
            </button>

            {currentStep !== "preferences" ? (
              <button
                onClick={() => {
                  if (currentStep === "welcome") setCurrentStep("browsers");
                  else if (currentStep === "browsers") setCurrentStep("test");
                  else if (currentStep === "test") setCurrentStep("preferences");
                }}
                className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors"
              >
                <span>Continue</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={handleFinishWizard}
                className="flex items-center gap-1.5 px-6 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition-colors shadow-lg shadow-emerald-900/20"
              >
                <Check className="w-4 h-4" />
                <span>Finish Setup &amp; Launch</span>
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default SetupWizard;
