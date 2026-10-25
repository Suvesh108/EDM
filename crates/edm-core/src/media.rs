use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamVariant {
    pub quality: String,
    pub resolution: Option<String>,
    pub bandwidth: Option<u64>,
    pub url: String,
    pub is_drm_protected: bool,
}

pub struct MediaGrabber;

impl MediaGrabber {
    /// Inspects an HLS master playlist or DASH MPD manifest for DRM protection.
    /// In accordance with Section 5.12, Widevine, PlayReady, or FairPlay DRM
    /// MUST be detected and explicitly refused.
    pub fn is_drm_protected(manifest_content: &str) -> bool {
        let lower = manifest_content.to_ascii_lowercase();
        // Common DRM indicator tags in HLS and DASH
        lower.contains("widevine")
            || lower.contains("playready")
            || lower.contains("fairplay")
            || lower.contains("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed") // Widevine UUID
            || lower.contains("urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95") // PlayReady UUID
            || lower.contains("urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2") // FairPlay UUID
            || lower.contains("com.widevine.alpha")
            || lower.contains("com.microsoft.playready")
    }

    /// Parses an HLS (.m3u8) master playlist into available stream variants
    pub fn parse_hls_master(playlist: &str, base_url: &str) -> Result<Vec<StreamVariant>, String> {
        if Self::is_drm_protected(playlist) {
            return Err("This video is DRM-protected, EDM can't download it.".to_string());
        }

        let mut variants = Vec::new();
        let lines: Vec<&str> = playlist.lines().map(|l| l.trim()).collect();

        for i in 0..lines.len() {
            let line = lines[i];
            if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
                let mut resolution = None;
                let mut bandwidth = None;

                // Extract BANDWIDTH and RESOLUTION attributes
                for attr in attrs.split(',') {
                    let parts: Vec<&str> = attr.split('=').collect();
                    if parts.len() == 2 {
                        let key = parts[0].trim();
                        let val = parts[1].trim().trim_matches('"');
                        if key.eq_ignore_ascii_case("RESOLUTION") {
                            resolution = Some(val.to_string());
                        } else if key.eq_ignore_ascii_case("BANDWIDTH") {
                            bandwidth = val.parse::<u64>().ok();
                        }
                    }
                }

                // The next non-empty, non-comment line is the variant URL
                if let Some(url_line) = lines.get(i + 1) {
                    if !url_line.starts_with('#') && !url_line.is_empty() {
                        let full_url = if url_line.starts_with("http://")
                            || url_line.starts_with("https://")
                        {
                            url_line.to_string()
                        } else {
                            format!(
                                "{}/{}",
                                base_url.trim_end_matches('/'),
                                url_line.trim_start_matches('/')
                            )
                        };

                        let quality = resolution.clone().unwrap_or_else(|| {
                            if let Some(bw) = bandwidth {
                                format!("{} kbps", bw / 1000)
                            } else {
                                "Auto".to_string()
                            }
                        });

                        variants.push(StreamVariant {
                            quality,
                            resolution,
                            bandwidth,
                            url: full_url,
                            is_drm_protected: false,
                        });
                    }
                }
            }
        }

        Ok(variants)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drm_detection() {
        let drm_manifest = r#"
            #EXTM3U
            #EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
        "#;
        assert!(MediaGrabber::is_drm_protected(drm_manifest));
        let res = MediaGrabber::parse_hls_master(drm_manifest, "https://cdn.example.com");
        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err(),
            "This video is DRM-protected, EDM can't download it."
        );
    }

    #[test]
    fn test_hls_master_parse() {
        let plain_hls = r#"
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
            720p.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
            1080p.m3u8
        "#;
        let variants =
            MediaGrabber::parse_hls_master(plain_hls, "https://cdn.example.com/video").unwrap();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].quality, "1280x720");
        assert_eq!(variants[0].url, "https://cdn.example.com/video/720p.m3u8");
        assert_eq!(variants[1].quality, "1920x1080");
        assert_eq!(variants[1].url, "https://cdn.example.com/video/1080p.m3u8");
    }
}
