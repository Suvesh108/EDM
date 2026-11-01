import React, { useState } from "react";
import {
  X,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { backdropVariants, modalVariants } from "../utils/motion";
import { tauriRefreshDownloadLink } from "../services/tauriBridge";
import { formatBytes } from "../utils/format";

interface RefreshLinkModalProps {
  task: {
    id: string;
    name: string;
    url: string;
    sizeDone: number;
    sizeTotal: number;
  } | null;
  isOpen: boolean;
  onClose: () => void;
  onRefreshed: (taskId: string, newUrl: string) => void;
}

export const RefreshLinkModal: React.FC<RefreshLinkModalProps> = ({
  task,
  isOpen,
  onClose,
  onRefreshed,
}) => {
  const [newUrl, setNewUrl] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen || !task) return null;

  const handleValidateAndResume = async () => {
    if (!newUrl.trim()) {
      setErrorMsg("Please enter a new download URL.");
      return;
    }

    setIsValidating(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await tauriRefreshDownloadLink(task.id, newUrl.trim());
      setSuccessMsg("Link validated and 1 MiB chunk overlap verified! Resuming download...");
      setTimeout(() => {
        onRefreshed(task.id, newUrl.trim());
        onClose();
      }, 1200);
    } catch (err: any) {
      setErrorMsg(err.toString());
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        />

        {/* Modal Window */}
        <motion.div
          variants={modalVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="relative w-full max-w-lg rounded-2xl panel-3d shadow-2xl overflow-hidden flex flex-col z-10 border border-[var(--border-subtle)]"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-panel)]">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400">
                <RotateCcw className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                  Refresh Expired Download Link
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Resume without losing downloaded progress
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* Task Info Summary */}
            <div className="p-3.5 rounded-xl bg-black/20 border border-[var(--border-subtle)] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[var(--text-primary)] truncate max-w-xs">
                  {task.name}
                </span>
                <span className="text-[var(--accent)] font-medium">
                  {formatBytes(task.sizeDone)} / {formatBytes(task.sizeTotal)}
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] truncate font-mono">
                Expired: {task.url}
              </p>
            </div>

            {/* Explanatory Notice */}
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-blue-400" />
              <div>
                <p className="font-semibold">Safe Overlap Verification</p>
                <p className="text-[11px] text-blue-300/80 mt-0.5">
                  EDM verifies size and tests a 1 MiB cryptographic chunk overlap before resuming to ensure the new link points to the exact identical file.
                </p>
              </div>
            </div>

            {/* New URL Input */}
            <div>
              <label className="text-xs font-semibold text-[var(--text-secondary)] block mb-1.5">
                Paste Fresh Download URL
              </label>
              <textarea
                rows={3}
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://..."
                className="w-full p-2.5 rounded-xl text-xs font-mono input-3d text-[var(--text-primary)] focus:outline-none resize-none leading-relaxed"
              />
            </div>

            {/* Error or Success feedback */}
            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
            {successMsg && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded-lg text-xs font-medium btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!newUrl.trim() || isValidating}
              onClick={handleValidateAndResume}
              className={`btn-primary-3d h-8 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-all ${
                !newUrl.trim() || isValidating
                  ? "opacity-40 cursor-not-allowed pointer-events-none"
                  : "cursor-pointer shadow-md"
              }`}
            >
              {isValidating ? (
                <span>Verifying Overlap...</span>
              ) : (
                <>
                  <span>Validate & Resume</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
