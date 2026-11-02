import React, { useState, useEffect } from "react";
import {
  Layers,
  Plus,
  Trash2,
  Save,
  Clock,
  Gauge,
  Power,
  Calendar,
  CheckCircle2,
  Sliders,
  ArrowLeft,
} from "lucide-react";
import { tauriGetQueues, tauriSaveQueue, tauriDeleteQueue } from "../services/tauriBridge";

export interface QueueRecord {
  id: string;
  name: string;
  max_concurrent: number;
  speed_limit_bytes_per_sec: number | null;
  schedule_start: string | null;
  schedule_stop: string | null;
  schedule_days: string | null;
  post_action: string;
}

const DEFAULT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface QueuesViewProps {
  onBack?: () => void;
  embedded?: boolean;
}

export const QueuesView: React.FC<QueuesViewProps> = ({ onBack, embedded = false }) => {
  const [queues, setQueues] = useState<QueueRecord[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState<string>("main");
  const [editingQueue, setEditingQueue] = useState<QueueRecord | null>(null);
  const [isScheduleEnabled, setIsScheduleEnabled] = useState(false);
  const [, setLoading] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchQueues = async () => {
    setLoading(true);
    try {
      const records = await tauriGetQueues();
      if (!records || records.length === 0) {
        const defaultMain: QueueRecord = {
          id: "main",
          name: "Main Queue",
          max_concurrent: 3,
          speed_limit_bytes_per_sec: null,
          schedule_start: null,
          schedule_stop: null,
          schedule_days: null,
          post_action: "none",
        };
        setQueues([defaultMain]);
        setSelectedQueueId("main");
        setEditingQueue(defaultMain);
      } else {
        setQueues(records);
        const current = records.find((q: QueueRecord) => q.id === selectedQueueId) || records[0];
        setSelectedQueueId(current.id);
        setEditingQueue(current);
        setIsScheduleEnabled(Boolean(current.schedule_start && current.schedule_stop));
      }
    } catch (err) {
      console.warn("Failed to load queues:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueues();
  }, []);

  const handleSelectQueue = (queue: QueueRecord) => {
    setSelectedQueueId(queue.id);
    setEditingQueue({ ...queue });
    setIsScheduleEnabled(Boolean(queue.schedule_start && queue.schedule_stop));
  };

  const handleCreateQueue = () => {
    const id = "queue_" + Date.now();
    const newQueue: QueueRecord = {
      id,
      name: `Queue ${queues.length + 1}`,
      max_concurrent: 3,
      speed_limit_bytes_per_sec: null,
      schedule_start: null,
      schedule_stop: null,
      schedule_days: null,
      post_action: "none",
    };
    setQueues([...queues, newQueue]);
    setSelectedQueueId(id);
    setEditingQueue(newQueue);
    setIsScheduleEnabled(false);
  };

  const handleToggleDay = (day: string) => {
    if (!editingQueue) return;
    const currentDays = (editingQueue.schedule_days || "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const exists = currentDays.includes(day);
    const updatedDays = exists
      ? currentDays.filter((d) => d !== day)
      : [...currentDays, day];
    setEditingQueue({
      ...editingQueue,
      schedule_days: updatedDays.join(","),
    });
  };

  const handleSave = async () => {
    if (!editingQueue) return;
    const finalQueue: QueueRecord = {
      ...editingQueue,
      schedule_start: isScheduleEnabled ? editingQueue.schedule_start || "00:00" : null,
      schedule_stop: isScheduleEnabled ? editingQueue.schedule_stop || "23:59" : null,
      schedule_days: isScheduleEnabled ? editingQueue.schedule_days || DEFAULT_DAYS.join(",") : null,
    };

    try {
      await tauriSaveQueue(finalQueue);
      setQueues((prev) => prev.map((q) => (q.id === finalQueue.id ? finalQueue : q)));
      setEditingQueue(finalQueue);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      alert("Failed to save queue: " + err);
    }
  };

  const handleDelete = async (queueId: string) => {
    if (queueId === "main") {
      alert("The Main Queue cannot be deleted.");
      return;
    }
    if (confirm("Delete this queue configuration?")) {
      try {
        await tauriDeleteQueue(queueId);
        const filtered = queues.filter((q) => q.id !== queueId);
        setQueues(filtered);
        if (filtered.length > 0) {
          handleSelectQueue(filtered[0]);
        }
      } catch (err) {
        alert("Failed to delete queue: " + err);
      }
    }
  };

  const activeDays = (editingQueue?.schedule_days || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  return (
    <div className={`flex flex-col ${embedded ? "w-full" : "flex-1 min-h-0 bg-[var(--bg-chassis)]"} text-[var(--text-primary)]`}>
      {/* Top Header - Shown when not embedded or when standalone */}
      {!embedded && (
        <div className="h-12 border-b border-[var(--border-subtle)] px-4 flex items-center justify-between shrink-0 bg-[var(--bg-header)]">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5 transition-colors cursor-pointer mr-1"
                title="Back to Downloads"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <Layers className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Queue Scheduler & Rules</h2>
            <span className="text-xs text-[var(--text-muted)] ml-2 hidden sm:inline">
              Automate download windows, bandwidth caps, and post-task actions
            </span>
          </div>
          <button
            onClick={handleCreateQueue}
            className="btn-3d h-7 px-3 rounded-lg text-xs font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>New Queue</span>
          </button>
        </div>
      )}

      {/* Main Content Area: Split 2-Column Chassis */}
      <div className={`flex flex-col md:flex-row ${embedded ? "min-h-[460px]" : "flex-1 min-h-0 overflow-hidden"}`}>
        {/* Left: Queue List Sidebar */}
        <div className="w-full md:w-60 border-b md:border-b-0 md:border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3.5 flex flex-col shrink-0">
          <div className="flex items-center justify-between px-1 mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
              Queues
            </span>
            <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-chassis)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
              {queues.length}
            </span>
          </div>

          <div className="space-y-1 mb-3">
            {queues.map((q) => {
              const isSelected = q.id === selectedQueueId;
              return (
                <div
                  key={q.id}
                  onClick={() => handleSelectQueue(q)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-all ${
                    isSelected
                      ? "sidebar-item-active-3d text-[var(--text-primary)] font-semibold shadow-sm"
                      : "sidebar-item-inactive-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Layers className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
                    <span className="truncate">{q.name}</span>
                  </div>
                  {q.id !== "main" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(q.id);
                      }}
                      className="p-1 rounded text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      title="Delete Queue"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* New Queue Trigger */}
          <button
            onClick={handleCreateQueue}
            className="w-full h-8 px-3 rounded-lg text-xs font-semibold btn-3d inline-flex items-center justify-center gap-1.5 cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-dashed border-[var(--border-strong)] hover:border-[var(--accent)] transition-all"
          >
            <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>New Queue</span>
          </button>
        </div>

        {/* Right: Queue Config Inspector */}
        {editingQueue ? (
          <div className={`flex-1 p-5 sm:p-6 space-y-5 max-w-3xl ${embedded ? "" : "overflow-y-auto"}`}>
            {/* 1. General Configuration Card */}
            <div className="card-3d p-5 rounded-xl space-y-4">
              <div className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-[var(--accent)]" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">
                  General Configuration
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">
                    Queue Name
                  </label>
                  <input
                    type="text"
                    value={editingQueue.name}
                    onChange={(e) => setEditingQueue({ ...editingQueue, name: e.target.value })}
                    className="w-full h-8 px-3 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-[var(--text-secondary)]">
                      Max Concurrent Downloads
                    </label>
                    <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[var(--bg-chassis)] text-[var(--accent)] border border-[var(--border-subtle)]">
                      {editingQueue.max_concurrent}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    value={editingQueue.max_concurrent}
                    onChange={(e) =>
                      setEditingQueue({ ...editingQueue, max_concurrent: parseInt(e.target.value) || 1 })
                    }
                    className="w-full accent-[var(--accent)] cursor-pointer h-1.5 bg-[var(--bg-chassis)] rounded-lg"
                  />
                </div>
              </div>

              {/* Bandwidth Limit */}
              <div>
                <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span>Speed Limit (KB/s, 0 = Unlimited)</span>
                </label>
                <div className="flex items-center gap-2 max-w-xs">
                  <input
                    type="number"
                    min={0}
                    step={256}
                    value={
                      editingQueue.speed_limit_bytes_per_sec
                        ? Math.round(editingQueue.speed_limit_bytes_per_sec / 1024)
                        : 0
                    }
                    onChange={(e) => {
                      const kb = parseInt(e.target.value) || 0;
                      setEditingQueue({
                        ...editingQueue,
                        speed_limit_bytes_per_sec: kb > 0 ? kb * 1024 : null,
                      });
                    }}
                    placeholder="0 = Unlimited"
                    className="w-full h-8 px-3 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] font-mono transition-colors"
                  />
                  <span className="text-xs font-mono text-[var(--text-muted)] px-2.5 py-1.5 rounded-lg bg-[var(--bg-chassis)] border border-[var(--border-subtle)]">
                    KB/s
                  </span>
                </div>
              </div>
            </div>

            {/* 2. Scheduled Window Card */}
            <div className="card-3d p-5 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">
                    Time-Window Scheduling
                  </h3>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                  <input
                    type="checkbox"
                    checked={isScheduleEnabled}
                    onChange={(e) => setIsScheduleEnabled(e.target.checked)}
                    className="w-4 h-4 rounded accent-[var(--accent)] cursor-pointer"
                  />
                  <span className="text-xs font-semibold text-[var(--text-primary)]">Enable Schedule</span>
                </label>
              </div>

              {isScheduleEnabled && (
                <div className="space-y-4 pt-3 border-t border-[var(--border-subtle)]">
                  <div className="grid grid-cols-2 gap-4 max-w-sm">
                    <div>
                      <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_start || "00:00"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_start: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">
                        Stop Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_stop || "23:59"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_stop: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs bg-[var(--bg-chassis)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      <span>Active Days</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {DEFAULT_DAYS.map((day) => {
                        const active = activeDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => handleToggleDay(day)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                              active
                                ? "bg-[var(--accent)] text-[var(--accent-on)] border border-[var(--accent)] font-semibold shadow-sm"
                                : "bg-[var(--bg-chassis)] text-[var(--text-muted)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                            }`}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 3. When Done Actions Card */}
            <div className="card-3d p-5 rounded-xl space-y-3.5">
              <div className="flex items-center gap-2">
                <Power className="w-3.5 h-3.5 text-[var(--accent)]" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">
                  &quot;When Done&quot; Post Actions
                </h3>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                Action executed when all downloads in this queue finish. System power actions trigger a
                60-second cancelable countdown overlay before execution.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
                {[
                  { id: "none", label: "Do Nothing" },
                  { id: "open_folder", label: "Open Downloads Folder" },
                  { id: "sleep", label: "Sleep PC" },
                  { id: "hibernate", label: "Hibernate PC" },
                  { id: "shutdown", label: "Shutdown PC" },
                ].map((act) => {
                  const isChecked = editingQueue.post_action === act.id;
                  return (
                    <label
                      key={act.id}
                      onClick={() => setEditingQueue({ ...editingQueue, post_action: act.id })}
                      className={`p-2.5 rounded-xl border text-xs font-medium flex items-center gap-2.5 cursor-pointer transition-all select-none ${
                        isChecked
                          ? "bg-[var(--bg-active)] border-[var(--accent)] text-[var(--text-primary)] font-semibold shadow-sm ring-1 ring-[var(--accent-glow)]"
                          : "bg-[var(--bg-chassis)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                          isChecked ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border-strong)] bg-transparent"
                        }`}
                      >
                        {isChecked && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-on)]" />}
                      </span>
                      <span className="truncate">{act.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Save Buttons & Feedback */}
            <div className="flex items-center justify-end gap-3 pt-2">
              {saveSuccess && (
                <span className="text-xs text-emerald-400 flex items-center gap-1.5 font-medium animate-fade-in">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Queue rules saved!
                </span>
              )}
              <button
                onClick={handleSave}
                className="btn-3d btn-primary h-8 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-all active:scale-95 shadow-sm"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Queue Configuration</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8 text-xs text-[var(--text-muted)]">
            Select or create a queue to configure
          </div>
        )}
      </div>
    </div>
  );
};
