use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size: u64,
    pub html_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OtaProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub status: String,
}

#[derive(Deserialize, Debug)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Deserialize, Debug)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: String,
    assets: Vec<GhAsset>,
}

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let clean = v.trim().trim_start_matches('v').trim_start_matches('V');
    let mut parts = clean.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.split(['-', '+']).next()?.parse().ok()?;
    Some((major, minor, patch))
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let url = "https://api.github.com/repos/Suvesh108/EDM/releases/latest";

    let client = reqwest::Client::builder()
        .user_agent(format!("EDM/{} (Windows; x86_64)", current_version))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach update server: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Update check failed with HTTP {}", res.status()));
    }

    let body = res
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let release: GhRelease = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse release payload: {}", e))?;

    let raw_tag = release.tag_name.trim();
    let latest_version = raw_tag.trim_start_matches('v').trim_start_matches('V');
    let update_available = is_newer_version(latest_version, current_version);

    // Look for setup executable (.exe)
    let setup_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".exe") && a.name.to_lowercase().contains("setup"))
        .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")));

    let download_url = setup_asset.map(|a| a.browser_download_url.clone());
    let asset_name = setup_asset.map(|a| a.name.clone());
    let asset_size = setup_asset.map(|a| a.size).unwrap_or(0);

    Ok(UpdateCheckResult {
        current_version: current_version.to_string(),
        latest_version: latest_version.to_string(),
        update_available,
        release_name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at.unwrap_or_default(),
        download_url,
        asset_name,
        asset_size,
        html_url: release.html_url,
    })
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    download_url: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("EDM_Update_Installer.exe");

    let client = reqwest::Client::builder()
        .user_agent("EDM-OTA-Updater")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let res = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update installer: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Download failed with HTTP {}", res.status()));
    }

    let total_bytes = res.content_length().unwrap_or(0);
    use futures_util::StreamExt;
    let mut stream = res.bytes_stream();
    let mut file = tokio::fs::File::create(&installer_path)
        .await
        .map_err(|e| format!("Failed to create destination file: {}", e))?;

    let mut downloaded: u64 = 0;
    use tokio::io::AsyncWriteExt;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("File write error: {}", e))?;
        downloaded += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            (downloaded as f64 / total_bytes as f64) * 100.0
        } else {
            0.0
        };

        let _ = app.emit(
            "ota-progress",
            OtaProgress {
                downloaded_bytes: downloaded,
                total_bytes,
                percent,
                status: "downloading".to_string(),
            },
        );
    }

    file.flush()
        .await
        .map_err(|e| format!("File flush error: {}", e))?;
    drop(file);

    let _ = app.emit(
        "ota-progress",
        OtaProgress {
            downloaded_bytes: downloaded,
            total_bytes: downloaded,
            percent: 100.0,
            status: "ready".to_string(),
        },
    );

    // Launch installer detached
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        let mut cmd = std::process::Command::new(&installer_path);
        cmd.creation_flags(DETACHED_PROCESS);
        cmd.spawn()
            .map_err(|e| format!("Failed to launch update installer: {}", e))?;
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new(&installer_path)
            .spawn()
            .map_err(|e| format!("Failed to launch update installer: {}", e))?;
    }

    // Gracefully shut down EDM so the installer can replace files without conflict
    crate::trigger_graceful_quit(app, state.inner().clone());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_parsing_and_comparison() {
        assert_eq!(parse_version("v0.0.3"), Some((0, 0, 3)));
        assert_eq!(parse_version("0.0.3"), Some((0, 0, 3)));
        assert_eq!(parse_version("v1.2.34-rc1"), Some((1, 2, 34)));

        assert!(!is_newer_version("0.0.3", "0.0.3"));
        assert!(!is_newer_version("v0.0.3", "0.0.3"));
        assert!(!is_newer_version("0.0.2", "0.0.3"));
        assert!(is_newer_version("0.0.4", "0.0.3"));
        assert!(is_newer_version("0.1.0", "0.0.3"));
        assert!(is_newer_version("1.0.0", "0.0.3"));
    }
}
