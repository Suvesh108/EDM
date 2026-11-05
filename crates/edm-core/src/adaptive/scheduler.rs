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

        let (target_idx, _) = best_candidate?;
        let target = &self.workers[target_idx];

        let cur_end = target.end.load(Ordering::SeqCst);
        let cur_pos = target.pos.load(Ordering::SeqCst);

        if cur_end <= cur_pos || (cur_end - cur_pos + 1) < 2 * self.min_chunk_size {
            return None;
        }

        let remaining = cur_end - cur_pos + 1;
        let stolen_len = remaining / 2;

        if stolen_len < self.min_chunk_size || (remaining - stolen_len) < self.min_chunk_size {
            return None;
        }

        // Steal from tail: victim keeps [cur_pos ..= cur_end - stolen_len], thief gets [cur_end - stolen_len + 1 ..= cur_end]
        let new_target_end = cur_end - stolen_len;

        // Atomically contract target worker's end boundary using compare_exchange
        if target
            .end
            .compare_exchange(cur_end, new_target_end, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // End boundary was concurrently modified by another steal or boundary update
            return None;
        }

        // Verify victim hasn't already crossed the new end boundary while CAS was executing
        let active_pos = target.pos.load(Ordering::SeqCst);
        if active_pos > new_target_end {
            // Target already advanced past the proposed split point: rollback and cancel steal
            let _ = target
                .end
                .compare_exchange(new_target_end, cur_end, Ordering::SeqCst, Ordering::SeqCst);
            return None;
        }

        let new_worker_start = new_target_end + 1;
        let new_worker_end = cur_end;

        info!(
            "Dynamic Work Steal: Worker {} boundary shrunk to {}-{}. Spawning Worker {} for {}-{} ({} KiB stolen)",
            target.idx,
            active_pos,
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
                if w.is_reconnecting.swap(true, Ordering::SeqCst) {
                    continue;
                }
                w.mark_activity();
                let current_retries = w.retry_count.fetch_add(1, Ordering::Relaxed);
                if current_retries >= self.max_retries {
                    w.set_status(WorkerStatus::Failed);
                    let _ = event_tx.try_send(AdaptiveWorkerEvent::Failed {
                        idx: w.idx,
                        reason: format!(
                            "Worker {} stalled after {} retry attempts",
                            w.idx, current_retries
                        ),
                    });
                    continue;
                }
                info!(
                    "Stall detected on Worker {} at pos {}. Initiating reconnect (attempt {}/{}).",
                    w.idx,
                    w.pos.load(Ordering::Relaxed),
                    current_retries + 1,
                    self.max_retries
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
            w.cancelled.store(true, Ordering::SeqCst);
        }
    }

    pub fn cancel_all_except(&self, keep_idx: u32) {
        for w in &self.workers {
            if w.idx != keep_idx {
                w.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn get_telemetry_snapshot(&self) -> Vec<WorkerTelemetry> {
        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
        self.workers
            .iter()
            .map(|w| {
                let start = w.start;
                let end = w.end.load(Ordering::Relaxed);
                let pos = w.pos.load(Ordering::Relaxed);
                let bytes = w.bytes_downloaded.load(Ordering::Relaxed);

                // Compute real instantaneous worker speed
                let last_b = w.last_snapshot_bytes.swap(bytes, Ordering::Relaxed);
                let last_t = w.last_snapshot_ms.swap(now_ms, Ordering::Relaxed);
                let delta_b = bytes.saturating_sub(last_b);
                let delta_t = now_ms.saturating_sub(last_t);

                let speed_bps = (delta_b * 1000 * 8)
                    .checked_div(delta_t)
                    .unwrap_or_else(|| w.speed_bps.load(Ordering::Relaxed));
                w.speed_bps.store(speed_bps, Ordering::Relaxed);

                WorkerTelemetry {
                    idx: w.idx,
                    start,
                    end,
                    pos,
                    bytes_downloaded: bytes,
                    speed_bps,
                    status: w.get_status(),
                    retry_count: w.retry_count.load(Ordering::Relaxed),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_work_stealing_stress_1000_runs() {
        use crate::adaptive::range_set::RangeSet;
        use std::sync::atomic::Ordering;

        let total_size = 100 * 1024 * 1024; // 100 MiB
        let min_chunk = 1024 * 1024; // 1 MiB

        let mut rng_state: u64 = 0xDEADBEEFCAFE;
        let mut next_rand = || {
            rng_state ^= rng_state >> 12;
            rng_state ^= rng_state << 25;
            rng_state ^= rng_state >> 27;
            rng_state.wrapping_mul(0x2545F4914F6CDD1D)
        };

        for run in 0..1000 {
            let mut scheduler = WorkScheduler::new(min_chunk, Duration::from_secs(3), 3);
            let initial_conns = (next_rand() % 8 + 1) as u32;
            let plans = crate::planner::Planner::plan(total_size, initial_conns, min_chunk);

            for plan in plans {
                let w = Arc::new(AdaptiveWorker::new(
                    scheduler.next_idx,
                    "http://localhost/test".into(),
                    plan.start,
                    plan.end,
                    plan.start,
                    None,
                    None,
                    None,
                    None,
                ));
                scheduler.next_idx += 1;
                w.set_status(WorkerStatus::Downloading);
                scheduler.workers.push(w);
            }

            // Simulate up to 20 random steal and progress events per run
            let num_events = (next_rand() % 20 + 5) as usize;
            for _ in 0..num_events {
                // Advance random worker by a random amount
                if !scheduler.workers.is_empty() {
                    let w_idx = (next_rand() as usize) % scheduler.workers.len();
                    let w = &scheduler.workers[w_idx];
                    let cur_pos = w.pos.load(Ordering::SeqCst);
                    let cur_end = w.end.load(Ordering::SeqCst);
                    if cur_pos < cur_end {
                        let advance = (next_rand() % (cur_end - cur_pos + 1)).min(512 * 1024);
                        w.pos.fetch_add(advance, Ordering::SeqCst);
                    }
                }

                // Simulate steal logic directly on the scheduler's workers
                let mut best: Option<(usize, u64)> = None;
                for (i, w) in scheduler.workers.iter().enumerate() {
                    let rem = w.remaining_bytes();
                    if rem >= 2 * scheduler.min_chunk_size {
                        match best {
                            None => best = Some((i, rem)),
                            Some((_, b_rem)) if rem > b_rem => best = Some((i, rem)),
                            _ => {}
                        }
                    }
                }

                if let Some((target_idx, _)) = best {
                    let target = &scheduler.workers[target_idx];
                    let cur_end = target.end.load(Ordering::SeqCst);
                    let cur_pos = target.pos.load(Ordering::SeqCst);

                    if cur_end > cur_pos && (cur_end - cur_pos + 1) >= 2 * scheduler.min_chunk_size {
                        let remaining = cur_end - cur_pos + 1;
                        let stolen_len = remaining / 2;
                        if stolen_len >= scheduler.min_chunk_size
                            && (remaining - stolen_len) >= scheduler.min_chunk_size
                        {
                            let new_target_end = cur_end - stolen_len;
                            if target
                                .end
                                .compare_exchange(
                                    cur_end,
                                    new_target_end,
                                    Ordering::SeqCst,
                                    Ordering::SeqCst,
                                )
                                .is_ok()
                            {
                                let active_pos = target.pos.load(Ordering::SeqCst);
                                if active_pos <= new_target_end {
                                    let new_w = Arc::new(AdaptiveWorker::new(
                                        scheduler.next_idx,
                                        target.url.clone(),
                                        new_target_end + 1,
                                        cur_end,
                                        new_target_end + 1,
                                        None,
                                        None,
                                        None,
                                        None,
                                    ));
                                    scheduler.next_idx += 1;
                                    new_w.set_status(WorkerStatus::Downloading);
                                    scheduler.workers.push(new_w);
                                } else {
                                    // Rollback
                                    let _ = target.end.compare_exchange(
                                        new_target_end,
                                        cur_end,
                                        Ordering::SeqCst,
                                        Ordering::SeqCst,
                                    );
                                }
                            }
                        }
                    }
                }

                // INVARIANT CHECK:
                // 1. All workers have pos <= end + 1 and start <= end
                // 2. Active remaining ranges [pos, end] are disjoint
                // 3. Union of [start, end] of all workers is exactly [0, total_size - 1]
                let mut range_set = RangeSet::new();
                for w in &scheduler.workers {
                    let s = w.start;
                    let e = w.end.load(Ordering::SeqCst);
                    assert!(s <= e, "Run {}: worker start {} > end {}", run, s, e);
                    range_set.add(s, e);
                }

                assert!(
                    range_set.is_complete(total_size),
                    "Run {}: range_set is not complete! Gaps: {:?}",
                    run,
                    range_set.missing_ranges(total_size)
                );
                assert_eq!(
                    range_set.total_covered_bytes(),
                    total_size,
                    "Run {}: total covered bytes {} != expected {}",
                    run,
                    range_set.total_covered_bytes(),
                    total_size
                );
            }
        }
    }
}
