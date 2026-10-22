use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub pre_allocated_threads: u32,
    pub auto_speed_boost: bool,
    pub download_path: String,
    pub duplicate_action: String, // "ask", "overwrite", "keep_both"
    pub proxy: Option<String>,
    pub browser_extension_enabled: bool,
    pub pair_token: String,
    pub speed_limit: u64, // 0 = unlimited, otherwise bytes/sec
    pub max_active_tasks: usize,

    // Category sorting rules
    pub auto_categorize: bool,

    // Windows integration flags
    pub protocol_vortex: bool,
    pub open_torrent: bool,
    pub open_magnet: bool,
    pub open_ed2k: bool,
    pub open_ftp: bool,
    pub open_m3u8: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        let default_download = dirs_download_dir();
        Self {
            pre_allocated_threads: 8,
            auto_speed_boost: true,
            download_path: default_download.to_string_lossy().to_string(),
            duplicate_action: "keep_both".to_string(),
            proxy: None,
            browser_extension_enabled: true,
            pair_token: "vortex-rpc-token-2026".to_string(),
            speed_limit: 0,
            max_active_tasks: 3,
            auto_categorize: true,
            protocol_vortex: true,
            open_torrent: true,
            open_magnet: true,
            open_ed2k: true,
            open_ftp: true,
            open_m3u8: true,
        }
    }
}

pub fn get_app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = PathBuf::from(appdata).join("VortexDownloader");
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let p = PathBuf::from(home).join(".vortexdownloader");
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    PathBuf::from(".")
}

pub fn get_db_path() -> PathBuf {
    let data_dir = get_app_data_dir().join("data");
    let _ = std::fs::create_dir_all(&data_dir);
    data_dir.join("vortex.db")
}

pub fn dirs_download_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(userprofile).join("Downloads");
            if p.exists() {
                return p;
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("Downloads");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(".")
}
