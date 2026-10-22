use crate::database::Database;
use crate::engine::segment_manager::SegmentManager;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, RANGE, USER_AGENT};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

pub struct ProbeResult {
    pub url: String,
    pub filename: String,
    pub total_bytes: i64,
    pub accepts_ranges: bool,
    pub content_type: String,
}

pub async fn probe_url(client: &reqwest::Client, url: &str) -> Result<ProbeResult, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        ),
    );
    headers.insert(RANGE, HeaderValue::from_static("bytes=0-1"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Network probe failed: {}", e))?;

    let status = resp.status();
    let accepts_ranges = status == reqwest::StatusCode::PARTIAL_CONTENT;
    let resp_headers = resp.headers().clone();

    // 1. Determine Content-Length
    let mut total_bytes = -1i64;
    if let Some(cr) = resp_headers.get("Content-Range") {
        if let Ok(cr_str) = cr.to_str() {
            // Content-Range: bytes 0-1/10485760
            if let Some(pos) = cr_str.rfind('/') {
                if let Ok(len) = cr_str[pos + 1..].trim().parse::<i64>() {
                    total_bytes = len;
                }
            }
        }
    }

    if total_bytes <= 0 {
        if let Some(cl) = resp_headers.get(reqwest::header::CONTENT_LENGTH) {
            if let Ok(cl_str) = cl.to_str() {
                if let Ok(len) = cl_str.trim().parse::<i64>() {
                    total_bytes = len;
                }
            }
        }
    }

    // 2. Determine Filename
    let mut filename = String::new();
    if let Some(cd) = resp_headers.get(reqwest::header::CONTENT_DISPOSITION) {
        if let Ok(cd_str) = cd.to_str() {
            if let Some(name) = extract_filename_from_cd(cd_str) {
                filename = name;
            }
        }
    }

    if filename.is_empty() {
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(segments) = parsed.path_segments() {
                if let Some(last) = segments.last() {
                    let cleaned = last.split('?').next().unwrap_or(last);
                    if !cleaned.is_empty() {
                        filename = cleaned.to_string();
                    }
                }
            }
        }
    }

    if filename.is_empty() {
        filename = "download.bin".to_string();
    }

    let content_type = resp_headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    Ok(ProbeResult {
        url: url.to_string(),
        filename,
        total_bytes,
        accepts_ranges,
        content_type,
    })
}

fn extract_filename_from_cd(cd: &str) -> Option<String> {
    for part in cd.split(';') {
        let trimmed = part.trim();
        if trimmed.to_lowercase().starts_with("filename*=") {
            let val = &trimmed["filename*=".len()..];
            let clean = val.split("''").last().unwrap_or(val).trim_matches('"');
            return Some(clean.to_string());
        } else if trimmed.to_lowercase().starts_with("filename=") {
            let val = trimmed["filename=".len()..].trim_matches('"');
            return Some(val.to_string());
        }
    }
    None
}

pub struct DownloadJob {
    pub task_id: String,
    pub url: String,
    pub save_path: PathBuf,
    pub total_bytes: i64,
    pub threads: u32,
    pub db: Database,
    pub cancel_rx: broadcast::Receiver<()>,
}

impl DownloadJob {
    pub async fn run(self, client: reqwest::Client) -> Result<(), String> {
        let task_id = self.task_id.clone();
        let total = self.total_bytes;
        let accepts_ranges = total > 0;

        // Ensure parent directory exists
        if let Some(parent) = self.save_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create folder: {}", e))?;
        }

        // Open/Create target sparse file
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.save_path)
            .await
            .map_err(|e| format!("Failed to open file on disk: {}", e))?;

        if accepts_ranges {
            let _ = file.set_len(total as u64).await;
        }

        let threads_count = if accepts_ranges {
            self.threads.clamp(1, 32)
        } else {
            1
        };

        let segment_mgr = Arc::new(SegmentManager::new(total as u64, threads_count));
        let downloaded_counter = Arc::new(AtomicU64::new(0));
        let is_cancelled = Arc::new(AtomicBool::new(false));

        // Cancellation listener
        let mut cancel_listener = self.cancel_rx.resubscribe();
        let is_cancelled_clone = Arc::clone(&is_cancelled);
        tokio::spawn(async move {
            let _ = cancel_listener.recv().await;
            is_cancelled_clone.store(true, Ordering::SeqCst);
        });

        // Spawn workers
        let mut worker_handles = Vec::new();
        for worker_id in 0..threads_count {
            let mgr = Arc::clone(&segment_mgr);
            let client = client.clone();
            let url = self.url.clone();
            let save_path = self.save_path.clone();
            let cancelled = Arc::clone(&is_cancelled);
            let downloaded_ctr = Arc::clone(&downloaded_counter);

            let handle = tokio::spawn(async move {
                while !cancelled.load(Ordering::Relaxed) {
                    let seg = match mgr.request_work() {
                        Some(s) => s,
                        None => break, // No more work available
                    };

                    let seg_id = seg.id;
                    let cur = seg.current.load(Ordering::SeqCst);
                    let end = seg.end.load(Ordering::SeqCst);

                    if cur > end {
                        mgr.mark_finished(seg_id);
                        continue;
                    }

                    // Open file handle for writing this segment
                    let mut file = match OpenOptions::new()
                        .write(true)
                        .open(&save_path)
                        .await
                    {
                        Ok(f) => f,
                        Err(e) => {
                            error!("Worker {}: failed to open file: {}", worker_id, e);
                            mgr.mark_inactive(seg_id);
                            break;
                        }
                    };

                    if let Err(e) = file.seek(SeekFrom::Start(cur)).await {
                        error!("Worker {}: seek failed: {}", worker_id, e);
                        mgr.mark_inactive(seg_id);
                        break;
                    }

                    let range_header = if total > 0 {
                        format!("bytes={}-{}", cur, end)
                    } else {
                        "bytes=0-".to_string()
                    };

                    let req = client
                        .get(&url)
                        .header(
                            USER_AGENT,
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36",
                        )
                        .header(RANGE, range_header);

                    let resp = match req.send().await {
                        Ok(r) => r,
                        Err(e) => {
                            warn!("Worker {}: request failed: {}", worker_id, e);
                            mgr.mark_inactive(seg_id);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                    };

                    let mut stream = resp.bytes_stream();
                    let mut finished_naturally = true;

                    while let Some(chunk_res) = stream.next().await {
                        if cancelled.load(Ordering::Relaxed) {
                            mgr.mark_inactive(seg_id);
                            return;
                        }

                        let chunk = match chunk_res {
                            Ok(c) => c,
                            Err(e) => {
                                warn!("Worker {}: stream chunk error: {}", worker_id, e);
                                finished_naturally = false;
                                break;
                            }
                        };

                        let len = chunk.len() as u64;
                        let max_end = seg.end.load(Ordering::SeqCst);
                        let curr_pos = seg.current.load(Ordering::SeqCst);

                        // If dynamically split by another worker, stop at new boundary
                        let allowed_len = if total > 0 && curr_pos + len > max_end + 1 {
                            (max_end + 1).saturating_sub(curr_pos) as usize
                        } else {
                            chunk.len()
                        };

                        if allowed_len > 0 {
                            if let Err(e) = file.write_all(&chunk[..allowed_len]).await {
                                error!("Worker {}: write error: {}", worker_id, e);
                                finished_naturally = false;
                                break;
                            }
                            seg.current.fetch_add(allowed_len as u64, Ordering::SeqCst);
                            downloaded_ctr.fetch_add(allowed_len as u64, Ordering::SeqCst);
                        }

                        if total > 0 && seg.current.load(Ordering::SeqCst) > max_end {
                            break;
                        }
                    }

                    let final_cur = seg.current.load(Ordering::SeqCst);
                    let final_end = seg.end.load(Ordering::SeqCst);
                    if finished_naturally && (total <= 0 || final_cur > final_end) {
                        mgr.mark_finished(seg_id);
                    } else {
                        mgr.mark_inactive(seg_id);
                    }
                }
            });
            worker_handles.push(handle);
        }

        // Telemetry monitor loop
        let mut last_instant = Instant::now();
        let mut last_bytes = 0u64;

        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            if is_cancelled.load(Ordering::Relaxed) {
                let _ = self.db.update_task_status(&task_id, "paused", None);
                return Ok(());
            }

            let cur_bytes = downloaded_counter.load(Ordering::Relaxed);
            let elapsed = last_instant.elapsed().as_secs_f64();

            if elapsed >= 0.5 {
                let speed = if elapsed > 0.0 {
                    (cur_bytes.saturating_sub(last_bytes)) as f64 / elapsed
                } else {
                    0.0
                };
                let eta = if speed > 0.0 && total > 0 {
                    ((total as u64).saturating_sub(cur_bytes) as f64 / speed) as i64
                } else {
                    0
                };

                let _ = self.db.update_task_progress(
                    &task_id,
                    cur_bytes as i64,
                    total,
                    speed,
                    eta,
                );

                last_instant = Instant::now();
                last_bytes = cur_bytes;
            }

            if segment_mgr.is_all_finished() {
                break;
            }

            // Check if all handles died prematurely
            if worker_handles.iter().all(|h| h.is_finished()) && !segment_mgr.is_all_finished() {
                break;
            }
        }

        // Await worker tasks
        for h in worker_handles {
            let _ = h.await;
        }

        if is_cancelled.load(Ordering::Relaxed) {
            let _ = self.db.update_task_status(&task_id, "paused", None);
            return Ok(());
        }

        let final_bytes = downloaded_counter.load(Ordering::SeqCst);
        let final_total = if total > 0 { total } else { final_bytes as i64 };

        let _ = self.db.update_task_progress(&task_id, final_bytes as i64, final_total, 0.0, 0);
        let _ = self.db.update_task_status(&task_id, "completed", None);
        info!("Task {} finished successfully: {} bytes", task_id, final_bytes);

        Ok(())
    }
}
