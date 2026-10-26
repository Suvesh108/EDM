//! yt-dlp Video & Audio Extractor Feature Pack (Native Rust Implementation)
//! Features: YouTube and supported-site video/audio extraction, format listing, stream metadata

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

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
    /// Detect yt-dlp binary location (prioritizing EDM local tools directory)
    pub fn locate_binary() -> Option<PathBuf> {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(local_app_data)
                .join("EDM")
                .join("tools")
                .join("yt-dlp.exe");
            if p.exists() {
                return Some(p);
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

        let output = Command::new(bin)
            .arg("--dump-json")
            .arg("--no-playlist")
            .arg("--skip-download")
            .arg(url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
}
