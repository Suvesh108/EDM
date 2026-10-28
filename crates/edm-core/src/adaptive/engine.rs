use chrono::Utc;
use edm_ipc::DownloadState;
use edm_store::{DownloadRecord, SegmentRecord, Store};
use reqwest::Client;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use super::controller::AdaptiveController;
use super::scheduler::WorkScheduler;
use super::types::{AdaptiveConfig, AdaptiveDecision, AdaptiveTelemetry};
use super::worker::AdaptiveWorkerEvent;
use crate::limiter::TokenBucketLimiter;
use crate::planner::Planner;
use crate::probe::Probe;
use crate::writer::FileWriter;

pub type TelemetryCallback = Arc<dyn Fn(AdaptiveTelemetry) + Send + Sync>;

pub struct AdaptiveDownloadTask {
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

pub struct AdaptiveEngine {
    client: Client,
    store: Store,
}

impl AdaptiveEngine {
    pub fn new(store: Store) -> Self {
        let client = Client::builder()
            .http1_only()
            .pool_max_idle_per_host(64)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .redirect(reqwest::redirect::Policy::limited(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client, store }
    }

    pub async fn download(
        &self,
        task: AdaptiveDownloadTask,
        telemetry_callback: Option<TelemetryCallback>,
    ) -> Result<PathBuf, String> {
        info!("AdaptiveEngine: Probing {}", task.url);
        let probe = Probe::probe_url_with_headers(
            &self.client,
            &task.url,
            task.cookies.as_deref(),
            task.referer.as_deref(),
            task.user_agent.as_deref(),
        )
        .await
        .map_err(|e| format!("Probe failed: {}", e))?;

        let total_size = probe.size_total;
        let is_resumable = probe.resumable && total_size.is_some() && total_size.unwrap() > 0;

        info!(
            "Task {}: Probed URL '{}' -> Final URL: '{}' | Status: {} | Range Support: {} | Total Size: {:?} | Content-Type: {:?} | Headers: {:?}",
            task.id,
            task.url,
            probe.final_url,
            probe.status_code,
            if probe.resumable { "bytes" } else { "none" },
            total_size,
            probe.content_type,
            probe.response_headers
        );

        // Prefer explicit non-generic filename from extension/task, otherwise probe filename, then fallback
        let is_task_name_valid = !task.filename.trim().is_empty()
            && task.filename != "download"
            && task.filename != "download.bin";

        let candidate_filename = if is_task_name_valid {
            task.filename.clone()
        } else if let Some(ref pf) = probe.filename {
            pf.clone()
        } else {
            task.filename.clone()
        };

        let sanitized = crate::sanitizer::Sanitizer::sanitize_filename(&candidate_filename);
        let resolved_path =
            crate::sanitizer::Sanitizer::resolve_duplicate(&task.save_dir, &sanitized);
        let filename = resolved_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(sanitized);

        // 1. Prepare disk writer with NTFS sparse allocation
        let writer = FileWriter::new(&task.save_dir, &filename, total_size)
            .map_err(|e| format!("Writer init failed: {}", e))?;

        // 2. Persist download in SQLite store
        let record = DownloadRecord {
            id: task.id,
            url: task.url.clone(),
            final_url: Some(probe.final_url.clone()),
            filename: filename.clone(),
            save_dir: task.save_dir.to_string_lossy().to_string(),
            category: "General".into(),
            state: DownloadState::Downloading,
            size_total: total_size,
            size_done: 0,
            resumable: is_resumable,
            etag: probe.etag.clone(),
            last_modified: probe.last_modified.clone(),
            content_type: probe.content_type.clone(),
            referer: task.referer.clone(),
            user_agent: task.user_agent.clone(),
            connections: if is_resumable {
                task.config.initial_connections
            } else {
                1
            },
            created_at: Utc::now(),
        };
        let _ = self.store.insert_download(&record);

        // 3. Initialize Adaptive Controller & Work Scheduler
        let mut controller = AdaptiveController::new(task.config.clone(), is_resumable);
        let mut scheduler = WorkScheduler::new(
            task.config.min_chunk_size,
            task.config.stall_timeout,
            task.config.max_worker_retries,
        );

        let (event_tx, mut event_rx) = mpsc::channel::<AdaptiveWorkerEvent>(256);

        // 4. Check cancellation and spawn initial workers
        if task.cancelled.load(Ordering::Relaxed) {
            let _ = self
                .store
                .update_download_state(task.id, DownloadState::Paused, None);
            return Err("Download cancelled by user".into());
        }

        if let Some(size) = total_size {
            let initial_conns = if is_resumable {
                task.config
                    .initial_connections
                    .min(task.config.max_connections)
                    .max(1)
            } else {
                1
            };

            let plans = Planner::plan(size, initial_conns, task.config.min_chunk_size);
            for plan in plans {
                scheduler.spawn_worker(
                    probe.final_url.clone(),
                    plan.start,
                    plan.end,
                    probe.etag.clone(),
                    task.cookies.clone(),
                    task.referer.clone(),
                    task.user_agent.clone(),
                    self.client.clone(),
                    writer.clone(),
                    task.limiter.clone(),
                    event_tx.clone(),
                );
            }
        } else {
            // Unknown file size: fallback to unbounded single-stream
            scheduler.spawn_worker(
                probe.final_url.clone(),
                0,
                u64::MAX - 1,
                probe.etag.clone(),
                task.cookies.clone(),
                task.referer.clone(),
                task.user_agent.clone(),
                self.client.clone(),
                writer.clone(),
                task.limiter.clone(),
                event_tx.clone(),
            );
        }

        // 5. Orchestration loop: event handling, metrics sampling, and adaptive optimization
        let mut total_downloaded: u64 = 0;
        let mut last_sample_time = Instant::now();
        let mut sample_bytes: u64 = 0;
        let mut last_checkpoint = Instant::now();
        let mut sample_ticker = tokio::time::interval(task.config.sample_interval);

        loop {
            if task.cancelled.load(Ordering::Relaxed) {
                info!("Download task {} received cancellation signal", task.id);
                scheduler.cancel_all();
                let _ = writer.flush();
                let _ = self
                    .store
                    .update_download_progress(task.id, total_downloaded);
                let _ = self
                    .store
                    .update_download_state(task.id, DownloadState::Paused, None);
                return Err("Download cancelled by user".into());
            }

            tokio::select! {
                // Periodic cancellation check timer
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}

                // Handle worker events
                maybe_event = event_rx.recv() => {
                    match maybe_event {
                        Some(AdaptiveWorkerEvent::Progress { bytes_read, .. }) => {
                            total_downloaded += bytes_read;
                            sample_bytes += bytes_read;

                            // Checkpoint to SQLite every 2 seconds without blocking worker I/O on fsync
                            if last_checkpoint.elapsed() >= Duration::from_secs(2) {
                                let seg_records: Vec<SegmentRecord> = scheduler
                                    .workers
                                    .iter()
                                    .map(|w| SegmentRecord {
                                        download_id: task.id,
                                        idx: w.idx,
                                        start: w.start,
                                        end: w.end.load(Ordering::Relaxed),
                                        pos: w.pos.load(Ordering::Relaxed),
                                        state: format!("{:?}", w.get_status()).to_lowercase(),
                                        retries: w.retry_count.load(Ordering::Relaxed),
                                    })
                                    .collect();
                                let _ = self.store.save_segment_positions(&seg_records);
                                let _ = self.store.update_download_progress(task.id, total_downloaded);
                                let _ = self.store.update_download_state(task.id, DownloadState::Downloading, None);
                                last_checkpoint = Instant::now();
                            }
                        }
                        Some(AdaptiveWorkerEvent::RateLimited { idx, retry_after }) => {
                            warn!("Worker {} reported rate limiting from host", idx);
                            controller.evaluate_sample(
                                sample_bytes,
                                last_sample_time.elapsed(),
                                0,
                                true,
                                retry_after,
                            );
                        }
                        Some(AdaptiveWorkerEvent::Stalled { idx }) => {
                            warn!("Worker {} reported stall", idx);
                        }
                        Some(AdaptiveWorkerEvent::Done { idx }) => {
                            info!("Worker {} completed assigned byte range", idx);
                            // Dynamic work stealing on completion to keep all connections busy
                            if is_resumable {
                                scheduler.try_steal_work(
                                    self.client.clone(),
                                    writer.clone(),
                                    task.limiter.clone(),
                                    event_tx.clone(),
                                );
                            }

                            // Check if entire file has finished
                            let active = scheduler.active_count();
                            let is_finished = if let Some(tot) = total_size {
                                total_downloaded >= tot || active == 0
                            } else {
                                active == 0
                            };

                            if is_finished {
                                info!("All bytes received for download {}", task.id);
                                break;
                            }
                        }
                        Some(AdaptiveWorkerEvent::Failed { idx, reason }) => {
                            error!("Worker {} failed: {}", idx, reason);
                            if scheduler.active_count() == 0 {
                                let _ = self.store.update_download_progress(task.id, total_downloaded);
                                let _ = self.store.update_download_state(task.id, DownloadState::Failed, Some(&reason));
                                return Err(format!("All workers failed: {}", reason));
                            }
                        }
                        None => {
                            // Event channel closed
                            break;
                        }
                    }
                }

                // Sample ticker: evaluate throughput, make scaling decisions, emit telemetry
                _ = sample_ticker.tick() => {
                    let sample_duration = last_sample_time.elapsed();
                    let error_count = scheduler.active_error_count();

                    // Evaluate sample with AdaptiveController
                    let decision = controller.evaluate_sample(
                        sample_bytes,
                        sample_duration,
                        error_count,
                        false,
                        None,
                    );

                    // Execute decision
                    if let AdaptiveDecision::ScaleUp { to, .. } = decision {
                        if scheduler.active_count() < to && is_resumable {
                            scheduler.try_steal_work(
                                self.client.clone(),
                                writer.clone(),
                                task.limiter.clone(),
                                event_tx.clone(),
                            );
                        }
                    }

                    // Stall detection check
                    scheduler.check_stalled_workers(
                        &self.client,
                        &writer,
                        task.limiter.clone(),
                        &event_tx,
                    );

                    // Emit Telemetry
                    if let Some(ref cb) = telemetry_callback {
                        let instant_rate = if sample_duration.as_secs_f64() > 0.0 {
                            (sample_bytes as f64 / sample_duration.as_secs_f64()) as u64
                        } else {
                            0
                        };

                        let progress = if let Some(tot) = total_size {
                            if tot > 0 { (total_downloaded as f64 / tot as f64) * 100.0 } else { 0.0 }
                        } else {
                            0.0
                        };

                        let effective_rate_bytes = (controller.rolling_throughput_bps() / 8).max(instant_rate);
                        let eta = if let Some(tot) = total_size {
                            let rem = tot.saturating_sub(total_downloaded);
                            if effective_rate_bytes > 0 {
                                rem.checked_div(effective_rate_bytes)
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        let telemetry = AdaptiveTelemetry {
                            download_id: task.id.to_string(),
                            total_bytes: total_size,
                            downloaded_bytes: total_downloaded,
                            progress_pct: progress,
                            instant_throughput_bps: instant_rate * 8,
                            rolling_throughput_bps: if controller.rolling_throughput_bps() > 0 {
                                controller.rolling_throughput_bps()
                            } else {
                                instant_rate * 8
                            },
                            active_connections: scheduler.active_count(),
                            max_allowed_connections: task.config.max_connections,
                            mode: controller.mode(),
                            eta_seconds: eta,
                            decision_reason: controller.status_reason().to_string(),
                            workers: scheduler.get_telemetry_snapshot(),
                            updated_at: Utc::now(),
                        };

                        cb(telemetry);
                    }

                    // Reset sample counters
                    sample_bytes = 0;
                    last_sample_time = Instant::now();
                }
            }
        }

        // 6. Finalize file and update persistence
        let final_path = writer
            .finalize(Some(&task.url))
            .map_err(|e| format!("Failed to finalize file: {}", e))?;

        let _ = self
            .store
            .update_download_progress(task.id, total_downloaded);
        let _ = self
            .store
            .update_download_state(task.id, DownloadState::Completed, None);

        info!(
            "Download completed successfully: {:?} ({} bytes)",
            final_path, total_downloaded
        );
        Ok(final_path)
    }
}
