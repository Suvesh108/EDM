import React, { useState, useEffect } from "react";
import { Search, Download, Trash2, Calendar, CheckCircle2, XCircle, ArrowLeft, FileText } from "lucide-react";
import { tauriGetHistory, tauriClearHistory, tauriExportHistoryCsv } from "../services/tauriBridge";
import { formatBytes } from "../utils/format";

export interface HistoryItem {
  id: string;
  url: string;
  filename: string;
  save_dir: string;
  category: string;
  size_total: number | null;
  size_done: number;
  state: string;
  created_at: string;
  completed_at: string;
  error_msg?: string | null;
}

interface HistoryViewProps {
  onBack?: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ onBack }) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const records = await tauriGetHistory(200, query.trim() || undefined);
      setHistory(records);
    } catch (err) {
      console.warn("Failed to fetch history:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [query]);

  const handleClear = async () => {
    if (confirm("Are you sure you want to clear your entire download history?")) {
      await tauriClearHistory();
      setHistory([]);
    }
  };

  const handleExportCsv = async () => {
    try {
      const csv = await tauriExportHistoryCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `edm_download_history_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      alert("Failed to export history CSV: " + err);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--bg-main)] p-6 overflow-hidden">
      {/* Header toolbar */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-2 rounded-xl btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              title="Back to Downloads"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-bold text-[var(--text-main)] flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[var(--primary)]" />
              Download History
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Independent log of all completed and past download events.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCsv}
            className="btn-3d px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-2 text-[var(--text-main)] bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            onClick={handleClear}
            className="btn-3d px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-2 text-red-400 bg-[var(--bg-card)] border border-red-500/20 hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear History
          </button>
        </div>
      </div>

      {/* Search Input */}
      <div className="mb-4 relative">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-[var(--text-muted)]" />
        <input
          type="text"
          placeholder="Search history by filename or link..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-all"
        />
      </div>

      {/* History Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center justify-center p-12 text-xs text-[var(--text-muted)]">
            Loading history records...
          </div>
        ) : history.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 text-center">
            <FileText className="w-12 h-12 text-[var(--text-muted)] opacity-30 mb-3" />
            <div className="text-sm font-semibold text-[var(--text-main)]">No History Records Found</div>
            <div className="text-xs text-[var(--text-muted)] max-w-sm mt-1">
              Completed and archived downloads will automatically be indexed here.
            </div>
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-[var(--bg-main)] text-[var(--text-muted)] font-semibold border-b border-[var(--border-subtle)] sticky top-0">
              <tr>
                <th className="py-3 px-4">Filename</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Size</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Finished At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {history.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--bg-hover)] transition-colors">
                  <td className="py-3 px-4 font-medium text-[var(--text-main)] max-w-md truncate" title={item.filename}>
                    {item.filename}
                  </td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">{item.category}</td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">
                    {formatBytes(item.size_done || item.size_total || 0)}
                  </td>
                  <td className="py-3 px-4">
                    {item.state === "completed" ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Completed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-red-400 font-medium">
                        <XCircle className="w-3.5 h-3.5" /> Failed
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">
                    {new Date(item.completed_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
