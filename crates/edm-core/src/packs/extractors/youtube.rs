//! Native YouTube Extractor (In-Process)
//! Uses the InnerTube WEB / ANDROID API client with zero external binaries.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use super::{ExtractedFormat, ExtractedMetadata, SiteExtractor};

pub struct YouTubeExtractor;

impl YouTubeExtractor {
    pub fn extract_video_id(url: &str) -> Option<String> {
        if let Ok(parsed) = url::Url::parse(url) {
            let host = parsed.host_str().unwrap_or("");
            if host.contains("youtube.com") {
                if parsed.path() == "/watch" {
                    for (k, v) in parsed.query_pairs() {
                        if k == "v" {
                            return Some(v.to_string());
                        }
                    }
                } else if parsed.path().starts_with("/shorts/") {
                    return parsed
                        .path()
                        .strip_prefix("/shorts/")
                        .map(|s| s.split('/').next().unwrap_or(s).to_string());
                } else if parsed.path().starts_with("/embed/") {
                    return parsed
                        .path()
                        .strip_prefix("/embed/")
                        .map(|s| s.split('/').next().unwrap_or(s).to_string());
                }
            } else if host == "youtu.be" {
                let path = parsed.path().trim_start_matches('/');
                if !path.is_empty() {
                    return Some(path.split('?').next().unwrap_or(path).to_string());
                }
            }
        }
        None
    }
}

#[async_trait]
impl SiteExtractor for YouTubeExtractor {
    fn name(&self) -> &'static str {
        "YouTube (Native In-Process)"
    }

    fn can_extract(&self, url: &str) -> bool {
        let u = url.to_ascii_lowercase();
        u.contains("youtube.com") || u.contains("youtu.be")
    }

    async fn extract(&self, url: &str, client: &Client) -> Result<ExtractedMetadata, String> {
        let video_id = Self::extract_video_id(url)
            .ok_or_else(|| "Could not extract YouTube video ID from URL".to_string())?;

        // Query InnerTube Android Client API endpoint (which serves direct cipher-free streaming URLs)
        let endpoint = "https://www.youtube.com/youtubei/v1/player";
        let body = serde_json::json!({
            "videoId": video_id,
            "context": {
                "client": {
                    "clientName": "ANDROID",
                    "clientVersion": "19.09.37",
                    "androidSdkVersion": 30,
                    "hl": "en",
                    "gl": "US"
                }
            }
        });

        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

        let resp = client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header(
                "User-Agent",
                "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
            )
            .body(body_str)
            .send()
            .await
            .map_err(|e| format!("Failed to connect to YouTube InnerTube API: {}", e))?;

        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read YouTube player body: {}", e))?;

        let json_val: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse YouTube player response: {}", e))?;

        let playability_status = json_val["playabilityStatus"]["status"]
            .as_str()
            .unwrap_or("");
        if playability_status != "OK" {
            let reason = json_val["playabilityStatus"]["reason"]
                .as_str()
                .unwrap_or("Video not playable or requires sign-in");
            return Err(format!("YouTube error: {}", reason));
        }

        let video_details = &json_val["videoDetails"];
        let title = video_details["title"]
            .as_str()
            .unwrap_or("YouTube Video")
            .to_string();
        let uploader = video_details["author"].as_str().map(|s| s.to_string());
        let duration_secs = video_details["lengthSeconds"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok());

        let thumbnail_url = video_details["thumbnail"]["thumbnails"]
            .as_array()
            .and_then(|arr| arr.last())
            .and_then(|t| t["url"].as_str())
            .map(|s| s.to_string());

        let mut formats = Vec::new();
        let streaming_data = &json_val["streamingData"];

        // 1. Check combined formats (video + audio)
        if let Some(muxed) = streaming_data["formats"].as_array() {
            for f in muxed {
                if let Some(direct_url) = f["url"].as_str() {
                    let itag = f["itag"].as_i64().unwrap_or(0).to_string();
                    let mime = f["mimeType"].as_str().unwrap_or("");
                    let ext = if mime.contains("mp4") {
                        "mp4"
                    } else if mime.contains("webm") {
                        "webm"
                    } else {
                        "mp4"
                    };
                    let resolution = f["qualityLabel"].as_str().map(|s| s.to_string());
                    let filesize = f["contentLength"]
                        .as_str()
                        .and_then(|s| s.parse::<u64>().ok());

                    formats.push(ExtractedFormat {
                        format_id: itag,
                        ext: ext.to_string(),
                        url: direct_url.to_string(),
                        resolution,
                        filesize,
                        is_video: true,
                        is_audio: true,
                        vcodec: Some(mime.to_string()),
                        acodec: Some(mime.to_string()),
                    });
                }
            }
        }

        // 2. Check adaptive formats (separate high-res video & HQ audio)
        if let Some(adaptive) = streaming_data["adaptiveFormats"].as_array() {
            for f in adaptive {
                if let Some(direct_url) = f["url"].as_str() {
                    let itag = f["itag"].as_i64().unwrap_or(0).to_string();
                    let mime = f["mimeType"].as_str().unwrap_or("");
                    let is_audio = mime.starts_with("audio/");
                    let is_video = mime.starts_with("video/");
                    let ext = if mime.contains("mp4") {
                        "mp4"
                    } else if mime.contains("webm") {
                        "webm"
                    } else if is_audio {
                        "m4a"
                    } else {
                        "mp4"
                    };
                    let resolution = f["qualityLabel"].as_str().map(|s| s.to_string());
                    let filesize = f["contentLength"]
                        .as_str()
                        .and_then(|s| s.parse::<u64>().ok());

                    formats.push(ExtractedFormat {
                        format_id: itag,
                        ext: ext.to_string(),
                        url: direct_url.to_string(),
                        resolution,
                        filesize,
                        is_video,
                        is_audio,
                        vcodec: if is_video {
                            Some(mime.to_string())
                        } else {
                            None
                        },
                        acodec: if is_audio {
                            Some(mime.to_string())
                        } else {
                            None
                        },
                    });
                }
            }
        }

        if formats.is_empty() {
            return Err(
                "No streamable URLs found for this YouTube video (may be DRM or geo-restricted)"
                    .to_string(),
            );
        }

        // Pick best muxed stream or first available
        let best_stream_url = formats
            .iter()
            .find(|f| f.is_video && f.is_audio)
            .or_else(|| formats.first())
            .map(|f| f.url.clone());

        Ok(ExtractedMetadata {
            title,
            uploader,
            duration_secs,
            thumbnail_url,
            formats,
            best_stream_url,
        })
    }
}
