import React, { useState, useEffect } from "react";
import {
  X,
  Copy,
  Check,
  ExternalLink,
  FolderCheck,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import {
  detectInstalledChromiumBrowsers,
  runExtensionInstallFlow,
  copyPathToClipboard,
  openExtensionsPage,
  BrowserOption,
} from "../services/extensionInstaller";

interface ExtensionInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialBrowserId?: "chrome" | "edge" | "brave";
}

export const ExtensionInstallModal: React.FC<ExtensionInstallModalProps> = ({
  isOpen,
  onClose,
  initialBrowserId = "chrome",
}) => {
  const [browsers, setBrowsers] = useState<BrowserOption[]>([]);
  const [selectedBrowser, setSelectedBrowser] = useState<string>(initialBrowserId);
  const [folderPath, setFolderPath] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      return;
    }

    const init = async () => {
      setLoading(true);
      setError(null);
      try {
        const detected = await detectInstalledChromiumBrowsers();
        setBrowsers(detected);

        // Pick preferred browser
        const preferred =
          detected.find((b) => b.id === initialBrowserId && b.installed) ||
          detected.find((b) => b.installed) ||
          detected[0];

        const targetId = preferred ? preferred.id : "chrome";
        setSelectedBrowser(targetId);

        // Auto-run install preparation and browser launch
        const res = await runExtensionInstallFlow(targetId);
        if (res.success) {
          setFolderPath(res.folderPath);
          setCopied(res.clipboardCopied);
        } else {
          setError(res.error || "Failed to copy extension files");
        }
      } catch (err: any) {
        setError(err?.message || "Failed to initialize extension setup");
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [isOpen, initialBrowserId]);

  if (!isOpen) return null;

  const currentBrowserName =
    browsers.find((b) => b.id === selectedBrowser)?.name ||
    (selectedBrowser === "edge" ? "Microsoft Edge" : "Google Chrome");

  const handleSelectBrowser = async (id: string) => {
    setSelectedBrowser(id);
    setLoading(true);
    setError(null);
    try {
      const res = await runExtensionInstallFlow(id);
      if (res.success) {
        setFolderPath(res.folderPath);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } else {
        setError(res.error || "Failed to prepare extension files");
      }
    } catch (err: any) {
      setError(err?.message || "Failed to switch browser");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyAgain = async () => {
    if (!folderPath) return;
    const ok = await copyPathToClipboard(folderPath);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const handleOpenExtensionsPage = async () => {
    await openExtensionsPage(selectedBrowser);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ext-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="relative w-full max-w-lg rounded-2xl bg-[#0D0E12] border border-white/10 shadow-[0_24px_64px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.1)] text-[#E4E6EA] overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="px-6 pt-5 pb-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white">
              <Sparkles className="w-4 h-4 text-[#A0A5B0]" />
            </div>
            <div>
              <h2
                id="ext-modal-title"
                className="text-sm font-semibold tracking-tight text-[#FFFFFF]"
              >
                Add extension to {currentBrowserName}
              </h2>
              <p className="text-[11px] text-[#8E939E]">
                Offline bundled extension · Load unpacked flow
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[#7C818A] hover:text-[#FFFFFF] hover:bg-white/10 transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* Browser Selection Tabs (if both Chrome & Edge are installed) */}
          {browsers.length > 1 && (
            <div className="flex items-center gap-2 p-1 rounded-xl bg-black/40 border border-white/5">
              {browsers
                .filter((b) => b.id === "chrome" || b.id === "edge" || b.id === "brave")
                .map((b) => {
                  const isSelected = selectedBrowser === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => handleSelectBrowser(b.id)}
                      className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 cursor-pointer ${
                        isSelected
                          ? "bg-white/10 text-[#FFFFFF] shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] border border-white/10 font-semibold"
                          : "text-[#8E939E] hover:text-[#E4E6EA] hover:bg-white/[0.04]"
                      }`}
                    >
                      <span>{b.name}</span>
                      {b.installed && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      )}
                    </button>
                  );
                })}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {/* Three Steps Card */}
          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#7C818A]">
              Follow 3 Steps in {currentBrowserName}
            </div>

            <ol className="space-y-2.5 text-xs text-[#B8BCC4]">
              <li className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <span className="w-5 h-5 rounded-md bg-white/10 border border-white/15 text-[11px] font-mono font-semibold flex items-center justify-center text-white shrink-0">
                  1
                </span>
                <div className="space-y-0.5">
                  <div className="font-medium text-[#E4E6EA]">
                    Turn on <span className="text-white font-semibold">Developer mode</span>
                  </div>
                  <div className="text-[11px] text-[#7C818A]">
                    Toggle the switch located at the top-right corner of the opened extensions tab.
                  </div>
                </div>
              </li>

              <li className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <span className="w-5 h-5 rounded-md bg-white/10 border border-white/15 text-[11px] font-mono font-semibold flex items-center justify-center text-white shrink-0">
                  2
                </span>
                <div className="space-y-0.5">
                  <div className="font-medium text-[#E4E6EA]">
                    Click <span className="text-white font-semibold">Load unpacked</span>
                  </div>
                  <div className="text-[11px] text-[#7C818A]">
                    Click the button that appeared on the top-left toolbar.
                  </div>
                </div>
              </li>

              <li className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <span className="w-5 h-5 rounded-md bg-white/10 border border-white/15 text-[11px] font-mono font-semibold flex items-center justify-center text-white shrink-0">
                  3
                </span>
                <div className="space-y-0.5">
                  <div className="font-medium text-[#E4E6EA]">
                    Paste the path and click <span className="text-white font-semibold">Select Folder</span>
                  </div>
                  <div className="text-[11px] text-[#7C818A]">
                    The extension folder path has already been copied to your clipboard. Simply paste (Ctrl+V) into the folder picker.
                  </div>
                </div>
              </li>
            </ol>
          </div>

          {/* Extension Path Read-Only Field & Copy Again */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#8E939E] font-medium flex items-center gap-1.5">
                <FolderCheck className="w-3.5 h-3.5 text-emerald-400" />
                Permanent User Folder
              </span>
              {copied && (
                <span className="text-emerald-400 text-[11px] font-medium flex items-center gap-1 animate-pulse">
                  <Check className="w-3 h-3" /> Path copied to clipboard!
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={folderPath || "Preparing extension folder..."}
                className="flex-1 h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs font-mono text-[#D1D5DB] select-all focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCopyAgain}
                className="h-9 px-3 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 border border-white/10 text-white flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors shadow-sm"
                title="Copy folder path to clipboard"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied" : "Copy again"}</span>
              </button>
            </div>
          </div>

          {/* Browser Notice Warning Reassurance */}
          <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/15 text-[#A0A5B0] text-xs flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="leading-relaxed text-[11px]">
              <span className="text-[#E4E6EA] font-semibold">Note:</span> {currentBrowserName} may show a &quot;disable developer mode extensions&quot; warning when launching. This is standard browser behavior for local extensions and is safe to dismiss.
            </div>
          </div>
        </div>

        {/* Modal Actions Footer */}
        <div className="px-6 py-4 border-t border-white/10 bg-black/40 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleOpenExtensionsPage}
            disabled={loading}
            className="h-9 px-3.5 rounded-lg text-xs font-medium text-[#B8BCC4] hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open extensions page again</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="h-9 px-5 rounded-lg text-xs font-semibold bg-gradient-to-b from-[#FFFFFF] to-[#D8DBE0] text-[#0A0B0E] hover:from-[#FFFFFF] hover:to-[#E8EBF0] shadow-[0_2px_8px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.9)] transition-all cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
