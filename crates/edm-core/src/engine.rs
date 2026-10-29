use chrono::Utc;
use edm_ipc::DownloadState;
use edm_store::{DownloadRecord, SegmentRecord, Store};
use reqwest::Client;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::planner::Planner;
use crate::probe::Probe;
use crate::worker::{SegmentWorker, WorkerEvent};
use crate::writer::FileWriter;

pub type ProgressCallback = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

pub struct DownloadTask {
    pub id: Uuid,
    pub url: String,
    pub filename: String,
    pub save_dir: PathBuf,
    pub connections: u32,
    pub cancelled: Arc<AtomicBool>,
}

pub struct Engine {
    client: Client,
    store: Store,
}

impl Engine {
    pub fn new(store: Store) -> Self {
        let client = Client::builder()
            .pool_max_idle_per_host(32)
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client, store }
    }

    pub async fn download(
        &self,
        task: DownloadTask,
        progress_callback: Option<ProgressCallback>,
    ) -> Result<PathBuf, String> {
        info!("Starting probe for {}", task.url);
        let probe = Probe::probe_url(&self.client, &task.url)
            .await
            .map_err(|e| format!("Probe failed: {}", e))?;

        let total_size = probe.size_total;
        let filename = probe.filename.unwrap_or(task.filename);
        let resumable = probe.resumable && total_size.is_some();

        // 1. Prepare writer
        let writer = FileWriter::new(&task.save_dir, &filename, total_size)
            .map_err(|e| format!("Writer init failed: {}", e))?;

        // 2. Save download in SQLite
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
            resumable,
            etag: probe.etag.clone(),
            last_modified: probe.last_modified.clone(),
            content_type: probe.content_type.clone(),
            referer: None,
            user_agent: None,
            connections: task.connections,
            created_at: Utc::now(),
            error_msg: None,
        };

        let _ = self.store.insert_download(&record);

        // 3. Plan segments
        let plans = if let Some(size) = total_size {
            if resumable {
                Planner::plan(size, task.connections, Planner::DEFAULT_MIN_SEGMENT_SIZE)
            } else {
                Planner::plan(size, 1, Planner::DEFAULT_MIN_SEGMENT_SIZE)
            }
        } else {
            vec![]
        };

        let mut workers = Vec::new();
        let (tx, mut rx) = mpsc::channel::<WorkerEvent>(100);

        for plan in &plans {
            let worker = Arc::new(SegmentWorker::new(
                plan.idx,
                probe.final_url.clone(),
                plan.start,
                plan.end,
                plan.start,
                probe.etag.clone(),
            ));
            workers.push(worker.clone());

            let client = self.client.clone();
            let writer_clone = writer.clone();
            let tx_clone = tx.clone();

            tokio::spawn(async move {
                worker.run(client, writer_clone, tx_clone).await;
            });
        }

        drop(tx); // drop parent sender so rx ends when workers finish

        let mut total_bytes_done = 0u64;
        let mut active_count = workers.len();
        let mut last_checkpoint = tokio::time::Instant::now();

        while let Some(event) = rx.recv().await {
            match event {
                WorkerEvent::Progress { bytes_read, .. } => {
                    total_bytes_done += bytes_read;
                    if let Some(ref cb) = progress_callback {
                        cb(total_bytes_done, total_size);
                    }

                    // Checkpoint every 2 seconds
                    if last_checkpoint.elapsed() >= Duration::from_secs(2) {
                        let _ = writer.flush();
                        let seg_records: Vec<SegmentRecord> = workers
                            .iter()
                            .map(|w| SegmentRecord {
                                download_id: task.id,
                                idx: w.idx,
                                start: w.start,
                                end: w.end.load(Ordering::Relaxed),
                                pos: w.pos.load(Ordering::Relaxed),
                                state: "downloading".into(),
                                retries: 0,
                            })
                            .collect();
                        let _ = self.store.save_segment_positions(&seg_records);
                        last_checkpoint = tokio::time::Instant::now();
                    }
                }
                WorkerEvent::Done { idx } => {
                    info!("Worker {} finished", idx);
                    active_count = active_count.saturating_sub(1);
                    if active_count == 0 {
                        break;
                    }
                }
                WorkerEvent::Failed { idx, reason } => {
                    warn!("Worker {} failed: {}", idx, reason);
                    active_count = active_count.saturating_sub(1);
                    if active_count == 0 {
                        break;
                    }
                }
            }
        }

        // Final flush and rename
        let final_path = writer
            .finalize(Some(&task.url))
            .map_err(|e| format!("Failed to finalize file: {}", e))?;

        let _ = self
            .store
            .update_download_state(task.id, DownloadState::Completed, None);
        info!("Download completed successfully: {:?}", final_path);
        Ok(final_path)
    }
}
