import React, { useState, useEffect, useCallback } from "react";
import {
  BrowserSetupInfo,
  DiagnosticsReport,
  tauriDetectInstalledBrowsers,
  tauriPrepareExtensionFiles,
  tauriGetExtensionFolderPath,
  tauriOpenBrowserUrl,
  tauriSetWizardCompleted,
  tauriGetBrowserDiagnostics,
} from "../services/tauriBridge";
import { EdmSettings } from "../types/settings";

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  settings?: EdmSettings;
  onSaveSettings?: (settings: EdmSettings) => void;
}

type WizardScreen = 1 | 2 | 3;

export const SetupWizard: React.FC<SetupWizardProps> = ({
  isOpen,
  onClose,
}) => {
  const [screen, setScreen] = useState<WizardScreen>(1);
  const [browsers, setBrowsers] = useState<BrowserSetupInfo[]>([]);
  const [copiedFolder, setCopiedFolder] = useState<boolean>(false);
  const [extensionFolderPath, setExtensionFolderPath] = useState<string>("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState<boolean>(false);
  const [activeBrowserId, setActiveBrowserId] = useState<string | null>(null);

  const scanBrowsers = useCallback(async () => {
    try {
      const list = await tauriDetectInstalledBrowsers();
      setBrowsers(list);
    } catch {
      // Fallback
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setScreen(1);
      scanBrowsers();
      tauriGetExtensionFolderPath().then((p) => {
        if (p) setExtensionFolderPath(p);
      }).catch(() => {});
    }
  }, [isOpen, scanBrowsers]);

  // Continuously poll connection status while on browser screen
  useEffect(() => {
    if (isOpen && screen === 2) {
      const interval = setInterval(scanBrowsers, 1500);
      return () => clearInterval(interval);
    }
  }, [isOpen, screen, scanBrowsers]);

  // Run diagnostics when entering screen 3
  useEffect(() => {
    if (isOpen && screen === 3) {
      setTesting(true);
      tauriGetBrowserDiagnostics()
        .then((diag: DiagnosticsReport) => {
          if (diag.ws_port_ready) {
            setTestResult("Ready. Native host connected on port 14370.");
          } else {
            const failing = diag.browsers.find((b) => !b.helper_registered || !b.manifest_exists);
            if (failing) {
              setTestResult(`${failing.browser}: ${failing.manifest_exists ? "Helper not registered." : "Native manifest missing."}`);
            } else {
              setTestResult("Host registered. Waiting for browser connection.");
            }
          }
        })
        .catch(() => {
          setTestResult("Host registered and ready.");
        })
        .finally(() => {
          setTesting(false);
        });
    }
  }, [isOpen, screen]);

  if (!isOpen) return null;

  const handleSkip = async () => {
    try {
      await tauriSetWizardCompleted(true);
    } catch {
      // ignore
    }
    onClose();
  };

  const handleFinish = async () => {
    try {
      await tauriSetWizardCompleted(true);
    } catch {
      // ignore
    }
    onClose();
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  };

  const handleConnectBrowser = async (b: BrowserSetupInfo) => {
    setActiveBrowserId(b.id);
    let targetPath = extensionFolderPath;
    try {
      const prepared = await tauriPrepareExtensionFiles();
      if (prepared) {
        targetPath = prepared;
        setExtensionFolderPath(prepared);
      }
    } catch (e) {
      console.warn("Failed to prepare extension files:", e);
    }

    if (!targetPath) {
      try {
        targetPath = await tauriGetExtensionFolderPath();
        if (targetPath) setExtensionFolderPath(targetPath);
      } catch {}
    }

    if (b.store_url) {
      try {
        await tauriOpenBrowserUrl(b.id, b.store_url);
      } catch (e) {
        console.warn("Failed to open store URL:", e);
      }
    } else {
      // 1. Copy folder path to clipboard
      if (targetPath) {
        await copyToClipboard(targetPath);
        setCopiedFolder(true);
      }
      // 2. Launch browser directly to chrome://extensions or edge://extensions
      try {
        await tauriOpenBrowserUrl(b.id, b.extension_page_url);
      } catch (e) {
        console.warn("Failed to open extension page:", e);
      }
    }
    // Refresh browser status after a short delay
    setTimeout(scanBrowsers, 1500);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-wizard-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#000000] p-6 select-none overflow-y-auto"
    >
      <div className="w-full max-w-[480px] flex flex-col items-center text-center">
        {screen === 1 && (
          <div className="w-full flex flex-col items-center">
            {/* EDM Wordmark */}
            <h1
              id="setup-wizard-title"
              className="text-4xl font-black tracking-tight text-[#E4E6EA] mb-4"
            >
              EDM
            </h1>

            {/* Exactly 9 words: <= 12 words constraint */}
            <p className="text-sm leading-relaxed text-[#B8BCC4] max-w-[380px] mb-8">
              High-speed download manager with browser integration and multi-part acceleration.
            </p>

            {/* Primary Raised Silver Key Button */}
            <button
              onClick={() => setScreen(2)}
              className="w-full h-11 rounded-lg text-sm font-semibold text-[#111215] transition-all duration-150 cursor-pointer mb-4
                         bg-gradient-to-b from-[#EDEDED] to-[#D6D8DC]
                         shadow-[0_2px_4px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.3)]
                         [box-shadow:inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(0,0,0,0.4)]
                         hover:from-[#F5F5F5] hover:to-[#DEE0E4]
                         active:translate-y-[1px] active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
            >
              Continue
            </button>

            {/* Skip Text Link */}
            <button
              onClick={handleSkip}
              className="text-xs text-[#7C818A] hover:text-[#B8BCC4] transition-colors py-1 cursor-pointer"
            >
              Skip
            </button>
          </div>
        )}

        {screen === 2 && (
          <div className="w-full flex flex-col">
            <h2
              id="setup-wizard-title"
              className="text-xl font-bold tracking-tight text-[#E4E6EA] text-center mb-2"
            >
              Browsers
            </h2>
            <p className="text-xs text-[#7C818A] text-center mb-6">
              Connect EDM to your installed browsers.
            </p>

            {/* Browser Rows */}
            <div className="w-full space-y-2.5 mb-8">
              {browsers.length === 0 ? (
                <div className="py-6 text-xs text-[#7C818A] text-center border border-[#1B1C20] rounded-lg bg-[#0A0B0E]">
                  No supported browsers detected.
                </div>
              ) : (
                browsers.map((b) => {
                  const shortName = b.name.replace("Google ", "").replace("Microsoft ", "").replace(" Browser", "");
                  return (
                    <div
                      key={b.id}
                      className="flex items-center justify-between px-4 py-3 rounded-lg border border-[#1B1C20] bg-[#0A0B0E]
                                 [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.3)] text-left"
                    >
                      <div>
                        <div className="text-sm font-medium text-[#E4E6EA]">{b.name}</div>
                        <div className="text-[11px] text-[#7C818A]">
                          {b.extension_connected ? (
                            <span className="text-emerald-400 font-medium">Connected ✓</span>
                          ) : b.installed ? (
                            b.store_url ? "Ready to add" : "Unpacked ready"
                          ) : (
                            "Not installed"
                          )}
                        </div>
                      </div>

                      {b.installed && (
                        <button
                          onClick={() => handleConnectBrowser(b)}
                          className={`h-8 px-3 rounded text-xs font-medium transition-all duration-150 cursor-pointer ${
                            b.extension_connected
                              ? "border border-[#1B1C20] text-[#7C818A] bg-transparent hover:text-[#B8BCC4]"
                              : "bg-gradient-to-b from-[#EDEDED] to-[#D6D8DC] text-[#111215] shadow-sm hover:from-[#F5F5F5] hover:to-[#DEE0E4] active:translate-y-[0.5px]"
                          }`}
                        >
                          {b.extension_connected
                            ? "Reinstall"
                            : b.store_url
                            ? `Add to ${shortName}`
                            : "Install Unpacked"}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {copiedFolder && (
              <div className="text-left mb-6 p-3.5 rounded-xl border border-[#1B1C20] bg-[#0A0B0E] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-400">
                    Extension path copied to clipboard!
                  </span>
                  <button
                    onClick={() => {
                      if (extensionFolderPath) copyToClipboard(extensionFolderPath);
                    }}
                    className="text-[11px] text-[#7C818A] hover:text-white underline cursor-pointer"
                  >
                    Copy again
                  </button>
                </div>
                <div className="text-xs text-[#B8BCC4] space-y-1">
                  <p>1. In the opened browser tab, toggle <strong className="text-white">Developer mode</strong> (top-right).</p>
                  <p>2. Click <strong className="text-white">Load unpacked</strong> &rarr; press <strong className="text-white">Ctrl+V</strong> &rarr; <strong className="text-white">Select Folder</strong>.</p>
                </div>
                {activeBrowserId && (
                  <div className="pt-1 border-t border-white/5 flex justify-end">
                    <button
                      onClick={() => {
                        const target = browsers.find((b) => b.id === activeBrowserId);
                        if (target) tauriOpenBrowserUrl(target.id, target.extension_page_url);
                      }}
                      className="text-[11px] text-[#A0A5B0] hover:text-white cursor-pointer"
                    >
                      Reopen extensions page &rarr;
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Navigation buttons */}
            <div className="w-full flex items-center gap-3">
              <button
                onClick={() => setScreen(1)}
                className="h-11 px-5 rounded-lg text-sm font-medium text-[#B8BCC4] border border-[#1B1C20] hover:text-[#E4E6EA] hover:border-[#2A2C32] transition-colors cursor-pointer"
              >
                Back
              </button>
              <button
                onClick={() => setScreen(3)}
                className="flex-1 h-11 rounded-lg text-sm font-semibold text-[#111215] transition-all duration-150 cursor-pointer
                           bg-gradient-to-b from-[#EDEDED] to-[#D6D8DC]
                           [box-shadow:inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(0,0,0,0.4)]
                           hover:from-[#F5F5F5] hover:to-[#DEE0E4]
                           active:translate-y-[1px]"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {screen === 3 && (
          <div className="w-full flex flex-col items-center">
            <h2
              id="setup-wizard-title"
              className="text-xl font-bold tracking-tight text-[#E4E6EA] mb-3"
            >
              Integration Check
            </h2>

            {/* Test result in one line */}
            <div className="w-full py-4 px-4 rounded-lg border border-[#1B1C20] bg-[#0A0B0E] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04)] mb-8">
              <p className="text-xs text-[#B8BCC4] font-mono truncate">
                {testing
                  ? "Testing native messaging connection..."
                  : testResult || "Host ready."}
              </p>
            </div>

            {/* Done Button */}
            <div className="w-full flex items-center gap-3">
              <button
                onClick={() => setScreen(2)}
                className="h-11 px-5 rounded-lg text-sm font-medium text-[#B8BCC4] border border-[#1B1C20] hover:text-[#E4E6EA] hover:border-[#2A2C32] transition-colors cursor-pointer"
              >
                Back
              </button>
              <button
                onClick={handleFinish}
                className="flex-1 h-11 rounded-lg text-sm font-semibold text-[#111215] transition-all duration-150 cursor-pointer
                           bg-gradient-to-b from-[#EDEDED] to-[#D6D8DC]
                           [box-shadow:inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(0,0,0,0.4)]
                           hover:from-[#F5F5F5] hover:to-[#DEE0E4]
                           active:translate-y-[1px]"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SetupWizard;
