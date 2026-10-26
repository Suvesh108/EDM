//! M3U8 / HLS Stream Feature Pack (Native Rust Implementation)
//! Features: HLS playlist and video-stream downloads, segment parsing, multi-bitrate selection

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlsSegment {
    pub index: usize,
    pub duration_secs: f64,
    pub url: String,
    pub key_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlsMediaPlaylist {
    pub target_duration: u32,
    pub media_sequence: u64,
    pub segments: Vec<HlsSegment>,
    pub total_duration_secs: f64,
    pub is_endlist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlsVariantStream {
    pub bandwidth: u64,
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub url: String,
}

pub struct M3u8Pack;

impl M3u8Pack {
    /// Detect if HLS stream contains DRM protection (Widevine, PlayReady, FairPlay)
    pub fn is_drm_protected(content: &str) -> bool {
        let lower = content.to_ascii_lowercase();
        lower.contains("widevine")
            || lower.contains("playready")
            || lower.contains("fairplay")
            || lower.contains("com.widevine.alpha")
            || lower.contains("com.microsoft.playready")
            || lower.contains("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")
    }

    /// Parse a master playlist containing multiple bandwidth/resolution variant streams
    pub fn parse_master_playlist(
        content: &str,
        base_url: &str,
    ) -> Result<Vec<HlsVariantStream>, String> {
        if Self::is_drm_protected(content) {
            return Err(
                "DRM-protected HLS stream detected: EDM does not download DRM encrypted media"
                    .into(),
            );
        }

        let mut variants = Vec::new();
        let lines: Vec<&str> = content.lines().map(|l| l.trim()).collect();

        for i in 0..lines.len() {
            let line = lines[i];
            if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
                let mut bandwidth = 0u64;
                let mut resolution = None;
                let mut codecs = None;

                for attr in attrs.split(',') {
                    let parts: Vec<&str> = attr.split('=').collect();
                    if parts.len() == 2 {
                        let k = parts[0].trim();
                        let v = parts[1].trim().trim_matches('"');
                        if k.eq_ignore_ascii_case("BANDWIDTH") {
                            bandwidth = v.parse::<u64>().unwrap_or(0);
                        } else if k.eq_ignore_ascii_case("RESOLUTION") {
                            resolution = Some(v.to_string());
                        } else if k.eq_ignore_ascii_case("CODECS") {
                            codecs = Some(v.to_string());
                        }
                    }
                }

                if let Some(url_line) = lines.get(i + 1) {
                    if !url_line.starts_with('#') && !url_line.is_empty() {
                        let full_url = Self::resolve_url(base_url, url_line);
                        variants.push(HlsVariantStream {
                            bandwidth,
                            resolution,
                            codecs,
                            url: full_url,
                        });
                    }
                }
            }
        }

        Ok(variants)
    }

    /// Parse a media playlist containing individual .ts or fMP4 video chunks
    pub fn parse_media_playlist(content: &str, base_url: &str) -> Result<HlsMediaPlaylist, String> {
        if Self::is_drm_protected(content) {
            return Err("DRM-protected media playlist detected".into());
        }

        let mut target_duration = 10;
        let mut media_sequence = 0u64;
        let mut is_endlist = false;
        let mut segments = Vec::new();
        let mut total_duration = 0.0;
        let mut current_key = None;

        let lines: Vec<&str> = content.lines().map(|l| l.trim()).collect();
        let mut current_segment_duration = 0.0;

        for line in lines {
            if line.starts_with("#EXT-X-TARGETDURATION:") {
                if let Some(val) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
                    target_duration = val.parse::<u32>().unwrap_or(10);
                }
            } else if line.starts_with("#EXT-X-MEDIA-SEQUENCE:") {
                if let Some(val) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                    media_sequence = val.parse::<u64>().unwrap_or(0);
                }
            } else if line.starts_with("#EXT-X-KEY:") {
                // Extract URI="key.bin"
                if let Some(uri_part) = line.split("URI=\"").nth(1) {
                    if let Some(key_path) = uri_part.split('"').next() {
                        current_key = Some(Self::resolve_url(base_url, key_path));
                    }
                }
            } else if line.starts_with("#EXTINF:") {
                if let Some(dur_str) = line
                    .strip_prefix("#EXTINF:")
                    .and_then(|s| s.split(',').next())
                {
                    current_segment_duration = dur_str.trim().parse::<f64>().unwrap_or(0.0);
                }
            } else if line.starts_with("#EXT-X-ENDLIST") {
                is_endlist = true;
            } else if !line.starts_with('#') && !line.is_empty() {
                let full_url = Self::resolve_url(base_url, line);
                let idx = segments.len();
                total_duration += current_segment_duration;
                segments.push(HlsSegment {
                    index: idx,
                    duration_secs: current_segment_duration,
                    url: full_url,
                    key_url: current_key.clone(),
                });
                current_segment_duration = 0.0;
            }
        }

        Ok(HlsMediaPlaylist {
            target_duration,
            media_sequence,
            segments,
            total_duration_secs: total_duration,
            is_endlist,
        })
    }

    /// Resolve relative path or URL against the base URL
    pub fn resolve_url(base: &str, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }
        let base_trimmed = base.trim_end_matches('/');
        let base_dir = if let Some(last_slash) = base_trimmed.rfind('/') {
            &base_trimmed[..last_slash]
        } else {
            base_trimmed
        };

        if path.starts_with('/') {
            // Absolute from host domain
            if let Ok(parsed) = url::Url::parse(base) {
                format!(
                    "{}://{}{}",
                    parsed.scheme(),
                    parsed.host_str().unwrap_or(""),
                    path
                )
            } else {
                format!("{}/{}", base_dir, path.trim_start_matches('/'))
            }
        } else {
            format!("{}/{}", base_dir, path)
        }
    }
}
