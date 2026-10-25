use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccelerationMode {
    Auto,
    Optimizing,
    Stable,
    Limited,
    FallbackSingleStream,
}

impl AccelerationMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::Optimizing => "Optimizing",
            Self::Stable => "Stable",
            Self::Limited => "Limited",
            Self::FallbackSingleStream => "Single Stream",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptiveConfig {
    pub initial_connections: u32,
    pub min_connections: u32,
    pub max_connections: u32,
    pub max_connections_per_host: u32,
    pub min_chunk_size: u64, // e.g. 1 MiB or 512 KiB
    pub sample_interval: Duration,
    pub cooldown_duration: Duration,
    pub throughput_gain_threshold: f64, // e.g. +8% (0.08)
    pub throughput_drop_threshold: f64, // e.g. -5% (-0.05)
    pub stall_timeout: Duration,        // e.g. 8s
    pub max_worker_retries: u32,
}

impl Default for AdaptiveConfig {
    fn default() -> Self {
        Self {
            initial_connections: 2,
            min_connections: 1,
            max_connections: 16,
            max_connections_per_host: 8,
            min_chunk_size: 1024 * 1024, // 1 MiB
            sample_interval: Duration::from_millis(500),
            cooldown_duration: Duration::from_secs(3),
            throughput_gain_threshold: 0.08,
            throughput_drop_threshold: -0.05,
            stall_timeout: Duration::from_secs(8),
            max_worker_retries: 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Connecting,
    Downloading,
    Stalled,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerTelemetry {
    pub idx: u32,
    pub start: u64,
    pub end: u64,
    pub pos: u64,
    pub bytes_downloaded: u64,
    pub speed_bps: u64,
    pub status: WorkerStatus,
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptiveTelemetry {
    pub download_id: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub progress_pct: f64,
    pub instant_throughput_bps: u64,
    pub rolling_throughput_bps: u64,
    pub active_connections: u32,
    pub max_allowed_connections: u32,
    pub mode: AccelerationMode,
    pub eta_seconds: Option<u64>,
    pub decision_reason: String,
    pub workers: Vec<WorkerTelemetry>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdaptiveDecision {
    ScaleUp { from: u32, to: u32, reason: String },
    ScaleDown { from: u32, to: u32, reason: String },
    HoldStable { connections: u32, reason: String },
    LimitRate { retry_after: Option<Duration>, reason: String },
    FallbackSingleStream { reason: String },
}
