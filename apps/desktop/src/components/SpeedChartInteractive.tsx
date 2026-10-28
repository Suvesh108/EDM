import React, { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ArrowDown, ArrowUp, Clock } from "lucide-react";
import { formatSpeed } from "../utils/format";

export interface NetworkDataPoint {
  time: string;
  second: number;
  download: number; // Bytes per second
  upload: number;   // Bytes per second
}

interface SpeedChartInteractiveProps {
  speedHistory?: number[]; // Rolling speed array (bytes per sec)
  uploadHistory?: number[]; // Uplink/ACK speed array (bytes per sec)
  currentSpeed?: string;
  peakSpeedBps?: number;
  isDownloading?: boolean;
  eta?: string;
  progress?: number;
}

export const SpeedChartInteractive: React.FC<SpeedChartInteractiveProps> = ({
  speedHistory = [],
  uploadHistory = [],
  currentSpeed: _currentSpeed,
  peakSpeedBps = 0,
  isDownloading = true,
  eta,
}) => {
  // Generate dual-series data points (Download + Upload)
  const chartData: NetworkDataPoint[] = useMemo(() => {
    const totalPoints = 60;
    const dlHistory = speedHistory && speedHistory.length > 0 ? speedHistory : [0];
    const ulHistory = uploadHistory && uploadHistory.length > 0 ? uploadHistory : [];

    // Pad or trim to 60 rolling data points
    const paddedDl: number[] =
      dlHistory.length < totalPoints
        ? [...Array(totalPoints - dlHistory.length).fill(dlHistory[0] || 0), ...dlHistory]
        : dlHistory.slice(-totalPoints);

    const paddedUl: number[] =
      ulHistory.length >= dlHistory.length && ulHistory.some((v) => v > 0)
        ? (ulHistory.length < totalPoints
            ? [...Array(totalPoints - ulHistory.length).fill(0), ...ulHistory]
            : ulHistory.slice(-totalPoints))
        : Array(totalPoints).fill(0);

    return paddedDl.map((dl, idx) => {
      // Progression of time taken: 0s, 10s, 20s... 60s
      const timeLabel = idx === 0 ? "0s" : idx === totalPoints - 1 ? "60s" : `${idx}s`;
      return {
        time: timeLabel,
        second: idx,
        download: dl,
        upload: paddedUl[idx],
      };
    });
  }, [speedHistory, uploadHistory]);

  const currentDl = isDownloading
    ? (chartData.length > 0 ? chartData[chartData.length - 1].download : 0)
    : 0;
  const currentUl = isDownloading
    ? (chartData.length > 0 ? chartData[chartData.length - 1].upload : 0)
    : 0;

  const peakDl = Math.max(peakSpeedBps, ...chartData.map((d) => d.download));
  const peakUl = Math.max(...chartData.map((d) => d.upload), 0);
  const yDomainMax = Math.max(peakDl * 1.15, 1_048_576);

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-chassis)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] overflow-hidden transition-all p-2.5 sm:p-3">
      {/* ── Compact Short Chart Canvas with Vertical "MB/s" on the left ── */}
      <div className="flex items-center h-[105px] sm:h-[115px] w-full">
        {/* Vertical Text MB/s */}
        <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--text-muted)] -rotate-90 select-none shrink-0 w-6 text-center">
          MB/s
        </div>

        {/* Chart Canvas */}
        <div className="flex-1 h-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                {/* Download Gradient (EDM Accent Blue/Cyan) */}
                <linearGradient id="fillDownload" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--accent)"
                    stopOpacity={0.65}
                  />
                  <stop
                    offset="65%"
                    stopColor="var(--accent)"
                    stopOpacity={0.18}
                  />
                  <stop
                    offset="98%"
                    stopColor="var(--accent)"
                    stopOpacity={0.0}
                  />
                </linearGradient>

                {/* Upload Gradient (Indigo / Uplink Sky) */}
                <linearGradient id="fillUpload" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="#818CF8"
                    stopOpacity={0.55}
                  />
                  <stop
                    offset="65%"
                    stopColor="#818CF8"
                    stopOpacity={0.14}
                  />
                  <stop
                    offset="98%"
                    stopColor="#818CF8"
                    stopOpacity={0.0}
                  />
                </linearGradient>
              </defs>

              <CartesianGrid
                vertical={false}
                stroke="rgba(255, 255, 255, 0.06)"
                strokeDasharray="3 3"
              />

              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                minTickGap={24}
                tick={{ fill: "#71717A", fontSize: 9.5 }}
              />

              <YAxis
                tick={false}
                axisLine={false}
                domain={[0, yDomainMax]}
                width={0}
              />

              <Tooltip
                cursor={{
                  stroke: "rgba(255, 255, 255, 0.18)",
                  strokeWidth: 1,
                  strokeDasharray: "2 2",
                }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload as NetworkDataPoint;
                    return (
                      <div className="rounded-lg border border-[var(--border-subtle)] bg-[#070d19]/95 backdrop-blur-md px-2.5 py-1.5 shadow-2xl text-xs space-y-1">
                        <div className="font-mono text-[9.5px] text-[var(--text-muted)] border-b border-white/10 pb-0.5 flex justify-between gap-4">
                          <span>Elapsed: {data.second}s</span>
                          {eta && <span>Total / ETA: {eta}</span>}
                        </div>
                        <div className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                            <span className="w-2 h-2 rounded-[2px] bg-[var(--accent)]" />
                            Download:
                          </span>
                          <span className="font-mono font-semibold text-emerald-400 tabular-nums">
                            {formatSpeed(data.download)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                            <span className="w-2 h-2 rounded-[2px] bg-[#818CF8]" />
                            Upload:
                          </span>
                          <span className="font-mono font-semibold text-[#818CF8] tabular-nums">
                            {formatSpeed(data.upload)}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />

              {/* Upload Area (Layer 1) */}
              <Area
                type="natural"
                dataKey="upload"
                name="Upload"
                stroke="#818CF8"
                strokeWidth={1.8}
                fill="url(#fillUpload)"
                isAnimationActive={false}
              />

              {/* Download Area (Layer 2, on top) */}
              <Area
                type="natural"
                dataKey="download"
                name="Download"
                stroke="var(--accent)"
                strokeWidth={2.2}
                fill="url(#fillDownload)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Legend & Live Telemetry Bar with Total Time Indicator ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4 mt-1.5 pt-2 border-t border-[var(--border-subtle)] text-xs">
        <div className="flex flex-wrap items-center gap-4 sm:gap-5">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-[3px] bg-[var(--accent)] text-white shadow-sm">
              <ArrowDown className="w-2.5 h-2.5 stroke-[3]" />
            </span>
            <span className="text-[var(--text-secondary)] font-medium">Download</span>
            <span className="font-mono font-semibold text-emerald-400 tabular-nums">
              {formatSpeed(currentDl)}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] font-mono">
              ({formatSpeed(peakDl)} Peak)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-[3px] bg-[#818CF8] text-white shadow-sm">
              <ArrowUp className="w-2.5 h-2.5 stroke-[3]" />
            </span>
            <span className="text-[var(--text-secondary)] font-medium">Upload</span>
            <span className="font-mono font-semibold text-[#818CF8] tabular-nums">
              {formatSpeed(currentUl)}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] font-mono">
              ({formatSpeed(peakUl)} Peak)
            </span>
          </div>
        </div>

        {/* Total Time / Duration Telemetry */}
        <div className="flex items-center gap-1.5 text-[var(--text-secondary)] text-[11px]">
          <Clock className="w-3.5 h-3.5 text-sky-400" />
          <span>Total Time:</span>
          <span className="font-mono font-semibold text-sky-400 tabular-nums">
            {eta && eta !== "Calculating..." && eta !== "Connecting..." ? eta : "60s"}
          </span>
        </div>
      </div>
    </div>
  );
};
