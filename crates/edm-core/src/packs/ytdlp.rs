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

fn parse_eta_secs(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() || s == "NA" || s == "Unknown" || s == "N/A" {
        return None;
    }
    if let Ok(secs) = s.parse::<u64>() {
        return Some(secs);
    }
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let m = parts[0].parse::<u64>().ok()?;
            let sec = parts[1].parse::<u64>().ok()?;
            Some(m * 60 + sec)
        }
        3 => {
            let h = parts[0].parse::<u64>().ok()?;
            let m = parts[1].parse::<u64>().ok()?;
            let sec = parts[2].parse::<u64>().ok()?;
            Some(h * 3600 + m * 60 + sec)
        }
        _ => None,
    }
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

    /// Ensure yt-dlp binary is available, auto-bootstrapping to %LOCALAPPDATA%\EDM\tools\yt-dlp.exe if missing
    pub async fn ensure_binary() -> Option<PathBuf> {
        if let Some(p) = Self::locate_binary() {
            return Some(p);
        }

        #[cfg(windows)]
        {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                let tools_dir = PathBuf::from(&local_app_data).join("EDM").join("tools");
                let target_exe = tools_dir.join("yt-dlp.exe");
                if target_exe.exists() {
                    return Some(target_exe);
                }

                if tokio::fs::create_dir_all(&tools_dir).await.is_ok() {
                    let download_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
                    let client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(45))
                        .user_agent("EDM-Tools-Bootstrap/1.0")
                        .build();
                    if let Ok(client) = client {
                        if let Ok(resp) = client.get(download_url).send().await {
                            if resp.status().is_success() {
                                if let Ok(bytes) = resp.bytes().await {
                                    let tmp_exe = tools_dir.join("yt-dlp.tmp");
                                    if tokio::fs::write(&tmp_exe, bytes).await.is_ok() {
                                        let _ = tokio::fs::rename(&tmp_exe, &target_exe).await;
                                        if target_exe.exists() {
                                            return Some(target_exe);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Self::locate_binary()
    }

    /// Detect ffmpeg binary location (prioritizing local EDM tools, WinGet, and PATH)
    pub fn locate_ffmpeg() -> Option<PathBuf> {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(&local_app_data)
                .join("EDM")
                .join("tools")
                .join("ffmpeg.exe");
            if p.exists() {
                return Some(p);
            }

            // Check WinGet Packages (e.g. Gyan.FFmpeg)
            let winget_dir = PathBuf::from(&local_app_data)
                .join("Microsoft")
                .join("WinGet")
                .join("Packages");
            if winget_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&winget_dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        if name.contains("ffmpeg") {
                            let candidate_bin = entry.path().join("ffmpeg.exe");
                            if candidate_bin.exists() {
                                return Some(candidate_bin);
                            }
                            if let Ok(subentries) = std::fs::read_dir(entry.path()) {
                                for sub in subentries.flatten() {
                                    let c1 = sub.path().join("bin").join("ffmpeg.exe");
                                    if c1.exists() {
                                        return Some(c1);
                                    }
                                    let c2 = sub.path().join("ffmpeg.exe");
                                    if c2.exists() {
                                        return Some(c2);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Ok(path_var) = std::env::var("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let candidate = entry.join("ffmpeg.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                #[cfg(not(windows))]
                {
                    let unix_candidate = entry.join("ffmpeg");
                    if unix_candidate.exists() {
                        return Some(unix_candidate);
                    }
                }
            }
        }

        #[cfg(windows)]
        {
            let common_paths = [
                r"C:\ffmpeg\bin\ffmpeg.exe",
                r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
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

    /// Extract media metadata, title, thumbnail, and stream formats via JSON dump
    pub async fn extract_info(url: &str) -> Result<MediaMetadata, String> {
        let bin =
            Self::locate_binary().ok_or_else(|| "yt-dlp binary not found on system".to_string())?;

        let mut args = vec![
            "--dump-json".to_string(),
            "--no-playlist".to_string(),
            "--skip-download".to_string(),
        ];

        if let Some(node_path) = Self::locate_node() {
            args.push("--js-runtimes".to_string());
            args.push(format!("node:{}", node_path.to_string_lossy()));
        }

        if let Some(ffmpeg_path) = Self::locate_ffmpeg() {
            args.push("--ffmpeg-location".to_string());
            let loc = ffmpeg_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ffmpeg_path.to_string_lossy().to_string());
            args.push(loc);
        }

        if url.contains("youtube.com") || url.contains("youtu.be") {
            args.push("--extractor-args".to_string());
            args.push("youtube:player_client=android_vr,android,web".to_string());
        }

        args.push(url.to_string());

        let mut cmd = configure_hidden_command(bin, &args);
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONUTF8", "1");
        let output = cmd
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
        let bin = Self::ensure_binary().await
            .ok_or_else(|| "yt-dlp binary could not be located or downloaded".to_string())?;

        let target_name = if !task.filename.is_empty()
            && task.filename != "download"
            && task.filename != "download.bin"
        {
            let sanitized = crate::sanitizer::Sanitizer::sanitize_filename(&task.filename);
            let safe_name = sanitized.replace('%', "%%");
            let ext = safe_name.rsplit('.').next().unwrap_or("mp4");
            if ext == "mp4" || ext == "mkv" || ext == "webm" || ext == "mp3" || ext == "m4a" {
                format!("{}.%(ext)s", safe_name.trim_end_matches(&format!(".{}", ext)))
            } else {
                format!("{}.%(ext)s", safe_name)
            }
        } else {
            "%(title)s.%(ext)s".to_string()
        };

        let out_template = task.save_dir.join(target_name);
        let out_template_str = out_template.to_string_lossy().to_string();

        let mut args = vec![
            "--newline".to_string(),
            "--progress".to_string(),
            "--no-playlist".to_string(),
            "--print".to_string(),
            "before_dl:EDM_INFO:%(filesize,filesize_approx)s|%(requested_formats.0.filesize,requested_formats.0.filesize_approx)s|%(requested_formats.1.filesize,requested_formats.1.filesize_approx)s".to_string(),
            "--progress-template".to_string(),
            "download:EDM_PROG:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress.eta)s".to_string(),
            "--print".to_string(),
            "after_move:EDM_FINAL:%(filepath)s".to_string(),
            "--print".to_string(),
            "after_video:EDM_FINAL:%(filepath)s".to_string(),
            "-o".to_string(),
            out_template_str,
        ];

        let ffmpeg_opt = Self::locate_ffmpeg();
        if let Some(ref ffmpeg_path) = ffmpeg_opt {
            args.push("--ffmpeg-location".to_string());
            let loc = ffmpeg_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ffmpeg_path.to_string_lossy().to_string());
            args.push(loc);
        }

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
                if ffmpeg_opt.is_some() {
                    args.push(format!("bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"));
                    args.push("--merge-output-format".to_string());
                    args.push("mp4".to_string());
                } else {
                    args.push(format!("best[height<={h}][ext=mp4]/best[height<={h}]/best"));
                }
            } else {
                args.push("-f".to_string());
                if ffmpeg_opt.is_some() {
                    args.push("bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best".to_string());
                    args.push("--merge-output-format".to_string());
                    args.push("mp4".to_string());
                } else {
                    args.push("best[ext=mp4]/best".to_string());
                }
            }
        }

        if let Some(node_path) = Self::locate_node() {
            args.push("--js-runtimes".to_string());
            args.push(format!("node:{}", node_path.to_string_lossy()));
        }

        if let Some(ref cookies) = task.cookies {
            args.push("--add-header".to_string());
            args.push(format!("Cookie: {}", cookies));
        }

        if let Some(ref ua) = task.user_agent {
            args.push("--user-agent".to_string());
            args.push(ua.clone());
        }

        if clean_url.contains("youtube.com") || clean_url.contains("youtu.be") {
            args.push("--extractor-args".to_string());
            args.push("youtube:player_client=android_vr,android,web".to_string());
            args.push("--http-chunk-size".to_string());
            args.push("10M".to_string());
        }

        args.push(clean_url);

        let mut cmd = configure_hidden_command(bin, &args);
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONUTF8", "1");
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;
        let stdout = child.stdout.take().ok_or("Failed to capture yt-dlp stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture yt-dlp stderr")?;

        let cancelled = task.cancelled.clone();
        let download_id = task.id.to_string();
        let mut final_path: Option<PathBuf> = None;
        let mut stderr_lines = Vec::new();

        if let Some(ref cb) = telemetry_cb {
            cb(AdaptiveTelemetry {
                download_id: download_id.clone(),
                total_bytes: None,
                downloaded_bytes: 0,
                progress_pct: 0.0,
                instant_throughput_bps: 0,
                rolling_throughput_bps: 0,
                active_connections: 1,
                target_connections: 1,
                live_workers: 1,
                max_allowed_connections: 1,
                mode: AccelerationMode::Stable,
                eta_seconds: None,
                decision_reason: "Fetching video info...".to_string(),
                phase: Some("Resolving".to_string()),
                workers: vec![WorkerTelemetry {
                    idx: 0,
                    start: 0,
                    end: 0,
                    pos: 0,
                    bytes_downloaded: 0,
                    speed_bps: 0,
                    status: WorkerStatus::Connecting,
                    retry_count: 0,
                }],
                updated_at: Utc::now(),
            });
        }

        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        let mut highest_pct: f64 = 0.0;
        let mut current_stream: usize = 0;
        let mut stream0_total: u64 = 0;
        let mut stream1_total: u64 = 0;
        let mut stream0_done: u64 = 0;
        let mut stream1_done: u64 = 0;
        let is_dual_stream = !is_audio && ffmpeg_opt.is_some();
        let mut merge_ticks: u32 = 0;
        let mut combined_total_reported: u64 = 0;
        let mut combined_done_reported: u64 = 0;

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
                            } else if line.starts_with("[download] Destination:") {
                                let path_str = line.trim_start_matches("[download] Destination:").trim();
                                if !path_str.is_empty() {
                                    final_path = Some(PathBuf::from(path_str));
                                }
                                if is_dual_stream && stream0_done > 0 {
                                    current_stream = 1;
                                }
                            } else if line.starts_with("EDM_INFO:") {
                                let payload = line.trim_start_matches("EDM_INFO:").trim();
                                let parts: Vec<&str> = payload.split('|').collect();
                                let tot_val = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                                let vid_val = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                                let aud_val = parts.get(2).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

                                if vid_val > 0 { stream0_total = vid_val; }
                                if aud_val > 0 { stream1_total = aud_val; }
                                let calc_tot = if stream0_total > 0 && stream1_total > 0 {
                                    stream0_total + stream1_total
                                } else if tot_val > 0 {
                                    tot_val
                                } else {
                                    stream0_total
                                };

                                if calc_tot > 0 {
                                    combined_total_reported = calc_tot;
                                    if let Some(ref cb) = telemetry_cb {
                                        cb(AdaptiveTelemetry {
                                            download_id: download_id.clone(),
                                            total_bytes: Some(calc_tot),
                                            downloaded_bytes: 0,
                                            progress_pct: 0.0,
                                            instant_throughput_bps: 0,
                                            rolling_throughput_bps: 0,
                                            active_connections: 1,
                                            target_connections: 1,
                                            live_workers: 1,
                                            max_allowed_connections: 1,
                                            mode: AccelerationMode::Stable,
                                            eta_seconds: None,
                                            decision_reason: if is_dual_stream { "Downloading video stream...".to_string() } else { "Downloading media stream...".to_string() },
                                            phase: Some(if is_dual_stream { "DownloadingVideo".to_string() } else { "Downloading".to_string() }),
                                            workers: vec![WorkerTelemetry {
                                                idx: 0,
                                                start: 0,
                                                end: calc_tot,
                                                pos: 0,
                                                bytes_downloaded: 0,
                                                speed_bps: 0,
                                                status: WorkerStatus::Downloading,
                                                retry_count: 0,
                                            }],
                                            updated_at: Utc::now(),
                                        });
                                    }
                                }
                            } else if line.starts_with("post_process:EDM_POST:") {
                                let status_val = line.trim_start_matches("post_process:EDM_POST:").trim();
                                if status_val == "finished" && is_dual_stream && current_stream == 0 {
                                    current_stream = 1;
                                }
                            } else if line.contains("[Merger]") || line.contains("Merging formats") || line.contains("[ffmpeg]") {
                                merge_ticks = merge_ticks.saturating_add(1);
                                let merge_pct = (90.0 + (merge_ticks as f64 * 1.5).min(9.0)).clamp(90.0, 99.0);
                                highest_pct = highest_pct.max(merge_pct);
                                let combined_total = if stream0_total > 0 && stream1_total > 0 {
                                    stream0_total + stream1_total
                                } else if stream0_total > 0 {
                                    stream0_total + (stream0_total as f64 * 0.12) as u64
                                } else {
                                    combined_total_reported
                                };
                                let combined_done = if combined_total > 0 {
                                    (combined_total as f64 * (highest_pct / 100.0)) as u64
                                } else {
                                    stream0_done + stream1_done
                                };
                                combined_total_reported = combined_total;
                                combined_done_reported = combined_done;

                                if let Some(ref cb) = telemetry_cb {
                                    cb(AdaptiveTelemetry {
                                        download_id: download_id.clone(),
                                        total_bytes: if combined_total > 0 { Some(combined_total) } else { None },
                                        downloaded_bytes: combined_done,
                                        progress_pct: highest_pct,
                                        instant_throughput_bps: 0,
                                        rolling_throughput_bps: 0,
                                        active_connections: 1,
                                        target_connections: 1,
                                        live_workers: 1,
                                        max_allowed_connections: 1,
                                        mode: AccelerationMode::Stable,
                                        eta_seconds: Some(2),
                                        decision_reason: "Merging video and audio streams with FFmpeg...".to_string(),
                                        phase: Some("Merging".to_string()),
                                        workers: vec![WorkerTelemetry {
                                            idx: 0,
                                            start: 0,
                                            end: combined_total,
                                            pos: combined_done,
                                            bytes_downloaded: combined_done,
                                            speed_bps: 0,
                                            status: WorkerStatus::Downloading,
                                            retry_count: 0,
                                        }],
                                        updated_at: Utc::now(),
                                    });
                                }
                            } else if line.starts_with("EDM_PROG:") {
                                let payload = line.trim_start_matches("EDM_PROG:").trim();
                                let parts: Vec<&str> = payload.split('|').collect();
                                if parts.len() >= 6 {
                                    let pct_str = parts[0].trim().trim_end_matches('%');
                                    let raw_pct = pct_str.parse::<f64>().unwrap_or(0.0);
                                    let parsed_done = parts[1].trim().parse::<u64>().unwrap_or(0);
                                    let parsed_total = parts[2]
                                        .trim()
                                        .parse::<u64>()
                                        .or_else(|_| parts[3].trim().parse::<u64>())
                                        .unwrap_or(0);
                                    let speed_str = parts[4].trim();
                                    let speed_bps = parse_speed_str(speed_str);
                                    let eta_str = parts[5].trim();
                                    let raw_eta = parse_eta_secs(eta_str);

                                    // Transition detection for dual streams (video stream complete -> audio stream start)
                                    if is_dual_stream && current_stream == 0 && raw_pct < 10.0 && highest_pct > 35.0 {
                                        current_stream = 1;
                                    }

                                    let (current_phase, overall_pct, combined_done, combined_total, effective_eta, status_desc) = if is_dual_stream {
                                        if current_stream == 0 {
                                            stream0_done = parsed_done;
                                            if parsed_total > 0 {
                                                stream0_total = parsed_total;
                                            }
                                            let tot = if stream0_total > 0 && stream1_total > 0 {
                                                stream0_total + stream1_total
                                            } else if stream0_total > 0 {
                                                stream0_total + (stream0_total as f64 * 0.12) as u64
                                            } else {
                                                combined_total_reported
                                            };
                                            let done = stream0_done;
                                            let mapped = if tot > 0 {
                                                (done as f64 / tot as f64 * 90.0).clamp(0.0, 90.0)
                                            } else {
                                                (raw_pct * 0.48).clamp(0.0, 48.0)
                                            };
                                            highest_pct = highest_pct.max(mapped);
                                            let eta = raw_eta.map(|e| e + (e as f64 * 0.15) as u64 + 2);
                                            let desc = format!("Downloading Video Stream: {:.1}% ({})", raw_pct, speed_str);
                                            ("DownloadingVideo", highest_pct, done, tot, eta, desc)
                                        } else {
                                            stream1_done = parsed_done;
                                            if parsed_total > 0 {
                                                stream1_total = parsed_total;
                                            }
                                            let tot = if stream0_total > 0 && stream1_total > 0 {
                                                stream0_total + stream1_total
                                            } else if stream0_total > 0 {
                                                stream0_total + (stream0_total as f64 * 0.12) as u64
                                            } else {
                                                combined_total_reported
                                            };
                                            let done = stream0_total + stream1_done;
                                            let mapped = if tot > 0 {
                                                (done as f64 / tot as f64 * 90.0).clamp(0.0, 90.0)
                                            } else {
                                                (48.0 + (raw_pct * 0.42)).clamp(48.0, 90.0)
                                            };
                                            highest_pct = highest_pct.max(mapped);
                                            let eta = raw_eta.map(|e| e + 2);
                                            let desc = format!("Downloading Audio Stream: {:.1}% ({})", raw_pct, speed_str);
                                            ("DownloadingAudio", highest_pct, done, tot, eta, desc)
                                        }
                                    } else {
                                        stream0_done = parsed_done;
                                        if parsed_total > 0 {
                                            stream0_total = parsed_total;
                                        }
                                        let mapped = (raw_pct * 0.92).clamp(0.0, 92.0);
                                        highest_pct = highest_pct.max(mapped);
                                        let desc = format!("Downloading Media: {:.1}% ({})", raw_pct, speed_str);
                                        ("Downloading", highest_pct, stream0_done, stream0_total, raw_eta, desc)
                                    };

                                    combined_total_reported = combined_total;
                                    combined_done_reported = combined_done;

                                    if let Some(ref cb) = telemetry_cb {
                                        cb(AdaptiveTelemetry {
                                            download_id: download_id.clone(),
                                            total_bytes: if combined_total > 0 { Some(combined_total) } else { None },
                                            downloaded_bytes: combined_done,
                                            progress_pct: overall_pct,
                                            instant_throughput_bps: speed_bps,
                                            rolling_throughput_bps: speed_bps,
                                            active_connections: 1,
                                            target_connections: 1,
                                            live_workers: 1,
                                            max_allowed_connections: 1,
                                            mode: AccelerationMode::Stable,
                                            eta_seconds: effective_eta,
                                            decision_reason: status_desc,
                                            phase: Some(current_phase.to_string()),
                                            workers: vec![WorkerTelemetry {
                                                idx: 0,
                                                start: 0,
                                                end: combined_total,
                                                pos: combined_done,
                                                bytes_downloaded: combined_done,
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
                        let trimmed = line.trim();
                        if trimmed.starts_with("[download] Destination:") {
                            let path_str = trimmed.trim_start_matches("[download] Destination:").trim();
                            if !path_str.is_empty() {
                                final_path = Some(PathBuf::from(path_str));
                            }
                            if is_dual_stream && stream0_done > 0 {
                                current_stream = 1;
                            }
                        } else if trimmed.contains("[Merger]") || trimmed.contains("Merging formats") || trimmed.contains("[ffmpeg]") {
                            merge_ticks = merge_ticks.saturating_add(1);
                            let merge_pct = (90.0 + (merge_ticks as f64 * 1.5).min(9.0)).clamp(90.0, 99.0);
                            highest_pct = highest_pct.max(merge_pct);
                            if let Some(ref cb) = telemetry_cb {
                                cb(AdaptiveTelemetry {
                                    download_id: download_id.clone(),
                                    total_bytes: if combined_total_reported > 0 { Some(combined_total_reported) } else { None },
                                    downloaded_bytes: combined_done_reported,
                                    progress_pct: highest_pct,
                                    instant_throughput_bps: 0,
                                    rolling_throughput_bps: 0,
                                    active_connections: 1,
                                    target_connections: 1,
                                    live_workers: 1,
                                    max_allowed_connections: 1,
                                    mode: AccelerationMode::Stable,
                                    eta_seconds: Some(1),
                                    decision_reason: "Merging video and audio streams with FFmpeg...".to_string(),
                                    phase: Some("Merging".to_string()),
                                    workers: vec![WorkerTelemetry {
                                        idx: 0,
                                        start: 0,
                                        end: combined_total_reported,
                                        pos: combined_done_reported,
                                        bytes_downloaded: combined_done_reported,
                                        speed_bps: 0,
                                        status: WorkerStatus::Downloading,
                                        retry_count: 0,
                                    }],
                                    updated_at: Utc::now(),
                                });
                            }
                        }
                        if !trimmed.is_empty() {
                            stderr_lines.push(line);
                        }
                    }
                }
            }
        }

        let status = child.wait().await.map_err(|e| format!("Failed to wait for yt-dlp: {}", e))?;
        if !status.success() {
            let last_errs = stderr_lines.join("\n");
            return Err(format!("yt-dlp download failed: {}", last_errs));
        }

        // Strict Completion Gate: Verify target file exists and has size > 0
        let target_file = if let Some(ref fp) = final_path {
            if fp.exists() {
                Some(fp.clone())
            } else {
                None
            }
        } else {
            let fallback = task.save_dir.join(&task.filename);
            if fallback.exists() {
                Some(fallback)
            } else {
                None
            }
        };

        let target_file = match target_file {
            Some(tf) => tf,
            None => {
                let mut found = None;
                if let Ok(entries) = std::fs::read_dir(&task.save_dir) {
                    let stem = std::path::Path::new(&task.filename).file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(file_name) = p.file_name().and_then(|n| n.to_str()) {
                                if !stem.is_empty() && file_name.starts_with(stem) && !file_name.ends_with(".part") && !file_name.ends_with(".ytdl") {
                                    found = Some(p);
                                    break;
                                }
                            }
                        }
                    }
                }
                found.ok_or_else(|| "Download failed: output file not found on disk".to_string())?
            }
        };

        let file_size = std::fs::metadata(&target_file).map(|m| m.len()).unwrap_or(0);
        if file_size == 0 {
            return Err("Download failed: 0 bytes received or merge failed".to_string());
        }

        // Emit final 100% telemetry only after verified on disk with size > 0
        if let Some(ref cb) = telemetry_cb {
            cb(AdaptiveTelemetry {
                download_id: download_id.clone(),
                total_bytes: Some(file_size),
                downloaded_bytes: file_size,
                progress_pct: 100.0,
                instant_throughput_bps: 0,
                rolling_throughput_bps: 0,
                active_connections: 0,
                target_connections: 0,
                live_workers: 0,
                max_allowed_connections: 1,
                mode: AccelerationMode::Stable,
                eta_seconds: Some(0),
                decision_reason: "Download & Processing Complete ✓".to_string(),
                phase: Some("Completed".to_string()),
                workers: vec![],
                updated_at: Utc::now(),
            });
        }

        Ok(target_file)
    }
}
