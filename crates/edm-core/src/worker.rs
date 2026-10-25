use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, IF_RANGE, RANGE};
use reqwest::Client;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use tracing::{debug, error, warn};

use crate::writer::FileWriter;

#[derive(Debug)]
pub enum WorkerEvent {
    Progress {
        idx: u32,
        bytes_read: u64,
        current_pos: u64,
    },
    Done {
        idx: u32,
    },
    Failed {
        idx: u32,
        reason: String,
    },
}

pub struct SegmentWorker {
    pub idx: u32,
    pub url: String,
    pub start: u64,
    pub end: Arc<AtomicU64>, // atomics allow dynamic splitting of the end boundary
    pub pos: Arc<AtomicU64>,
    pub etag: Option<String>,
    pub cancelled: Arc<AtomicBool>,
}

impl SegmentWorker {
    pub fn new(
        idx: u32,
        url: String,
        start: u64,
        end: u64,
        pos: u64,
        etag: Option<String>,
    ) -> Self {
        Self {
            idx,
            url,
            start,
            end: Arc::new(AtomicU64::new(end)),
            pos: Arc::new(AtomicU64::new(pos)),
            etag,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn run(
        &self,
        client: Client,
        writer: FileWriter,
        event_tx: tokio::sync::mpsc::Sender<WorkerEvent>,
    ) {
        let mut retries = 0;
        let max_retries = 8;
        let stall_timeout = Duration::from_secs(30);

        while retries < max_retries && !self.cancelled.load(Ordering::Relaxed) {
            let current_pos = self.pos.load(Ordering::Relaxed);
            let current_end = self.end.load(Ordering::Relaxed);

            if current_pos > current_end {
                let _ = event_tx.send(WorkerEvent::Done { idx: self.idx }).await;
                return;
            }

            debug!(
                "Worker {} connecting for bytes {}-{} (attempt {})",
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

            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    warn!("Worker {} connection error: {}", self.idx, e);
                    retries += 1;
                    tokio::time::sleep(Duration::from_millis(1000 * (1 << retries.min(5)))).await;
                    continue;
                }
            };

            let status = resp.status();
            if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
                warn!("Worker {} received unexpected status {}", self.idx, status);
                retries += 1;
                tokio::time::sleep(Duration::from_millis(1000 * (1 << retries.min(5)))).await;
                continue;
            }

            let mut stream = resp.bytes_stream();
            let mut read_failed = false;

            while !self.cancelled.load(Ordering::Relaxed) {
                let next_chunk = match timeout(stall_timeout, stream.next()).await {
                    Ok(Some(Ok(bytes))) => bytes,
                    Ok(Some(Err(e))) => {
                        warn!("Worker {} chunk read error: {}", self.idx, e);
                        read_failed = true;
                        break;
                    }
                    Ok(None) => {
                        // Stream finished
                        break;
                    }
                    Err(_) => {
                        warn!(
                            "Worker {} stalled (timeout after {:?})",
                            self.idx, stall_timeout
                        );
                        read_failed = true;
                        break;
                    }
                };

                let chunk_len = next_chunk.len() as u64;
                let write_offset = self.pos.load(Ordering::Relaxed);

                // Check if this chunk exceeds the current end boundary
                let boundary_end = self.end.load(Ordering::Relaxed);
                if write_offset + chunk_len - 1 > boundary_end {
                    let allowed = (boundary_end - write_offset + 1) as usize;
                    if allowed > 0 {
                        let sliced = next_chunk.slice(0..allowed);
                        if let Err(e) = writer.write_at(write_offset, &sliced) {
                            error!("Worker {} write error: {}", self.idx, e);
                            read_failed = true;
                            break;
                        }
                        self.pos.fetch_add(allowed as u64, Ordering::SeqCst);
                        let _ = event_tx
                            .send(WorkerEvent::Progress {
                                idx: self.idx,
                                bytes_read: allowed as u64,
                                current_pos: self.pos.load(Ordering::Relaxed),
                            })
                            .await;
                    }
                    break;
                }

                if let Err(e) = writer.write_at(write_offset, &next_chunk) {
                    error!("Worker {} write error: {}", self.idx, e);
                    read_failed = true;
                    break;
                }

                self.pos.fetch_add(chunk_len, Ordering::SeqCst);
                let _ = event_tx
                    .send(WorkerEvent::Progress {
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
                let _ = event_tx.send(WorkerEvent::Done { idx: self.idx }).await;
                return;
            }

            if read_failed {
                retries += 1;
                tokio::time::sleep(Duration::from_millis(500 * (1 << retries.min(4)))).await;
            }
        }

        if self.cancelled.load(Ordering::Relaxed) {
            return;
        }

        let _ = event_tx
            .send(WorkerEvent::Failed {
                idx: self.idx,
                reason: format!("Retries exhausted after {} attempts", retries),
            })
            .await;
    }
}
