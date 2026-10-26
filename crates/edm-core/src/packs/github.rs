//! GitHub Releases & Accelerators Feature Pack (Native Rust Implementation)
//! Features: GitHub releases and accelerated mirror downloads, CDN proxy routing, asset checksums

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub size: u64,
    pub download_url: String,
    pub content_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub assets: Vec<GithubAsset>,
    pub tarball_url: Option<String>,
    pub zipball_url: Option<String>,
}

pub struct GithubPack;

impl GithubPack {
    /// Accelerated CDN mirror prefixes for GitHub raw and release downloads
    pub const MIRRORS: &'static [(&'static str, &'static str)] = &[
        ("ghproxy", "https://ghproxy.net/"),
        ("kgithub", "https://kgithub.com/"),
        ("gitclone", "https://gitclone.com/github.com/"),
    ];

    /// Rewrite a standard GitHub URL to an accelerated CDN mirror
    pub fn accelerate_url(url: &str, mirror_id: &str) -> String {
        let trimmed = url.trim();
        match mirror_id {
            "ghproxy" => format!("https://ghproxy.net/{}", trimmed),
            "kgithub" => trimmed.replace("github.com", "kgithub.com"),
            _ => trimmed.to_string(),
        }
    }

    /// Extract (owner, repo) from a GitHub URL
    pub fn parse_repo(url: &str) -> Option<(String, String)> {
        let parsed = url::Url::parse(url).ok()?;
        let host = parsed.host_str()?;
        if !host.contains("github.com") {
            return None;
        }

        let segments: Vec<&str> = parsed.path_segments()?.collect();
        if segments.len() >= 2 {
            Some((segments[0].to_string(), segments[1].to_string()))
        } else {
            None
        }
    }

    /// Fetch latest release assets directly from GitHub API in pure Rust
    pub async fn fetch_latest_release(
        client: &Client,
        owner: &str,
        repo: &str,
    ) -> Result<GithubRelease, String> {
        let api_url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("EDM-Engine/1.0"));

        let resp = client
            .get(&api_url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Failed to contact GitHub API: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("GitHub API returned HTTP status {}", resp.status()));
        }

        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read GitHub API response: {}", e))?;

        let val: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("Failed to parse GitHub release JSON: {}", e))?;

        let tag_name = val["tag_name"].as_str().unwrap_or("latest").to_string();
        let name = val["name"].as_str().map(|s| s.to_string());
        let published_at = val["published_at"].as_str().map(|s| s.to_string());
        let tarball_url = val["tarball_url"].as_str().map(|s| s.to_string());
        let zipball_url = val["zipball_url"].as_str().map(|s| s.to_string());

        let mut assets = Vec::new();
        if let Some(arr) = val["assets"].as_array() {
            for item in arr {
                let asset_name = item["name"].as_str().unwrap_or("asset").to_string();
                let size = item["size"].as_u64().unwrap_or(0);
                let download_url = item["browser_download_url"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let content_type = item["content_type"]
                    .as_str()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let created_at = item["created_at"].as_str().unwrap_or("").to_string();

                assets.push(GithubAsset {
                    name: asset_name,
                    size,
                    download_url,
                    content_type,
                    created_at,
                });
            }
        }

        Ok(GithubRelease {
            tag_name,
            name,
            published_at,
            assets,
            tarball_url,
            zipball_url,
        })
    }
}
