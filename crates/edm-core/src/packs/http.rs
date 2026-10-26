//! HTTP Feature Pack (Native Rust Implementation)
//! Features: HTTP/HTTPS downloads, smart chunking, resumable transfers

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_RANGES, CONTENT_LENGTH, RANGE};
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpProbeInfo {
    pub url: String,
    pub content_length: Option<u64>,
    pub supports_ranges: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub recommended_segments: u32,
}

pub struct HttpPack;

impl HttpPack {
    /// Probe HTTP endpoint for byte-range support, total file size, and optimal chunking
    pub async fn probe(client: &Client, url: &str) -> Result<HttpProbeInfo, String> {
        let resp = client
            .head(url)
            .send()
            .await
            .map_err(|e| format!("HTTP HEAD probe failed: {}", e))?;

        let headers = resp.headers();

        let content_length = headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());

        let supports_ranges = headers
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false);

        let etag = headers
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let last_modified = headers
            .get("last-modified")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let content_type = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let recommended_segments = if !supports_ranges {
            1
        } else {
            match content_length {
                Some(len) if len < 5 * 1024 * 1024 => 1,   // < 5MB
                Some(len) if len < 50 * 1024 * 1024 => 4,  // 5MB - 50MB
                Some(len) if len < 500 * 1024 * 1024 => 8, // 50MB - 500MB
                Some(_) => 16,                             // > 500MB
                None => 1,
            }
        };

        Ok(HttpProbeInfo {
            url: url.to_string(),
            content_length,
            supports_ranges,
            etag,
            last_modified,
            content_type,
            recommended_segments,
        })
    }

    /// Calculate dynamic byte ranges for parallel multi-stream chunk downloading
    pub fn calculate_chunk_ranges(total_size: u64, num_chunks: u32) -> Vec<(u64, u64)> {
        if num_chunks <= 1 || total_size == 0 {
            return vec![(0, total_size.saturating_sub(1))];
        }

        let chunk_size = total_size / (num_chunks as u64);
        let mut ranges = Vec::with_capacity(num_chunks as usize);

        for i in 0..num_chunks {
            let start = (i as u64) * chunk_size;
            let end = if i == num_chunks - 1 {
                total_size - 1
            } else {
                start + chunk_size - 1
            };
            ranges.push((start, end));
        }

        ranges
    }

    /// Build HTTP Range header for partial content retrieval
    pub fn build_range_header(start: u64, end: Option<u64>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let range_val = match end {
            Some(e) => format!("bytes={}-{}", start, e),
            None => format!("bytes={}-", start),
        };
        if let Ok(val) = HeaderValue::from_str(&range_val) {
            headers.insert(RANGE, val);
        }
        headers
    }
}
