import React, { useState, useEffect } from "react";
import {
  X,
  Sparkles,
  AlertTriangle,
  ListFilter,
  ArrowRight,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { backdropVariants, modalVariants } from "../utils/motion";
import { tauriExpandBatchUrls, tauriAddBatchDownloads } from "../services/tauriBridge";

interface BatchDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (count: number) => void;
}

export const BatchDownloadModal: React.FC<BatchDownloadModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [pattern, setPattern] = useState("");
  const [expandedUrls, setExpandedUrls] = useState<string[]>([]);
  const [isExpanding, setIsExpanding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!pattern.trim()) {
      setExpandedUrls([]);
      setErrorMsg(null);
      return;
    }

    const timer = setTimeout(async () => {
      setIsExpanding(true);
      setErrorMsg(null);
      try {
        const urls = await tauriExpandBatchUrls(pattern.trim());
        setExpandedUrls(urls);
      } catch (err: any) {
        setErrorMsg(err.toString());
        setExpandedUrls([]);
      } finally {
        setIsExpanding(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [pattern]);

  const handleStartBatch = async () => {
    if (expandedUrls.length === 0) return;
    if (expandedUrls.length > 200) {
      if (
        !confirm(
          `You are about to queue ${expandedUrls.length} downloads at once. Continue?`
        )
      ) {
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const added = await tauriAddBatchDownloads(expandedUrls);
      onSuccess(added);
      onClose();
    } catch (err: any) {
      alert("Failed to start batch: " + err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

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
          className="relative w-full max-w-xl rounded-2xl panel-3d shadow-2xl overflow-hidden flex flex-col max-h-[85vh] z-10 border border-[var(--border-subtle)]"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-panel)]">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                  Batch Download Pattern
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Expand ranges like [01-20] or sets like &#123;1080p,720p&#125;
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
          <div className="p-5 overflow-y-auto space-y-4 flex-1">
            {/* Pattern Input */}
            <div>
              <label className="text-xs font-semibold text-[var(--text-secondary)] block mb-1.5">
                URL Pattern Expression
              </label>
              <textarea
                rows={3}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="https://cdn.example.com/episodes/ep[01-24].mp4&#10;or: https://archive.org/book_{part1,part2,part3}.zip"
                className="w-full p-2.5 rounded-xl text-xs font-mono input-3d text-[var(--text-primary)] focus:outline-none resize-none leading-relaxed"
              />
              <p className="text-[11px] text-[var(--text-muted)] mt-1">
                Supports numeric padding (e.g. <code>[001-100]</code>), alpha (e.g. <code>[a-z]</code>), and sets (e.g. <code>&#123;low,mid,high&#125;</code>). Max 1,000 items.
              </p>
            </div>

            {/* Live Preview List */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-[var(--text-secondary)] flex items-center gap-1.5">
                  <ListFilter className="w-3.5 h-3.5" />
                  Expanded Preview ({expandedUrls.length})
                </span>
                {expandedUrls.length > 200 && (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1 font-medium">
                    <AlertTriangle className="w-3 h-3" /> Large Batch Warning
                  </span>
                )}
              </div>

              {errorMsg ? (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400">
                  {errorMsg}
                </div>
              ) : isExpanding ? (
                <div className="p-6 text-center text-xs text-[var(--text-muted)] italic">
                  Expanding pattern...
                </div>
              ) : expandedUrls.length > 0 ? (
                <div className="max-h-48 overflow-y-auto p-2 rounded-xl bg-black/20 border border-[var(--border-subtle)] space-y-1 font-mono text-[11px]">
                  {expandedUrls.map((url, i) => (
                    <div
                      key={i}
                      className="px-2 py-1 rounded bg-black/30 text-[var(--text-secondary)] truncate flex items-center gap-2"
                    >
                      <span className="text-[10px] text-[var(--text-muted)] w-6 shrink-0 text-right">
                        {i + 1}.
                      </span>
                      <span className="truncate">{url}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-[var(--text-muted)] border border-dashed border-[var(--border-subtle)] rounded-xl">
                  Enter a pattern above to preview generated download links
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)] font-medium">
              {expandedUrls.length > 0 ? `${expandedUrls.length} links ready to queue` : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-8 px-3 rounded-lg text-xs font-medium btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={expandedUrls.length === 0 || isSubmitting}
                onClick={handleStartBatch}
                className={`btn-primary-3d h-8 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-all ${
                  expandedUrls.length === 0 || isSubmitting
                    ? "opacity-40 cursor-not-allowed pointer-events-none"
                    : "cursor-pointer shadow-md"
                }`}
              >
                <span>Add {expandedUrls.length} Downloads</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
