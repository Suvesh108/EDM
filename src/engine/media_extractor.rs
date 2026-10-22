use regex::Regex;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFormat {
    pub format_id: String,
    pub quality: String, // "4K", "1080p", "720p", "audio_mp3", etc.
    pub ext: String,
    pub filesize: Option<i64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<i64>,
    pub thumbnail: Option<String>,
    pub formats: Vec<MediaFormat>,
    pub is_direct: bool,
}

pub fn is_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("youtube.com")
        || lower.contains("youtu.be")
        || lower.contains("tiktok.com")
        || lower.contains("vimeo.com")
        || lower.contains("instagram.com")
        || lower.contains("twitter.com")
        || lower.contains("x.com")
        || lower.contains("streamtape.com")
        || lower.contains("terabox.com")
        || lower.contains("doodstream")
        || lower.contains(".m3u8")
        || lower.contains(".mpd")
}

pub async fn extract_media_info(url: &str) -> Result<MediaMetadata, String> {
    // 1. Try yt-dlp first if available on system
    if let Ok(meta) = extract_with_ytdlp(url).await {
        return Ok(meta);
    }

    // 2. Direct host fallback
    if let Some(meta) = extract_direct_hosts(url).await {
        return Ok(meta);
    }

    Err("Could not extract media streams from URL".to_string())
}

async fn extract_with_ytdlp(url: &str) -> Result<MediaMetadata, String> {
    let url_clone = url.to_string();
    tokio::task::spawn_blocking(move || {
        let output = Command::new("yt-dlp")
            .arg("--dump-json")
            .arg("--no-warnings")
            .arg("--no-playlist")
            .arg(&url_clone)
            .output()
            .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

        if !output.status.success() {
            return Err("yt-dlp returned non-zero status".to_string());
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let val: serde_json::Value =
            serde_json::from_str(&json_str).map_err(|e| format!("JSON parse error: {}", e))?;

        let title = val["title"].as_str().unwrap_or("Media Stream").to_string();
        let uploader = val["uploader"].as_str().map(|s| s.to_string());
        let duration = val["duration"].as_i64();
        let thumbnail = val["thumbnail"].as_str().map(|s| s.to_string());

        let mut formats = Vec::new();
        if let Some(raw_formats) = val["formats"].as_array() {
            for f in raw_formats {
                let format_id = f["format_id"].as_str().unwrap_or("").to_string();
                let ext = f["ext"].as_str().unwrap_or("mp4").to_string();
                let height = f["height"].as_i64().unwrap_or(0);
                let vcodec = f["vcodec"].as_str().unwrap_or("none");
                let acodec = f["acodec"].as_str().unwrap_or("none");
                let direct_url = f["url"].as_str().map(|s| s.to_string());
                let filesize = f["filesize"].as_i64().or_else(|| f["filesize_approx"].as_i64());

                if height > 0 && vcodec != "none" {
                    let quality = match height {
                        h if h >= 2160 => "4K (2160p)",
                        h if h >= 1440 => "1440p QHD",
                        h if h >= 1080 => "1080p FHD",
                        h if h >= 720 => "720p HD",
                        h if h >= 480 => "480p",
                        _ => "360p",
                    };

                    formats.push(MediaFormat {
                        format_id,
                        quality: quality.to_string(),
                        ext,
                        filesize,
                        url: direct_url,
                    });
                } else if vcodec == "none" && acodec != "none" {
                    formats.push(MediaFormat {
                        format_id,
                        quality: "Audio (Best Quality)".to_string(),
                        ext: "mp3".to_string(),
                        filesize,
                        url: direct_url,
                    });
                }
            }
        }

        Ok(MediaMetadata {
            title,
            uploader,
            duration,
            thumbnail,
            formats,
            is_direct: false,
        })
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

async fn extract_direct_hosts(url: &str) -> Option<MediaMetadata> {
    // Quick fallback metadata for known hosts
    let re_domain = Regex::new(r"https?://(?:www\.)?([^/]+)").ok()?;
    let domain = re_domain.captures(url)?.get(1)?.as_str().to_string();

    Some(MediaMetadata {
        title: format!("Stream from {}", domain),
        uploader: Some(domain),
        duration: None,
        thumbnail: None,
        formats: vec![MediaFormat {
            format_id: "best".to_string(),
            quality: "Source Quality".to_string(),
            ext: "mp4".to_string(),
            filesize: None,
            url: Some(url.to_string()),
        }],
        is_direct: true,
    })
}
