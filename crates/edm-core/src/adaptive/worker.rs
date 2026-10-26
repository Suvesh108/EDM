use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, IF_RANGE, RANGE, RETRY_AFTER};
use reqwest::Client;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, error, warn};

use super::types::WorkerStatus;
use crate::limiter::TokenBucketLimiter;
use crate::writer::FileWriter;

#[derive(Debug)]
pub enum AdaptiveWorkerEvent {
    Progress {
        idx: u32,
        bytes_read: u64,
        current_pos: u64,
    },
    RateLimited {
        idx: u32,
        retry_after: Option<Duration>,
    },
    Stalled {
        idx: u32,
    },
    Done {
        idx: u32,
    },
    Failed {
        idx: u32,
        reason: String,
    },
}

#[derive(Clone)]
pub struct AdaptiveWorker {
    pub idx: u32,
    pub url: String,
    pub start: u64,
    pub end: Arc<AtomicU64>,
    pub pos: Arc<AtomicU64>,
    pub bytes_downloaded: Arc<AtomicU64>,
    pub last_activity_ms: Arc<AtomicU64>,
    pub status: Arc<AtomicU8>,
    pub retry_count: Arc<AtomicU32>,
    pub etag: Option<String>,
    pub cancelled: Arc<AtomicBool>,
    pub cookies: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
}

impl AdaptiveWorker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        idx: u32,
        url: String,
        start: u64,
        end: u64,
        pos: u64,
        etag: Option<String>,
        cookies: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
    ) -> Self {
        let now = Utc::now().timestamp_millis() as u64;
        Self {
            idx,
            url,
            start,
            end: Arc::new(AtomicU64::new(end)),
            pos: Arc::new(AtomicU64::new(pos)),
            bytes_downloaded: Arc::new(AtomicU64::new(0)),
            last_activity_ms: Arc::new(AtomicU64::new(now)),
            status: Arc::new(AtomicU8::new(0)), // 0 = Connecting
            retry_count: Arc::new(AtomicU32::new(0)),
            etag,
            cancelled: Arc::new(AtomicBool::new(false)),
            cookies,
            referer,
            user_agent,
        }
    }

    pub fn get_status(&self) -> WorkerStatus {
        match self.status.load(Ordering::Relaxed) {
            0 => WorkerStatus::Connecting,
            1 => WorkerStatus::Downloading,
            2 => WorkerStatus::Stalled,
            3 => WorkerStatus::Completed,
            _ => WorkerStatus::Failed,
        }
    }

    pub fn set_status(&self, status: WorkerStatus) {
        let val = match status {
            WorkerStatus::Connecting => 0,
            WorkerStatus::Downloading => 1,
            WorkerStatus::Stalled => 2,
            WorkerStatus::Completed => 3,
            WorkerStatus::Failed => 4,
        };
        self.status.store(val, Ordering::Relaxed);
    }

    pub fn remaining_bytes(&self) -> u64 {
        let pos = self.pos.load(Ordering::Relaxed);
        let end = self.end.load(Ordering::Relaxed);
        if end >= pos {
            end - pos + 1
        } else {
            0
        }
    }

    pub fn mark_activity(&self) {
        let now = Utc::now().timestamp_millis() as u64;
        self.last_activity_ms.store(now, Ordering::Relaxed);
    }

    pub fn is_stalled(&self, timeout_secs: u64) -> bool {
        if self.get_status() == WorkerStatus::Completed || self.get_status() == WorkerStatus::Failed
        {
            return false;
        }
        let now = Utc::now().timestamp_millis() as u64;
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        now.saturating_sub(last) > (timeout_secs * 1000)
    }

    pub async fn run(
        &self,
        client: Client,
        writer: FileWriter,
        limiter: Option<TokenBucketLimiter>,
        event_tx: mpsc::Sender<AdaptiveWorkerEvent>,
        stall_timeout: Duration,
        max_retries: u32,
    ) {
        let mut retries = 0;

        while retries < max_retries && !self.cancelled.load(Ordering::Relaxed) {
            let current_pos = self.pos.load(Ordering::Relaxed);
            let current_end = self.end.load(Ordering::Relaxed);

            if current_pos > current_end {
                self.set_status(WorkerStatus::Completed);
                let _ = event_tx
                    .send(AdaptiveWorkerEvent::Done { idx: self.idx })
                    .await;
                return;
            }

            self.set_status(WorkerStatus::Connecting);
            self.mark_activity();

            debug!(
                "AdaptiveWorker {} connecting for bytes {}-{} (attempt {})",
                self.idx,
                current_pos,
                current_end,
                retries + 1
            );

            let mut req = client
                .get(&self.url)
                .header(ACCEPT_ENCODING, "identity")
                .header(RANGE, format!("bytes={}-{}", current_pos, current_end));

            if let Some(ref tag) = self.etag {
                req = req.header(IF_RANGE, tag.as_str());
            }

            if let Some(ref cookie_str) = self.cookies {
                req = req.header(reqwest::header::COOKIE, cookie_str.as_str());
            }

            if let Some(ref ref_str) = self.referer {
                req = req.header(reqwest::header::REFERER, ref_str.as_str());
            }

            if let Some(ref ua_str) = self.user_agent {
                req = req.header(reqwest::header::USER_AGENT, ua_str.as_str());
            }

            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    warn!("Worker {} connection error: {}", self.idx, e);
                    retries += 1;
                    self.retry_count.store(retries, Ordering::Relaxed);
                    // Exponential backoff with jitter
                    let jitter_ms = (self.idx as u64 * 73) % 250;
                    tokio::time::sleep(Duration::from_millis(
                        500 * (1 << retries.min(5)) + jitter_ms,
                    ))
                    .await;
                    continue;
                }
            };

            let status = resp.status();

            // Handle HTTP 429 Too Many Requests
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(Duration::from_secs);

                let _ = event_tx
                    .send(AdaptiveWorkerEvent::RateLimited {
                        idx: self.idx,
                        retry_after,
                    })
                    .await;

                let wait_duration = retry_after.unwrap_or_else(|| Duration::from_secs(3));
                tokio::time::sleep(wait_duration).await;
                retries += 1;
                self.retry_count.store(retries, Ordering::Relaxed);
                continue;
            }

            if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
                warn!("Worker {} received HTTP status {}", self.idx, status);
                retries += 1;
                self.retry_count.store(retries, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(500 * (1 << retries.min(4)))).await;
                continue;
            }

            if status == reqwest::StatusCode::OK && self.start > 0 {
                warn!("Server returned 200 OK instead of 206 Partial Content for Worker {}. Aborting secondary worker to prevent overwrite.", self.idx);
                self.set_status(WorkerStatus::Completed);
                let _ = event_tx
                    .send(AdaptiveWorkerEvent::Done { idx: self.idx })
                    .await;
                return;
            }

            if status == reqwest::StatusCode::OK && self.start == 0 {
                // Server streaming from 0; reset write pos to 0
                self.pos.store(0, Ordering::SeqCst);
            }

            self.set_status(WorkerStatus::Downloading);
            let mut stream = resp.bytes_stream();
            let mut read_failed = false;

            while !self.cancelled.load(Ordering::Relaxed) {
                let chunk_result = match timeout(stall_timeout, stream.next()).await {
                    Ok(Some(Ok(bytes))) => Some(bytes),
                    Ok(Some(Err(e))) => {
                        warn!("Worker {} read error: {}", self.idx, e);
                        read_failed = true;
                        None
                    }
                    Ok(None) => {
                        // Stream reached EOF
                        break;
                    }
                    Err(_) => {
                        warn!(
                            "Worker {} stalled (no data for {:?})",
                            self.idx, stall_timeout
                        );
                        self.set_status(WorkerStatus::Stalled);
                        let _ = event_tx
                            .send(AdaptiveWorkerEvent::Stalled { idx: self.idx })
                            .await;
                        read_failed = true;
                        None
                    }
                };

                let next_chunk = match chunk_result {
                    Some(c) => c,
                    None => break,
                };

                let chunk_len = next_chunk.len() as u64;

                // Enforce bandwidth limits if active
                if let Some(ref lim) = limiter {
                    lim.acquire(chunk_len).await;
                }

                let write_offset = self.pos.load(Ordering::Relaxed);
                let boundary_end = self.end.load(Ordering::Relaxed);

                // Check if this chunk crosses the dynamically shrunk boundary
                if write_offset + chunk_len - 1 > boundary_end {
                    let allowed = (boundary_end - write_offset + 1) as usize;
                    if allowed > 0 {
                        let sliced = next_chunk.slice(0..allowed);
                        if let Err(e) = writer.write_at(write_offset, &sliced) {
                            error!("Worker {} disk write error: {}", self.idx, e);
                            read_failed = true;
                            break;
                        }
                        self.pos.fetch_add(allowed as u64, Ordering::SeqCst);
                        self.bytes_downloaded
                            .fetch_add(allowed as u64, Ordering::Relaxed);
                        self.mark_activity();

                        let _ = event_tx
                            .send(AdaptiveWorkerEvent::Progress {
                                idx: self.idx,
                                bytes_read: allowed as u64,
                                current_pos: self.pos.load(Ordering::Relaxed),
                            })
                            .await;
                    }
                    // Reached boundary after dynamic split!
                    break;
                }

                // Normal write within boundary
                if let Err(e) = writer.write_at(write_offset, &next_chunk) {
                    error!("Worker {} disk write error: {}", self.idx, e);
                    read_failed = true;
                    break;
                }

                self.pos.fetch_add(chunk_len, Ordering::SeqCst);
                self.bytes_downloaded
                    .fetch_add(chunk_len, Ordering::Relaxed);
                self.mark_activity();

                let _ = event_tx
                    .send(AdaptiveWorkerEvent::Progress {
                        idx: self.idx,
                        bytes_read: chunk_len,
                        current_pos: self.pos.load(Ordering::Relaxed),
                    })
                    .await;

                if self.pos.load(Ordering::Relaxed) > self.end.load(Ordering::Relaxed) {
                    break;
                }
            }

            if !read_failed && self.pos.load(Ordering::Relaxed) > self.end.load(Ordering::Relaxed) {
                self.set_status(WorkerStatus::Completed);
                let _ = event_tx
                    .send(AdaptiveWorkerEvent::Done { idx: self.idx })
                    .await;
                return;
            }

            if read_failed {
                retries += 1;
                self.retry_count.store(retries, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(300 * (1 << retries.min(4)))).await;
            }
        }

        if self.cancelled.load(Ordering::Relaxed) {
            return;
        }

        self.set_status(WorkerStatus::Failed);
        let _ = event_tx
            .send(AdaptiveWorkerEvent::Failed {
                idx: self.idx,
                reason: format!("Worker {} exhausted {} retries", self.idx, retries),
            })
            .await;
    }
}
