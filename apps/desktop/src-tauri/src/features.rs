use chrono::{Datelike, DateTime, Local};
use edm_core::media::MediaGrabber;
use edm_ipc::{DownloadState, MediaVariant};
use edm_store::{DownloadRecord, QueueRecord, Store};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaProbeResult {
    pub variants: Vec<MediaVariant>,
    pub is_drm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumResult {
    pub verified: bool,
    pub actual_hash: String,
    pub algo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateCheckResult {
    pub is_duplicate: bool,
    pub existing_id: Option<String>,
    pub existing_filename: Option<String>,
    pub existing_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PowerCountdownInfo {
    pub active: bool,
    pub action: String,
    pub seconds_remaining: u32,
}

pub struct PowerCountdownController {
    pub active: Arc<AtomicBool>,
    pub action: Arc<Mutex<String>>,
    pub seconds_remaining: Arc<Mutex<u32>>,
}

impl PowerCountdownController {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            action: Arc::new(Mutex::new("none".to_string())),
            seconds_remaining: Arc::new(Mutex::new(60)),
        }
    }

    pub fn start_countdown(
        &self,
        action: &str,
        ws_manager: Arc<crate::ws_server::WsManager>,
        app_handle: Option<tauri::AppHandle>,
    ) {
        if self.active.load(Ordering::Relaxed) {
            return;
        }

        self.active.store(true, Ordering::Relaxed);
        *self.action.lock().unwrap() = action.to_string();
        *self.seconds_remaining.lock().unwrap() = 60;

        let active_flag = self.active.clone();
        let action_str = action.to_string();
        let seconds_var = self.seconds_remaining.clone();

        tokio::spawn(async move {
            info!("Power action countdown started: {} (60 seconds)", action_str);
            for sec in (0..=60).rev() {
                if !active_flag.load(Ordering::Relaxed) {
                    info!("Power action countdown cancelled by user");
                    ws_manager.broadcast_power_countdown("none", 0).await;
                    return;
                }

                *seconds_var.lock().unwrap() = sec;
                ws_manager.broadcast_power_countdown(&action_str, sec).await;

                if let Some(ref handle) = app_handle {
                    use tauri::Emitter;
                    let _ = handle.emit(
                        "power_countdown",
                        PowerCountdownInfo {
                            active: true,
                            action: action_str.clone(),
                            seconds_remaining: sec,
                        },
                    );
                }

                if sec == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            if active_flag.load(Ordering::Relaxed) {
                info!("Executing system power action: {}", action_str);
                active_flag.store(false, Ordering::Relaxed);
                let _ = execute_system_power_action(&action_str);
            }
        });
    }

    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
        *self.seconds_remaining.lock().unwrap() = 0;
    }

    pub fn status(&self) -> PowerCountdownInfo {
        let active = self.active.load(Ordering::Relaxed);
        let action = self.action.lock().unwrap().clone();
        let sec = *self.seconds_remaining.lock().unwrap();
        PowerCountdownInfo {
            active,
            action,
            seconds_remaining: if active { sec } else { 0 },
        }
    }
}

/// Executes Win32 power management operations safely
pub fn execute_system_power_action(action: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        #[link(name = "powrprof")]
        extern "system" {
            fn SetSuspendState(hibernate: i32, force_critical: i32, disable_wake_event: i32) -> i32;
        }

        #[link(name = "advapi32")]
        extern "system" {
            fn InitiateSystemShutdownExW(
                lp_machine_name: *const u16,
                lp_message: *const u16,
                dw_timeout: u32,
                b_force_apps_closed: i32,
                b_reboot_after_shutdown: i32,
                dw_reason: u32,
            ) -> i32;
        }

        match action.to_lowercase().as_str() {
            "sleep" => unsafe {
                let ret = SetSuspendState(0, 0, 0);
                if ret != 0 {
                    Ok(())
                } else {
                    Err("SetSuspendState failed".into())
                }
            },
            "hibernate" => unsafe {
                let ret = SetSuspendState(1, 0, 0);
                if ret != 0 {
                    Ok(())
                } else {
                    Err("SetSuspendState hibernate failed".into())
                }
            },
            "shutdown" => unsafe {
                let msg: Vec<u16> = "EDM - All Downloads Completed. Shutting down.\0"
                    .encode_utf16()
                    .collect();
                let ret = InitiateSystemShutdownExW(
                    std::ptr::null(),
                    msg.as_ptr(),
                    0,
                    1,
                    0,
                    0x80000000, // SHTDN_REASON_FLAG_PLANNED
                );
                if ret != 0 {
                    Ok(())
                } else {
                    Err("InitiateSystemShutdownExW failed".into())
                }
            },
            _ => Ok(()),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = action;
        Ok(())
    }
}

/// Validates a new URL and performs the 1 MiB overlap verification before resuming an expired link
pub async fn validate_and_refresh_link(
    store: &Store,
    task_id: Uuid,
    new_url: &str,
    new_headers: Option<&HashMap<String, String>>,
) -> Result<DownloadRecord, String> {
    crate::validate_url_security(new_url)?;

    let records = store.list_all_downloads().map_err(|e| e.to_string())?;
    let task = records
        .into_iter()
        .find(|d| d.id == task_id)
        .ok_or_else(|| "Task not found".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(new_url);
    if let Some(headers) = new_headers {
        for (k, v) in headers {
            if let (Ok(hn), Ok(hv)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                req = req.header(hn, hv);
            }
        }
    }

    let resp = req
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("Failed to reach new URL: {}", e))?;

    let status = resp.status();
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("New URL returned HTTP {}", status));
    }

    // Check size if known
    if let Some(expected_total) = task.size_total {
        if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
            if let Ok(cr_str) = cr.to_str() {
                if let Some(slash_idx) = cr_str.rfind('/') {
                    if let Ok(total) = cr_str[slash_idx + 1..].trim().parse::<u64>() {
                        if total != expected_total {
                            return Err(format!(
                                "File size mismatch: expected {} bytes, new URL has {} bytes",
                                expected_total, total
                            ));
                        }
                    }
                }
            }
        }
    }

    // 1 MiB Overlap Verification Check
    let file_path = PathBuf::from(&task.save_dir).join(&task.filename);
    let overlap_size: u64 = 1024 * 1024; // 1 MiB

    if task.size_done >= overlap_size && file_path.exists() {
        let overlap_start = task.size_done - overlap_size;
        let overlap_end = task.size_done - 1;

        let mut probe_req = client.get(new_url).header(
            reqwest::header::RANGE,
            format!("bytes={}-{}", overlap_start, overlap_end),
        );
        if let Some(headers) = new_headers {
            for (k, v) in headers {
                if let (Ok(hn), Ok(hv)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    probe_req = probe_req.header(hn, hv);
                }
            }
        }

        let overlap_resp = probe_req
            .send()
            .await
            .map_err(|e| format!("Failed to probe overlap chunk: {}", e))?;

        if overlap_resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let new_bytes = overlap_resp
                .bytes()
                .await
                .map_err(|e| format!("Failed to read overlap bytes: {}", e))?;

            if new_bytes.len() as u64 == overlap_size {
                use sha2::{Digest, Sha256};
                let mut hasher_new = Sha256::new();
                hasher_new.update(&new_bytes);
                let hash_new = hasher_new.finalize();

                use std::io::{Read, Seek, SeekFrom};
                let mut local_file = std::fs::File::open(&file_path)
                    .map_err(|e| format!("Cannot read local file for overlap verification: {}", e))?;
                local_file
                    .seek(SeekFrom::Start(overlap_start))
                    .map_err(|e| e.to_string())?;

                let mut local_chunk = vec![0u8; overlap_size as usize];
                local_file
                    .read_exact(&mut local_chunk)
                    .map_err(|e| e.to_string())?;

                let mut hasher_local = Sha256::new();
                hasher_local.update(&local_chunk);
                let hash_local = hasher_local.finalize();

                if hash_new != hash_local {
                    return Err(
                        "Overlap verification failed: new link content differs from existing partial file"
                            .into(),
                    );
                }
                info!(
                    "Overlap verification passed: 1 MiB SHA-256 match confirmed for task {}",
                    task_id
                );
            }
        }
    }

    store
        .update_download_url(task_id, new_url)
        .map_err(|e| e.to_string())?;
    store
        .update_download_state(task_id, DownloadState::Queued, None)
        .map_err(|e| e.to_string())?;

    let updated_task = DownloadRecord {
        url: new_url.to_string(),
        state: DownloadState::Queued,
        ..task
    };

    Ok(updated_task)
}

/// Probes media URL for streams and DRM
pub async fn probe_media(url: &str) -> Result<MediaProbeResult, String> {
    crate::validate_url_security(url)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    use edm_core::packs::extractors::{SiteExtractor, VimeoExtractor, YouTubeExtractor};
    use edm_core::packs::ytdlp::YtDlpPack;

    if (url.contains("youtube.com") || url.contains("youtu.be")) && YtDlpPack::locate_binary().is_some() {
        if let Ok(meta) = YtDlpPack::extract_info(url).await {
            let ipc_variants = meta
                .formats
                .into_iter()
                .map(|f| {
                    let is_audio = f.vcodec.as_deref() == Some("none");
                    MediaVariant {
                        quality: f.resolution.clone().unwrap_or(f.format_id),
                        url: f.url.unwrap_or_else(|| url.to_string()),
                        media_type: if is_audio { "audio".into() } else { "direct".into() },
                        resolution: f.resolution,
                        bitrate: f.filesize.map(|s| s * 8),
                    }
                })
                .collect();
            return Ok(MediaProbeResult {
                variants: ipc_variants,
                is_drm: false,
            });
        }
    }

    let yt = YouTubeExtractor;
    if yt.can_extract(url) {
        if let Ok(meta) = yt.extract(url, &client).await {
            let ipc_variants = meta
                .formats
                .into_iter()
                .map(|f| MediaVariant {
                    quality: f.resolution.clone().unwrap_or(f.format_id),
                    url: f.url,
                    media_type: if f.is_audio && !f.is_video { "audio".into() } else { "direct".into() },
                    resolution: f.resolution,
                    bitrate: f.filesize.map(|s| s * 8),
                })
                .collect();
            return Ok(MediaProbeResult {
                variants: ipc_variants,
                is_drm: false,
            });
        }
    }

    let vimeo = VimeoExtractor;
    if vimeo.can_extract(url) {
        if let Ok(meta) = vimeo.extract(url, &client).await {
            let ipc_variants = meta
                .formats
                .into_iter()
                .map(|f| MediaVariant {
                    quality: f.resolution.clone().unwrap_or(f.format_id),
                    url: f.url,
                    media_type: if f.is_audio && !f.is_video { "audio".into() } else { "direct".into() },
                    resolution: f.resolution,
                    bitrate: f.filesize.map(|s| s * 8),
                })
                .collect();
            return Ok(MediaProbeResult {
                variants: ipc_variants,
                is_drm: false,
            });
        }
    }

    let (variants, is_drm) = MediaGrabber::probe_media_stream(url, &client).await?;
    let ipc_variants = variants
        .into_iter()
        .map(|v| MediaVariant {
            quality: v.quality,
            url: v.url,
            media_type: if url.contains(".m3u8") {
                "hls".into()
            } else if url.contains(".mpd") {
                "dash".into()
            } else {
                "direct".into()
            },
            resolution: v.resolution,
            bitrate: v.bandwidth,
        })
        .collect();

    Ok(MediaProbeResult {
        variants: ipc_variants,
        is_drm,
    })
}

/// Computes file hash in low-priority background thread and compares against expected hash
pub fn verify_file_checksum(
    file_path: &Path,
    expected_hash: &str,
    algo: &str,
) -> Result<ChecksumResult, String> {
    if !file_path.exists() {
        return Err("Target file does not exist".into());
    }

    let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    let algo_lower = algo.to_lowercase();

    let actual_hash = match algo_lower.as_str() {
        "sha256" | "sha-256" => {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
            hex::encode(hasher.finalize())
        }
        "sha1" | "sha-1" => {
            use sha1::{Digest, Sha1};
            let mut hasher = Sha1::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
            hex::encode(hasher.finalize())
        }
        "md5" => {
            use md5::{Digest, Md5};
            let mut hasher = Md5::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
            hex::encode(hasher.finalize())
        }
        _ => return Err(format!("Unsupported checksum algorithm: {}", algo)),
    };

    let cleaned_expected = expected_hash.trim().to_lowercase();
    let verified = actual_hash.eq_ignore_ascii_case(&cleaned_expected);

    Ok(ChecksumResult {
        verified,
        actual_hash,
        algo: algo_lower,
    })
}

/// Checks whether the current time falls inside a queue schedule window
#[allow(dead_code)]
pub fn is_queue_active_at_time(queue: &QueueRecord, now: DateTime<Local>) -> bool {
    let days_match = if let Some(ref days) = queue.schedule_days {
        let current_day = match now.weekday() {
            chrono::Weekday::Mon => "Mon",
            chrono::Weekday::Tue => "Tue",
            chrono::Weekday::Wed => "Wed",
            chrono::Weekday::Thu => "Thu",
            chrono::Weekday::Fri => "Fri",
            chrono::Weekday::Sat => "Sat",
            chrono::Weekday::Sun => "Sun",
        };
        days.contains(current_day)
    } else {
        true
    };

    if !days_match {
        return false;
    }

    if let (Some(ref start_str), Some(ref stop_str)) = (&queue.schedule_start, &queue.schedule_stop) {
        if let (Ok(start_time), Ok(stop_time)) = (
            chrono::NaiveTime::parse_from_str(start_str, "%H:%M"),
            chrono::NaiveTime::parse_from_str(stop_str, "%H:%M"),
        ) {
            let current_time = now.time();
            if start_time <= stop_time {
                // Same day window, e.g. 09:00 - 18:00
                current_time >= start_time && current_time <= stop_time
            } else {
                // Cross-midnight window, e.g. 22:00 - 06:00
                current_time >= start_time || current_time <= stop_time
            }
        } else {
            true
        }
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_queue_schedule_normal_window() {
        let q = QueueRecord {
            id: "work".into(),
            name: "Work".into(),
            max_concurrent: 3,
            speed_limit_bytes_per_sec: None,
            schedule_start: Some("09:00".into()),
            schedule_stop: Some("17:00".into()),
            schedule_days: Some("Mon,Tue,Wed,Thu,Fri".into()),
            post_action: "none".into(),
        };

        // Monday 12:00
        let mon_noon = Local.with_ymd_and_hms(2026, 11, 2, 12, 0, 0).unwrap();
        assert!(is_queue_active_at_time(&q, mon_noon));

        // Monday 20:00 (outside window)
        let mon_night = Local.with_ymd_and_hms(2026, 11, 2, 20, 0, 0).unwrap();
        assert!(!is_queue_active_at_time(&q, mon_night));

        // Sunday 12:00 (wrong day)
        let sun_noon = Local.with_ymd_and_hms(2026, 11, 1, 12, 0, 0).unwrap();
        assert!(!is_queue_active_at_time(&q, sun_noon));
    }

    #[test]
    fn test_queue_schedule_cross_midnight() {
        let q = QueueRecord {
            id: "night".into(),
            name: "Nightly".into(),
            max_concurrent: 5,
            speed_limit_bytes_per_sec: None,
            schedule_start: Some("22:00".into()),
            schedule_stop: Some("06:00".into()),
            schedule_days: None,
            post_action: "sleep".into(),
        };

        // 23:30 (active)
        let late_night = Local.with_ymd_and_hms(2026, 11, 2, 23, 30, 0).unwrap();
        assert!(is_queue_active_at_time(&q, late_night));

        // 03:00 (active next morning)
        let early_morn = Local.with_ymd_and_hms(2026, 11, 3, 3, 0, 0).unwrap();
        assert!(is_queue_active_at_time(&q, early_morn));

        // 12:00 noon (inactive)
        let noon = Local.with_ymd_and_hms(2026, 11, 3, 12, 0, 0).unwrap();
        assert!(!is_queue_active_at_time(&q, noon));
    }

    #[test]
    fn test_file_checksum_verification() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("edm_checksum_test.txt");
        let content = b"EDM Download Manager Safe Checksum Test 123";
        std::fs::write(&test_file, content).unwrap();

        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content);
        let expected_sha256 = hex::encode(hasher.finalize());

        let res = verify_file_checksum(&test_file, &expected_sha256, "sha256").unwrap();
        assert!(res.verified);
        assert_eq!(res.actual_hash, expected_sha256);

        let bad_res = verify_file_checksum(&test_file, "00000000000000000000000000000000", "sha256").unwrap();
        assert!(!bad_res.verified);

        let _ = std::fs::remove_file(&test_file);
    }

    #[test]
    fn test_power_countdown_lifecycle() {
        let ctrl = PowerCountdownController::new();
        assert!(!ctrl.status().active);
        ctrl.cancel();
        assert_eq!(ctrl.status().seconds_remaining, 0);
    }
}
