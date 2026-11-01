import React, { useState, useEffect } from "react";
import { Power, XCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { backdropVariants, modalVariants } from "../utils/motion";
import {
  tauriGetPowerCountdownStatus,
  tauriCancelPowerCountdown,
} from "../services/tauriBridge";

export const PowerCountdownModal: React.FC = () => {
  const [active, setActive] = useState(false);
  const [action, setAction] = useState("shutdown");
  const [secondsRemaining, setSecondsRemaining] = useState(60);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await tauriGetPowerCountdownStatus();
        setActive(status.active);
        setAction(status.action);
        setSecondsRemaining(status.seconds_remaining);
      } catch (e) {
        // Dev mode or not in tauri
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleCancel = async () => {
    try {
      await tauriCancelPowerCountdown();
      setActive(false);
    } catch (err) {
      console.warn("Failed to cancel power countdown:", err);
    }
  };

  if (!active) return null;

  const actionName =
    action === "shutdown"
      ? "Shutting Down"
      : action === "sleep"
      ? "Entering Sleep"
      : action === "hibernate"
      ? "Hibernating"
      : "Power Action";

  const pct = Math.max(0, Math.min(100, (secondsRemaining / 60) * 100));

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Urgent red/dark backdrop */}
        <motion.div
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed inset-0 bg-black/75 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          variants={modalVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="relative w-full max-w-md rounded-2xl panel-3d shadow-2xl p-6 z-10 border border-amber-500/40 text-center flex flex-col items-center gap-4"
        >
          <div className="w-16 h-16 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center animate-pulse">
            <Power className="w-8 h-8" />
          </div>

          <div>
            <h3 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
              {actionName} System
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              All downloads completed. Computer will {action} in:
            </p>
          </div>

          {/* Countdown Display */}
          <div className="text-4xl font-extrabold font-mono text-amber-400">
            {secondsRemaining}s
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-black/40 h-2 rounded-full overflow-hidden border border-[var(--border-subtle)]">
            <div
              className="bg-amber-400 h-full transition-all duration-1000 ease-linear"
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* Cancel Button */}
          <button
            onClick={handleCancel}
            className="w-full mt-2 h-10 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer shadow-lg transition-transform active:scale-95"
          >
            <XCircle className="w-4 h-4" />
            <span>Cancel {actionName}</span>
          </button>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
