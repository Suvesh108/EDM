//! Hugging Face Models & Dataset Feature Pack (Native Rust Implementation)
//! Features: Hugging Face model and file downloads, Safetensors/GGUF multi-chunking, Git-LFS resolver

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModelTarget {
    pub repo_id: String,
    pub revision: String,
    pub file_path: String,
    pub direct_download_url: String,
    pub mirror_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLfsPointer {
    pub oid: String,
    pub size: u64,
}

pub struct HuggingFacePack;

impl HuggingFacePack {
    /// Accelerated CDN mirror for Hugging Face
    pub const HF_MIRROR_DOMAIN: &'static str = "hf-mirror.com";

    /// Parse Hugging Face model URL into repository, revision, and relative file path
    pub fn parse_target(url: &str) -> Option<HfModelTarget> {
        let clean = url.trim();
        let parsed = url::Url::parse(clean).ok()?;
        let host = parsed.host_str()?;

        if !host.contains("huggingface.co")
            && !host.contains("hf.co")
            && !host.contains("hf-mirror.com")
        {
            return None;
        }

        let segments: Vec<&str> = parsed.path_segments()?.collect();
        // Format: /<owner>/<repo>/resolve/<revision>/<file_path...> or /<owner>/<repo>/raw/<revision>/<file_path...>
        if segments.len() >= 4
            && (segments[2] == "resolve" || segments[2] == "raw" || segments[2] == "blob")
        {
            let repo_id = format!("{}/{}", segments[0], segments[1]);
            let revision = segments[3].to_string();
            let file_path = segments[4..].join("/");

            let direct_download_url = format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                repo_id, revision, file_path
            );
            let mirror_url = format!(
                "https://hf-mirror.com/{}/resolve/{}/{}",
                repo_id, revision, file_path
            );

            Some(HfModelTarget {
                repo_id,
                revision,
                file_path,
                direct_download_url,
                mirror_url,
            })
        } else {
            None
        }
    }

    /// Check if downloaded bytes represent a Git-LFS pointer stub file
    pub fn parse_git_lfs_pointer(content: &str) -> Option<GitLfsPointer> {
        if !content.starts_with("version https://git-lfs.github.com/spec/v1") {
            return None;
        }

        let mut oid = None;
        let mut size = None;

        for line in content.lines() {
            if let Some(sha) = line.strip_prefix("oid sha256:") {
                oid = Some(sha.trim().to_string());
            } else if let Some(s) = line.strip_prefix("size ") {
                size = s.trim().parse::<u64>().ok();
            }
        }

        if let (Some(o), Some(s)) = (oid, size) {
            Some(GitLfsPointer { oid: o, size: s })
        } else {
            None
        }
    }

    /// Build HTTP headers including optional Hugging Face access token for gated models
    pub fn build_auth_headers(api_token: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("EDM-Engine/1.0"));

        if let Some(token) = api_token {
            if !token.trim().is_empty() {
                let auth_val = format!("Bearer {}", token.trim());
                if let Ok(val) = HeaderValue::from_str(&auth_val) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        headers
    }
}
