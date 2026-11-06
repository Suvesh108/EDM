//! yt-dlp Video & Audio Extractor Feature Pack (Native Rust Implementation)
//! Features: YouTube and supported-site video/audio extraction, format listing, stream metadata

use super::process::configure_hidden_command;
use crate::adaptive::{
    AccelerationMode, AdaptiveDownloadTask, AdaptiveTelemetry, TelemetryCallback, WorkerStatus,
    WorkerTelemetry,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

fn parse_size_str(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() || s == "N/A" || s == "Unknown" {
        return 0;
    }
    let clean = s.trim_start_matches('~').trim();
    let (num_part, multiplier) = if clean.ends_with("GiB") {
        (clean.trim_end_matches("GiB").trim(), 1024.0 * 1024.0 * 1024.0)
    } else if clean.ends_with("GB") {
        (clean.trim_end_matches("GB").trim(), 1000.0 * 1000.0 * 1000.0)
    } else if clean.ends_with("MiB") {
        (clean.trim_end_matches("MiB").trim(), 1024.0 * 1024.0)
    } else if clean.ends_with("MB") {
        (clean.trim_end_matches("MB").trim(), 1000.0 * 1000.0)
    } else if clean.ends_with("KiB") {
        (clean.trim_end_matches("KiB").trim(), 1024.0)
    } else if clean.ends_with("KB") {
        (clean.trim_end_matches("KB").trim(), 1000.0)
    } else if clean.ends_with('B') {
        (clean.trim_end_matches('B').trim(), 1.0)
    } else {
        (clean, 1.0)
    };

    num_part.parse::<f64>().map(|n| (n * multiplier) as u64).unwrap_or(0)
}

fn parse_speed_str(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() || s == "N/A" || s == "Unknown" {
        return 0;
    }
    let clean = s.trim_end_matches("/s").trim();
    parse_size_str(clean).saturating_mul(8)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFormat {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub fps: Option<f64>,
    pub filesize: Option<u64>,
    pub url: Option<String>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub webpage_url: String,
    pub formats: Vec<MediaFormat>,
    pub best_video_url: Option<String>,
    pub best_audio_url: Option<String>,
}

pub struct YtDlpPack;

impl YtDlpPack {
    /// Detect Node.js binary location for solving YouTube JavaScript challenges
    pub fn locate_node() -> Option<PathBuf> {
        if let Ok(path_var) = std::env::var("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let candidate = entry.join("node.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                #[cfg(not(windows))]
                {
                    let unix_candidate = entry.join("node");
                    if unix_candidate.exists() {
                        return Some(unix_candidate);
                    }
                }
            }
        }
        #[cfg(windows)]
        {
            let common_paths = [
                r"C:\Program Files\nodejs\node.exe",
                r"C:\Program Files (x86)\nodejs\node.exe",
            ];
            for p in &common_paths {
                let pb = PathBuf::from(p);
                if pb.exists() {
                    return Some(pb);
                }
            }
        }
        None
    }

    /// Detect yt-dlp binary location (prioritizing local Python/EDM tools directories)
    pub fn locate_binary() -> Option<PathBuf> {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(&local_app_data)
                .join("EDM")
                .join("tools")
                .join("yt-dlp.exe");
            if p.exists() {
                return Some(p);
            }

            // Check standard Python Scripts directory
            let py_dir = PathBuf::from(&local_app_data).join("Programs").join("Python");
            if py_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(py_dir) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("Scripts").join("yt-dlp.exe");
                        if candidate.exists() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }

        if let Ok(path_var) = std::env::var("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let candidate = entry.join("yt-dlp.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                #[cfg(not(windows))]
                {
                    let unix_candidate = entry.join("yt-dlp");
                    if unix_candidate.exists() {
                        return Some(unix_candidate);
                    }
                }
            }
        }

        None
    }

    /// Extract media metadata, title, thumbnail, and stream formats via JSON dump
    pub async fn extract_info(url: &str) -> Result<MediaMetadata, String> {
        let bin =
            Self::locate_binary().ok_or_else(|| "yt-dlp binary not found on system".to_string())?;

        let mut args = vec![
            "--dump-json".to_string(),
            "--no-playlist".to_string(),
            "--skip-download".to_string(),
        ];

        if Self::locate_node().is_some() {
            args.push("--js-runtimes".to_string());
            args.push("node".to_string());
        }

        args.push(url.to_string());

        let output = configure_hidden_command(bin, &args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

        if !output.status.success() {
            let err_text = String::from_utf8_lossy(&output.stderr);
            return Err(format!("yt-dlp extraction error: {}", err_text.trim()));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let val: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse yt-dlp JSON: {}", e))?;

        let title = val["title"].as_str().unwrap_or("Media Stream").to_string();
        let uploader = val["uploader"].as_str().map(|s| s.to_string());
        let duration = val["duration"].as_f64();
        let thumbnail = val["thumbnail"].as_str().map(|s| s.to_string());
        let webpage_url = val["webpage_url"].as_str().unwrap_or(url).to_string();

        let mut formats = Vec::new();
        let mut best_video_url = None;
        let mut best_audio_url = None;

        if let Some(arr) = val["formats"].as_array() {
            for item in arr {
                let format_id = item["format_id"].as_str().unwrap_or("").to_string();
                let ext = item["ext"].as_str().unwrap_or("mp4").to_string();
                let resolution = item["resolution"].as_str().map(|s| s.to_string());
                let fps = item["fps"].as_f64();
                let filesize = item["filesize"]
                    .as_u64()
                    .or_else(|| item["filesize_approx"].as_u64());
                let item_url = item["url"].as_str().map(|s| s.to_string());
                let vcodec = item["vcodec"].as_str().map(|s| s.to_string());
                let acodec = item["acodec"].as_str().map(|s| s.to_string());

                if vcodec.as_deref() != Some("none") && item_url.is_some() {
                    best_video_url = item_url.clone();
                }
                if acodec.as_deref() != Some("none") && item_url.is_some() {
                    best_audio_url = item_url.clone();
                }

                formats.push(MediaFormat {
                    format_id,
                    ext,
                    resolution,
                    fps,
                    filesize,
                    url: item_url,
                    vcodec,
                    acodec,
                });
            }
        }

        Ok(MediaMetadata {
            title,
            uploader,
            duration,
            thumbnail,
            webpage_url,
            formats,
            best_video_url,
            best_audio_url,
        })
    }

    /// Downloads media with real-time progress parsing and AdaptiveTelemetry emission
    pub async fn download_media(
        task: AdaptiveDownloadTask,
        telemetry_cb: Option<TelemetryCallback>,
    ) -> Result<PathBuf, String> {
        let bin = Self::locate_binary()
            .ok_or_else(|| "yt-dlp binary not found on system".to_string())?;

        let target_name = if !task.filename.is_empty()
            && task.filename != "download"
            && task.filename != "download.bin"
        {
            let sanitized = crate::sanitizer::Sanitizer::sanitize_filename(&task.filename);
            let ext = sanitized.rsplit('.').next().unwrap_or("mp4");
            if ext == "mp4" || ext == "mkv" || ext == "webm" {
                format!("{}.%(ext)s", sanitized.trim_end_matches(&format!(".{}", ext)))
            } else {
                format!("{}.%(ext)s", sanitized)
            }
        } else {
            "%(title)s.%(ext)s".to_string()
        };

        let out_template = task.save_dir.join(target_name);
        let out_template_str = out_template.to_string_lossy().to_string();

        let mut args = vec![
            "--newline".to_string(),
            "--no-playlist".to_string(),
            "--progress-template".to_string(),
            "EDM_PROG:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._total_bytes_str)s|%(progress.eta)s".to_string(),
            "--print".to_string(),
            "after_move:EDM_FINAL:%(filepath)s".to_string(),
            "-o".to_string(),
            out_template_str,
        ];

        let clean_url = task.url.split('#').next().unwrap_or(&task.url).to_string();
        let is_audio = task.filename.ends_with(".mp3")
            || task.filename.ends_with(".m4a")
            || task.url.contains("#audio")
            || task.url.contains("audio_only=true");

        if is_audio {
            args.push("-x".to_string());
            args.push("--audio-format".to_string());
            if task.filename.ends_with(".m4a") || task.url.contains("#m4a") {
                args.push("m4a".to_string());
            } else {
                args.push("mp3".to_string());
            }
        } else {
            // Check for specific height requested, e.g. 1080p, 720p, 480p, 360p, 1440p, 2160p, 4k
            let height_pref = if task.url.contains("#1080p") || task.filename.contains("1080p") {
                Some("1080")
            } else if task.url.contains("#720p") || task.filename.contains("720p") {
                Some("720")
            } else if task.url.contains("#480p") || task.filename.contains("480p") {
                Some("480")
            } else if task.url.contains("#360p") || task.filename.contains("360p") {
                Some("360")
            } else if task.url.contains("#1440p") || task.filename.contains("1440p") {
                Some("1440")
            } else if task.url.contains("#2160p") || task.filename.contains("2160p") || task.url.contains("#4k") {
                Some("2160")
            } else {
                None
            };

            if let Some(h) = height_pref {
                args.push("-f".to_string());
                args.push(format!("bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"));
                args.push("--merge-output-format".to_string());
                args.push("mp4".to_string());
            } else {
                args.push("-f".to_string());
                args.push("bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best".to_string());
                args.push("--merge-output-format".to_string());
                args.push("mp4".to_string());
            }
        }

        if Self::locate_node().is_some() {
            args.push("--js-runtimes".to_string());
            args.push("node".to_string());
        }

        if let Some(ref cookies) = task.cookies {
            args.push("--add-header".to_string());
            args.push(format!("Cookie: {}", cookies));
        }

        if let Some(ref ua) = task.user_agent {
            args.push("--user-agent".to_string());
            args.push(ua.clone());
        }

        args.push(clean_url);

        let mut cmd = configure_hidden_command(bin, &args);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;
        let stdout = child.stdout.take().ok_or("Failed to capture yt-dlp stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture yt-dlp stderr")?;

        let cancelled = task.cancelled.clone();
        let download_id = task.id.to_string();
        let mut final_path: Option<PathBuf> = None;
        let mut stderr_lines = Vec::new();

        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = child.kill().await;
                return Err("Download cancelled by user".to_string());
            }

            tokio::select! {
                line_res = stdout_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            let line = line.trim();
                            if line.starts_with("EDM_FINAL:") {
                                let path_str = line.trim_start_matches("EDM_FINAL:").trim();
                                if !path_str.is_empty() {
                                    final_path = Some(PathBuf::from(path_str));
                                }
                            } else if line.starts_with("EDM_PROG:") {
                                let payload = line.trim_start_matches("EDM_PROG:").trim();
                                let parts: Vec<&str> = payload.split('|').collect();
                                if parts.len() >= 3 {
                                    let pct_str = parts[0].trim().trim_end_matches('%');
                                    let pct = pct_str.parse::<f64>().unwrap_or(0.0);
                                    let speed_str = parts[1].trim();
                                    let total_str = parts[2].trim();
                                    let eta_str = parts.get(3).map(|s| s.trim()).unwrap_or("");
                                    let eta_secs = eta_str.parse::<u64>().ok();

                                    let total_bytes = parse_size_str(total_str);
                                    let speed_bps = parse_speed_str(speed_str);
                                    let downloaded_bytes = if total_bytes > 0 {
                                        (total_bytes as f64 * (pct / 100.0)) as u64
                                    } else {
                                        0
                                    };

                                    if let Some(ref cb) = telemetry_cb {
                                        cb(AdaptiveTelemetry {
                                            download_id: download_id.clone(),
                                            total_bytes: if total_bytes > 0 { Some(total_bytes) } else { None },
                                            downloaded_bytes,
                                            progress_pct: pct,
                                            instant_throughput_bps: speed_bps,
                                            rolling_throughput_bps: speed_bps,
                                            active_connections: 1,
                                            target_connections: 1,
                                            live_workers: 1,
                                            max_allowed_connections: 1,
                                            mode: AccelerationMode::Stable,
                                            eta_seconds: eta_secs,
                                            decision_reason: format!("Media Extraction: {:.1}% ({})", pct, speed_str),
                                            workers: vec![WorkerTelemetry {
                                                idx: 0,
                                                start: 0,
                                                end: total_bytes,
                                                pos: downloaded_bytes,
                                                bytes_downloaded: downloaded_bytes,
                                                speed_bps,
                                                status: WorkerStatus::Downloading,
                                                retry_count: 0,
                                            }],
                                            updated_at: Utc::now(),
                                        });
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                err_res = stderr_reader.next_line() => {
                    if let Ok(Some(line)) = err_res {
                        if !line.trim().is_empty() {
                            stderr_lines.push(line);
                        }
                    }
                }
            }
        }

        let status = child.wait().await.map_err(|e| format!("Failed to wait for yt-dlp: {}", e))?;
        if !status.success() {
            let last_errs = stderr_lines.join("\n");
            if let Some(ref fp) = final_path {
                if fp.exists() {
                    return Ok(fp.clone());
                }
            }
            return Err(format!("yt-dlp download failed: {}", last_errs));
        }

        if let Some(fp) = final_path {
            if fp.exists() {
                return Ok(fp);
            }
        }

        let fallback_path = task.save_dir.join(&task.filename);
        if fallback_path.exists() {
            return Ok(fallback_path);
        }

        Ok(task.save_dir.join(format!("{}.mp4", task.filename)))
    }
}
