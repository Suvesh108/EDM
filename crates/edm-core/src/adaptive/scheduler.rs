use reqwest::Client;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::info;

use super::types::{WorkerStatus, WorkerTelemetry};
use super::worker::{AdaptiveWorker, AdaptiveWorkerEvent};
use crate::limiter::TokenBucketLimiter;
use crate::writer::FileWriter;

pub struct WorkScheduler {
    pub workers: Vec<Arc<AdaptiveWorker>>,
    next_idx: u32,
    min_chunk_size: u64,
    stall_timeout: Duration,
    max_retries: u32,
}

impl WorkScheduler {
    pub fn new(min_chunk_size: u64, stall_timeout: Duration, max_retries: u32) -> Self {
        Self {
            workers: Vec::new(),
            next_idx: 0,
            min_chunk_size,
            stall_timeout,
            max_retries,
        }
    }

    /// Spawns an initial worker for a byte range
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_worker(
        &mut self,
        url: String,
        start: u64,
        end: u64,
        etag: Option<String>,
        cookies: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
        client: Client,
        writer: FileWriter,
        limiter: Option<TokenBucketLimiter>,
        event_tx: mpsc::Sender<AdaptiveWorkerEvent>,
    ) -> Arc<AdaptiveWorker> {
        let idx = self.next_idx;
        self.next_idx += 1;

        let worker = Arc::new(AdaptiveWorker::new(
            idx, url, start, end, start, etag, cookies, referer, user_agent,
        ));
        self.workers.push(worker.clone());

        let w_clone = worker.clone();
        let stall = self.stall_timeout;
        let retries = self.max_retries;

        tokio::spawn(async move {
            w_clone
                .run(client, writer, limiter, event_tx, stall, retries)
                .await;
        });

        worker
    }

    /// Attempts dynamic work stealing: finds worker with largest remaining byte range,
    /// splits it in half, and spawns a new worker to download the second half.
    pub fn try_steal_work(
        &mut self,
        client: Client,
        writer: FileWriter,
        limiter: Option<TokenBucketLimiter>,
        event_tx: mpsc::Sender<AdaptiveWorkerEvent>,
    ) -> Option<Arc<AdaptiveWorker>> {
        // Find active worker with largest remaining bytes >= 2 * min_chunk_size
        let mut best_candidate: Option<(usize, u64)> = None;

        for (i, w) in self.workers.iter().enumerate() {
            if w.get_status() == WorkerStatus::Completed || w.get_status() == WorkerStatus::Failed {
                continue;
            }
            let rem = w.remaining_bytes();
            if rem >= 2 * self.min_chunk_size {
                match best_candidate {
                    None => best_candidate = Some((i, rem)),
                    Some((_, best_rem)) if rem > best_rem => best_candidate = Some((i, rem)),
                    _ => {}
                }
            }
        }

        let (target_idx, remaining) = best_candidate?;
        let target = &self.workers[target_idx];

        let cur_pos = target.pos.load(Ordering::Relaxed);
        let cur_end = target.end.load(Ordering::Relaxed);

        if cur_end < cur_pos || (cur_end - cur_pos + 1) < 2 * self.min_chunk_size {
            return None;
        }

        let half = remaining / 2;
        let new_target_end = cur_pos + half - 1;
        let new_worker_start = new_target_end + 1;
        let new_worker_end = cur_end;

        // Atomically contract target worker's end boundary
        target.end.store(new_target_end, Ordering::SeqCst);

        info!(
            "Dynamic Work Steal: Worker {} boundary shrunk to {}-{}. Spawning Worker {} for {}-{} ({} KiB stolen)",
            target.idx,
            cur_pos,
            new_target_end,
            self.next_idx,
            new_worker_start,
            new_worker_end,
            (new_worker_end - new_worker_start + 1) / 1024
        );

        let new_worker = self.spawn_worker(
            target.url.clone(),
            new_worker_start,
            new_worker_end,
            target.etag.clone(),
            target.cookies.clone(),
            target.referer.clone(),
            target.user_agent.clone(),
            client,
            writer,
            limiter,
            event_tx,
        );

        Some(new_worker)
    }

    /// Checks for stalled workers and triggers connection renewal if needed
    pub fn check_stalled_workers(
        &self,
        client: &Client,
        writer: &FileWriter,
        limiter: Option<TokenBucketLimiter>,
        event_tx: &mpsc::Sender<AdaptiveWorkerEvent>,
    ) {
        for w in &self.workers {
            if w.is_stalled(self.stall_timeout.as_secs()) {
                info!(
                    "Stall detected on Worker {} at pos {}. Initiating reconnect.",
                    w.idx,
                    w.pos.load(Ordering::Relaxed)
                );
                w.set_status(WorkerStatus::Stalled);
                let w_clone = w.clone();
                let client_clone = client.clone();
                let writer_clone = writer.clone();
                let limiter_clone = limiter.clone();
                let event_tx_clone = event_tx.clone();
                let stall = self.stall_timeout;
                let retries = self.max_retries;

                tokio::spawn(async move {
                    w_clone
                        .run(
                            client_clone,
                            writer_clone,
                            limiter_clone,
                            event_tx_clone,
                            stall,
                            retries,
                        )
                        .await;
                });
            }
        }
    }

    pub fn active_count(&self) -> u32 {
        self.workers
            .iter()
            .filter(|w| {
                let s = w.get_status();
                s == WorkerStatus::Connecting
                    || s == WorkerStatus::Downloading
                    || s == WorkerStatus::Stalled
            })
            .count() as u32
    }

    pub fn active_error_count(&self) -> u32 {
        self.workers
            .iter()
            .filter(|w| w.get_status() == WorkerStatus::Failed)
            .count() as u32
    }

    pub fn cancel_all(&self) {
        for w in &self.workers {
            w.cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub fn get_telemetry_snapshot(&self) -> Vec<WorkerTelemetry> {
        self.workers
            .iter()
            .map(|w| {
                let start = w.start;
                let end = w.end.load(Ordering::Relaxed);
                let pos = w.pos.load(Ordering::Relaxed);
                let bytes = w.bytes_downloaded.load(Ordering::Relaxed);
                WorkerTelemetry {
                    idx: w.idx,
                    start,
                    end,
                    pos,
                    bytes_downloaded: bytes,
                    speed_bps: 0,
                    status: w.get_status(),
                    retry_count: w.retry_count.load(Ordering::Relaxed),
                }
            })
            .collect()
    }
}
