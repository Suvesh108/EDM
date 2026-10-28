//! Native Vimeo Extractor (In-Process)

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use super::{ExtractedFormat, ExtractedMetadata, SiteExtractor};

pub struct VimeoExtractor;

impl VimeoExtractor {
    pub fn extract_video_id(url: &str) -> Option<String> {
        if let Ok(parsed) = url::Url::parse(url) {
            let host = parsed.host_str().unwrap_or("");
            if host.contains("vimeo.com") {
                let path = parsed.path().trim_matches('/');
                let id_candidate = path.split('/').next_back().unwrap_or("");
                if id_candidate.chars().all(|c| c.is_ascii_digit()) && !id_candidate.is_empty() {
                    return Some(id_candidate.to_string());
                }
            }
        }
        None
    }
}

#[async_trait]
impl SiteExtractor for VimeoExtractor {
    fn name(&self) -> &'static str {
        "Vimeo (Native In-Process)"
    }

    fn can_extract(&self, url: &str) -> bool {
        let u = url.to_ascii_lowercase();
        u.contains("vimeo.com")
    }

    async fn extract(&self, url: &str, client: &Client) -> Result<ExtractedMetadata, String> {
        let video_id = Self::extract_video_id(url)
            .ok_or_else(|| "Could not extract Vimeo video ID from URL".to_string())?;

        let config_url = format!("https://player.vimeo.com/video/{}/config", video_id);
        let resp = client
            .get(&config_url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/135.0",
            )
            .send()
            .await
            .map_err(|e| format!("Failed to reach Vimeo config API: {}", e))?;

        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read Vimeo config body: {}", e))?;

        let val: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse Vimeo config JSON: {}", e))?;

        let title = val["video"]["title"]
            .as_str()
            .unwrap_or("Vimeo Video")
            .to_string();
        let uploader = val["video"]["owner"]["name"]
            .as_str()
            .map(|s| s.to_string());
        let duration_secs = val["video"]["duration"].as_f64();
        let thumbnail_url = val["video"]["thumbs"]["base"]
            .as_str()
            .or_else(|| val["video"]["thumbs"]["640"].as_str())
            .map(|s| s.to_string());

        let mut formats = Vec::new();

        if let Some(files) = val["request"]["files"]["progressive"].as_array() {
            for f in files {
                if let Some(stream_url) = f["url"].as_str() {
                    let quality = f["quality"].as_str().unwrap_or("HD");
                    formats.push(ExtractedFormat {
                        format_id: quality.to_string(),
                        ext: "mp4".to_string(),
                        url: stream_url.to_string(),
                        resolution: Some(quality.to_string()),
                        filesize: None,
                        is_video: true,
                        is_audio: true,
                        vcodec: Some("h264".into()),
                        acodec: Some("aac".into()),
                    });
                }
            }
        }

        let best_stream_url = formats.last().map(|f| f.url.clone());

        if formats.is_empty() {
            return Err("No direct stream files found for Vimeo video".to_string());
        }

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
