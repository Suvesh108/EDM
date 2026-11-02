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
    <div className="flex-1 flex flex-col min-h-0 bg-[#090A0D] text-[#E4E6EA]">
      {/* Top Header - Shown when not embedded or when standalone */}
      {!embedded && (
        <div className="h-12 border-b border-white/10 px-4 flex items-center justify-between shrink-0 bg-[#0D0E12]">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="p-1.5 rounded-lg text-[#8E939E] hover:text-white hover:bg-white/5 transition-colors cursor-pointer mr-1"
                title="Back to Downloads"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <Layers className="w-4 h-4 text-[#A0A5B0]" />
            <h2 className="text-sm font-semibold tracking-tight text-[#FFFFFF]">Queue Scheduler & Rules</h2>
            <span className="text-xs text-[#7C818A] ml-2 hidden sm:inline">
              Automate download windows, bandwidth caps, and post-task actions
            </span>
          </div>
          <button
            onClick={handleCreateQueue}
            className="h-7 px-3 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white border border-white/10 inline-flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Queue</span>
          </button>
        </div>
      )}

      {/* Main Content Area: Split 2-Column Chassis */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: Queue List Sidebar */}
        <div className="w-56 border-r border-white/10 bg-[#0D0E12] p-3 flex flex-col gap-2 shrink-0 overflow-y-auto">
          <div className="flex items-center justify-between px-1 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#7C818A]">
              Queues
            </span>
            <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-white/5 text-[#8E939E] border border-white/5">
              {queues.length}
            </span>
          </div>

          <div className="space-y-1">
            {queues.map((q) => {
              const isSelected = q.id === selectedQueueId;
              return (
                <div
                  key={q.id}
                  onClick={() => handleSelectQueue(q)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-all ${
                    isSelected
                      ? "bg-white/[0.08] text-[#FFFFFF] font-semibold border border-white/15 shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)]"
                      : "text-[#8E939E] hover:text-[#FFFFFF] hover:bg-white/[0.03] border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Layers className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-white" : "text-[#7C818A]"}`} />
                    <span className="truncate">{q.name}</span>
                  </div>
                  {q.id !== "main" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(q.id);
                      }}
                      className="p-1 rounded text-[#7C818A] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      title="Delete Queue"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* New Queue Trigger for Embedded View */}
          {embedded && (
            <button
              onClick={handleCreateQueue}
              className="mt-auto h-8 px-3 rounded-lg text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[#B8BCC4] hover:text-white border border-white/10 inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Queue</span>
            </button>
          )}
        </div>

        {/* Right: Queue Config Inspector */}
        {editingQueue ? (
          <div className="flex-1 p-5 sm:p-6 overflow-y-auto space-y-5 max-w-3xl">
            {/* 1. General Configuration Card */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-4 shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
              <div className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-[#A0A5B0]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E4E6EA]">
                  General Configuration
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-[#8E939E] block mb-1.5">
                    Queue Name
                  </label>
                  <input
                    type="text"
                    value={editingQueue.name}
                    onChange={(e) => setEditingQueue({ ...editingQueue, name: e.target.value })}
                    className="w-full h-8 px-3 rounded-lg text-xs bg-black/40 border border-white/10 text-[#FFFFFF] focus:outline-none focus:border-white/30 transition-colors"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-[#8E939E]">
                      Max Concurrent Downloads
                    </label>
                    <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-white/10 text-white border border-white/10">
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
                    className="w-full accent-white cursor-pointer h-1.5 bg-white/10 rounded-lg"
                  />
                </div>
              </div>

              {/* Bandwidth Limit */}
              <div>
                <label className="text-xs font-medium text-[#8E939E] block mb-1.5 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-[#7C818A]" />
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
                    className="w-full h-8 px-3 rounded-lg text-xs bg-black/40 border border-white/10 text-[#FFFFFF] focus:outline-none focus:border-white/30 font-mono transition-colors"
                  />
                  <span className="text-xs font-mono text-[#7C818A] px-2 py-1 rounded bg-white/[0.04] border border-white/5">
                    KB/s
                  </span>
                </div>
              </div>
            </div>

            {/* 2. Scheduled Window Card */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-4 shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-[#A0A5B0]" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E4E6EA]">
                    Time-Window Scheduling
                  </h3>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                  <input
                    type="checkbox"
                    checked={isScheduleEnabled}
                    onChange={(e) => setIsScheduleEnabled(e.target.checked)}
                    className="w-4 h-4 rounded accent-white cursor-pointer"
                  />
                  <span className="text-xs font-medium text-[#B8BCC4]">Enable Schedule</span>
                </label>
              </div>

              {isScheduleEnabled && (
                <div className="space-y-4 pt-3 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-4 max-w-sm">
                    <div>
                      <label className="text-xs font-medium text-[#8E939E] block mb-1.5">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_start || "00:00"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_start: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs bg-black/40 border border-white/10 text-white font-mono focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[#8E939E] block mb-1.5">
                        Stop Time
                      </label>
                      <input
                        type="time"
                        value={editingQueue.schedule_stop || "23:59"}
                        onChange={(e) =>
                          setEditingQueue({ ...editingQueue, schedule_stop: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg text-xs bg-black/40 border border-white/10 text-white font-mono focus:outline-none focus:border-white/30"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[#8E939E] block mb-1.5 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-[#7C818A]" />
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
                                ? "bg-white/15 text-white border border-white/20 shadow-sm font-semibold"
                                : "bg-white/[0.03] text-[#7C818A] border border-white/5 hover:text-white hover:bg-white/[0.06]"
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
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
              <div className="flex items-center gap-2">
                <Power className="w-3.5 h-3.5 text-[#A0A5B0]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E4E6EA]">
                  &quot;When Done&quot; Post Actions
                </h3>
              </div>
              <p className="text-[11px] text-[#7C818A] leading-relaxed">
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
                      className={`p-2.5 rounded-xl border text-xs font-medium flex items-center gap-2.5 cursor-pointer transition-all select-none ${
                        isChecked
                          ? "border-white/30 bg-white/[0.08] text-white shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)] font-semibold"
                          : "border-white/5 bg-black/20 text-[#8E939E] hover:border-white/15 hover:text-[#E4E6EA]"
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                          isChecked ? "border-white bg-white" : "border-white/20 bg-transparent"
                        }`}
                      >
                        {isChecked && <span className="w-1.5 h-1.5 rounded-full bg-black" />}
                      </span>
                      <span>{act.label}</span>
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
                className="h-8 px-4 rounded-lg text-xs font-semibold bg-gradient-to-b from-[#FFFFFF] to-[#D8DBE0] text-[#0A0B0E] hover:from-[#FFFFFF] hover:to-[#EBEEF3] shadow-[0_2px_8px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.9)] inline-flex items-center gap-1.5 cursor-pointer transition-all active:scale-95"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Queue Configuration</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-[#7C818A]">
            Select or create a queue to configure
          </div>
        )}
      </div>
    </div>
  );
};
