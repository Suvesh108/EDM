//! Common Feature Pack Trait Specification
//! Enables EDM to manage, probe, start, pause, resume, cancel, and report progress
//! uniformly across all native and transitional feature packs.

use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::adaptive::{AdaptiveConfig, AdaptiveTelemetry, TelemetryCallback};
use crate::limiter::TokenBucketLimiter;
use uuid::Uuid;

/// Unified download task representation passed to feature packs
#[derive(Clone)]
pub struct PackTask {
    pub id: Uuid,
    pub url: String,
    pub filename: String,
    pub save_dir: PathBuf,
    pub config: AdaptiveConfig,
    pub limiter: Option<TokenBucketLimiter>,
    pub cancelled: Arc<AtomicBool>,
    pub cookies: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
}

/// Unified probe metadata returned before download begins
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackProbeResult {
    pub url: String,
    pub filename: String,
    pub total_size: Option<u64>,
    pub resumable: bool,
    pub mime_type: Option<String>,
    pub pack_name: &'static str,
}

/// Common trait for all EDM protocol and feature packs
#[async_trait]
pub trait FeaturePack: Send + Sync {
    /// Identifier name of the pack
    fn name(&self) -> &'static str;

    /// Probe the URL/target to inspect headers, format information, or metadata
    async fn probe(&self, task: &PackTask) -> Result<PackProbeResult, String>;

    /// Start or execute the download task to completion, emitting real-time telemetry
    async fn start(
        &self,
        task: PackTask,
        telemetry_cb: Option<TelemetryCallback>,
    ) -> Result<PathBuf, String>;

    /// Pause the task (graceful checkpointing)
    async fn pause(&self, task_id: &Uuid) -> Result<(), String> {
        let _ = task_id;
        Ok(())
    }

    /// Resume the task from SQLite / file checkpoint
    async fn resume(
        &self,
        task: PackTask,
        telemetry_cb: Option<TelemetryCallback>,
    ) -> Result<PathBuf, String> {
        self.start(task, telemetry_cb).await
    }

    /// Cancel the download task and abort connections / processes
    async fn cancel(&self, task_id: &Uuid) -> Result<(), String> {
        let _ = task_id;
        Ok(())
    }

    /// Fetch latest telemetry snapshot for this task
    async fn progress(&self, task_id: &Uuid) -> Option<AdaptiveTelemetry> {
        let _ = task_id;
        None
    }
}
