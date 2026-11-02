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
}

export const QueuesView: React.FC<QueuesViewProps> = ({ onBack }) => {
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
        // Fallback default main queue
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
      setTimeout(() => setSaveSuccess(false), 2000);
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
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-chassis)] text-[var(--text-primary)]">
      {/* Top Header */}
      <div className="h-12 border-b border-[var(--border-subtle)] px-4 flex items-center justify-between shrink-0 bg-[var(--bg-panel)]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1.5 rounded-lg btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer mr-1"
              title="Back to Downloads"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Layers className="w-4 h-4 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold tracking-tight">Queue Scheduler & Rules</h2>
          <span className="text-xs text-[var(--text-muted)] ml-2">
            Automate download windows, bandwidth caps, and post-task actions
          </span>
        </div>
        <button
          onClick={handleCreateQueue}
          className="btn-primary-3d h-7 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Queue</span>
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: Queue List */}
        <div className="w-64 border-r border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3 flex flex-col gap-2 shrink-0 overflow-y-auto">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
            Queues ({queues.length})
          </span>
          <div className="space-y-1">
            {queues.map((q) => {
              const isSelected = q.id === selectedQueueId;
              return (
                <div
                  key={q.id}
                  onClick={() => handleSelectQueue(q)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-all ${
                    isSelected
                      ? "bg-[var(--accent)] text-white font-medium shadow-md"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Layers className={`w-3.5 h-3.5 ${isSelected ? "text-white" : "text-[var(--text-muted)]"}`} />
                    <span className="truncate">{q.name}</span>
                  </div>
                  {q.id !== "main" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(q.id);
                      }}
                      className="p-1 rounded hover:bg-black/20 text-[var(--text-muted)] hover:text-rose-400 transition-colors"
                      title="Delete Queue"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Queue Config Inspector */}
        {editingQueue ? (
          <div className="flex-1 p-6 overflow-y-auto space-y-6 max-w-3xl">
            {/* Queue Name & Concurrency */}
            <div className="panel-3d p-4 rounded-xl space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--accent)] flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5" /> General Configuration
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">
                    Queue Name
                  </label>
                  <input
                    type="text"
                    value={editingQueue.name}
                    onChange={(e) => setEditingQueue({ ...editingQueue, name: e.target.value })}
                    className="w-full h-8 px-2.5 rounded-lg text-xs input-3d text-[var(--text-primary)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">
                    Max Concurrent Downloads
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={1}
                      max={8}
                      value={editingQueue.max_concurrent}
                      onChange={(e) =>
                        setEditingQueue({ ...editingQueue, max_concurrent: parseInt(e.target.value) || 1 })
                      }
                      className="flex-1 accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-xs font-bold w-6 text-center">{editingQueue.max_concurrent}</span>
                  </div>
                </div>
              </div>

              {/* Bandwidth Limit */}
              <div>
                <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-[var(--text-muted)]" /> Speed Limit (KB/s, 0 = Unlimited)
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
                    className="w-full h-8 px-2.5 rounded-lg text-xs input-3d text-[var(--text-primary)] focus:outline-none"
                  />
                  <span className="text-xs text-[var(--text-muted)]">KB/s</span>
                </div>
              </div>
            </div>

            {/* Scheduled Window */}
            <div className="panel-3d p-4 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--accent)] flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5" /> Time-Window Scheduling
                </h3>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={isScheduleEnabled}
                    onChange={(e) => setIsScheduleEnabled(e.target.checked)}
                    className="rounded accent-[var(--accent)]"
                  />
                  <span>Enable Schedule</span>
                </label>
              </div>

              {isScheduleEnabled && (
                <div className="space-y-4 pt-2 border-t border-[var(--border-subtle)]">
                  <div className="grid grid-cols-2 gap-4 max-w-sm">
                    <div>
                      <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_start || "00:00"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_start: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs input-3d text-[var(--text-primary)]"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">
                        Stop Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_stop || "23:59"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_stop: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs input-3d text-[var(--text-primary)]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" /> Active Days
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {DEFAULT_DAYS.map((day) => {
                        const active = activeDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => handleToggleDay(day)}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                              active
                                ? "bg-[var(--accent)] text-white shadow-sm"
                                : "btn-3d text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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

            {/* When Done Actions */}
            <div className="panel-3d p-4 rounded-xl space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--accent)] flex items-center gap-2">
                <Power className="w-3.5 h-3.5" /> "When Done" Post Actions
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                Action executed when all downloads in this queue finish. System power actions trigger a
                60-second cancelable countdown overlay before execution.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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
                      className={`p-2.5 rounded-xl border text-xs font-medium flex items-center gap-2 cursor-pointer transition-all ${
                        isChecked
                          ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] font-semibold"
                          : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      }`}
                    >
                      <input
                        type="radio"
                        name="post_action"
                        checked={isChecked}
                        onChange={() => {}}
                        className="accent-[var(--accent)]"
                      />
                      <span>{act.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Save Buttons */}
            <div className="flex items-center justify-end gap-3 pt-2">
              {saveSuccess && (
                <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Queue rules saved!
                </span>
              )}
              <button
                onClick={handleSave}
                className="btn-primary-3d h-8 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer shadow-md"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Queue Configuration</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-muted)]">
            Select or create a queue to configure
          </div>
        )}
      </div>
    </div>
  );
};
