//! Native Media Site Extractor Trait & Registry
//! Allows YouTube, Vimeo, and additional sites to be extracted in-process
//! without external yt-dlp dependencies.

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFormat {
    pub format_id: String,
    pub ext: String,
    pub url: String,
    pub resolution: Option<String>,
    pub filesize: Option<u64>,
    pub is_video: bool,
    pub is_audio: bool,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedMetadata {
    pub title: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub formats: Vec<ExtractedFormat>,
    pub best_stream_url: Option<String>,
}

#[async_trait]
pub trait SiteExtractor: Send + Sync {
    /// Name of the extractor (e.g. "YouTube", "Vimeo")
    fn name(&self) -> &'static str;

    /// Checks if this extractor can handle the given URL
    fn can_extract(&self, url: &str) -> bool;

    /// Perform in-process metadata and stream URL extraction
    async fn extract(&self, url: &str, client: &Client) -> Result<ExtractedMetadata, String>;
}

pub mod vimeo;
pub mod youtube;

pub use vimeo::VimeoExtractor;
pub use youtube::YouTubeExtractor;
