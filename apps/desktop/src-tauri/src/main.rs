// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Utc;
use edm_core::adaptive::{AdaptiveConfig, AdaptiveDownloadTask, AdaptiveEngine, AdaptiveTelemetry};
use edm_core::Probe;
use edm_ipc::{AppReply, DownloadOverview, DownloadState, ExtensionMessage, PROTOCOL_VERSION};
use edm_store::{DownloadRecord, Store};
use reqwest::Client;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{command, Manager, State};
use uuid::Uuid;

mod lifecycle;
mod updater;
mod ws_server;

#[derive(Clone)]
pub(crate) struct ActiveTaskHandle {
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) telemetry: Arc<Mutex<Option<AdaptiveTelemetry>>>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) store: Store,
    pub(crate) engine: Arc<AdaptiveEngine>,
    pub(crate) tasks: Arc<Mutex<HashMap<String, ActiveTaskHandle>>>,
    pub(crate) rt_handle: tokio::runtime::Handle,
    pub(crate) ws_manager: Arc<ws_server::WsManager>,
    pub(crate) tray_handle: Arc<Mutex<Option<tauri::tray::TrayIcon>>>,
    pub(crate) app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
    pub(crate) lifecycle: Arc<lifecycle::LifecycleManager>,
}

fn init_logging() {
    let log_dir = match std::env::var("APPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("logs"),
        Err(_) => std::env::temp_dir().join("EDM").join("logs"),
    };
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "edm.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(_guard));

    let subscriber = tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .finish();

    let _ = tracing::subscriber::set_global_default(subscriber);

    // Register panic hook
    std::panic::set_hook(Box::new(|info| {
        tracing::error!("PANIC DETECTED: {:?}", info);
        eprintln!("PANIC: {:?}", info);
    }));
}

fn get_db_path() -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("EDM");
        let _ = std::fs::create_dir_all(&p);
        p.join("store.db")
    } else {
        std::env::temp_dir().join("edm_store.db")
    }
}

fn open_persistent_store() -> Store {
    let path = get_db_path();
    Store::open(&path).unwrap_or_else(|_| Store::open_in_memory().unwrap())
}

#[cfg(windows)]
fn register_native_messaging_host() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let app_dir = match std::env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM"),
        Err(_) => std::env::temp_dir().join("EDM"),
    };
    let _ = std::fs::create_dir_all(&app_dir);

    let current_exe = std::env::current_exe().unwrap_or_default();
    let current_dir = current_exe.parent().unwrap_or(&app_dir);

    // Look for edm-nmh in current_dir, resources subfolder, or app_dir
    let candidates = [
        current_dir.join("edm-nmh.exe"),
        current_dir.join("resources").join("edm-nmh.exe"),
        app_dir.join("edm-nmh.exe"),
    ];

    let found_nmh = candidates
        .iter()
        .find(|p| p.exists() && p.is_file())
        .cloned();
    let target_nmh = app_dir.join("edm-nmh.exe");

    if let Some(ref src) = found_nmh {
        if src != &target_nmh {
            let _ = std::fs::copy(src, &target_nmh);
        }
    } else {
        tracing::warn!(
            "edm-nmh.exe not found next to current executable at {}",
            current_dir.display()
        );
    }

    let nmh_path = if target_nmh.exists() {
        target_nmh
    } else {
        found_nmh.unwrap_or_else(|| current_dir.join("edm-nmh.exe"))
    };

    let manifest_path = app_dir.join("com.edm.nmh.json");
    let manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Edge, Chrome and Brave",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [
            "chrome-extension://ginpdimhcdbojbhemgjedghkeolbcmgj/",
            "chrome-extension://ebdcbpghekpbgjiclaclbgmdnimeheci/",
            "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",
            "chrome-extension://cphjfljhggknldkppchfobogknclmblg/"
        ]
    });

    if let Ok(content) = serde_json::to_string_pretty(&manifest_json) {
        let _ = std::fs::write(&manifest_path, content);
    }

    // Mozilla Firefox manifest (allowed_extensions instead of allowed_origins)
    let ff_manifest_path = app_dir.join("com.edm.nmh.firefox.json");
    let ff_manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Mozilla Firefox",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": [
            "edm@suvesh.dev"
        ]
    });
    if let Ok(content) = serde_json::to_string_pretty(&ff_manifest_json) {
        let _ = std::fs::write(&ff_manifest_path, content);
    }

    let chromium_reg_targets = [
        r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh",
        r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh",
    ];

    for key in &chromium_reg_targets {
        let _ = std::process::Command::new("reg")
            .args([
                "add",
                &format!(r"HKCU\{}", key),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &manifest_path.to_string_lossy(),
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    // Register Firefox
    let _ = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Mozilla\NativeMessagingHosts\com.edm.nmh",
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            &ff_manifest_path.to_string_lossy(),
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn register_native_messaging_host() {}

fn validate_url_security(raw_url: &str) -> Result<url::Url, String> {
    let trimmed = raw_url.trim();
    let lower = trimmed.to_ascii_lowercase();

    // 1. BitTorrent Magnet URIs (handled by bittorrent_pack)
    if lower.starts_with("magnet:?") {
        return url::Url::parse(trimmed)
            .or_else(|_| {
                url::Url::parse(&format!(
                    "https://magnet.internal/?raw={}",
                    urlencoding::encode(trimmed)
                ))
            })
            .map_err(|e| format!("Invalid magnet URI: {}", e));
    }

    // 2. eDonkey2000 URIs (handled by ed2k_pack)
    if lower.starts_with("ed2k://") {
        return url::Url::parse(trimmed)
            .or_else(|_| {
                url::Url::parse(&format!(
                    "https://ed2k.internal/?raw={}",
                    urlencoding::encode(trimmed)
                ))
            })
            .map_err(|e| format!("Invalid eD2k URI: {}", e));
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|e| format!("Security violation: Invalid URL format: {}", e))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" && scheme != "ftp" && scheme != "ftps" {
        return Err(format!(
            "Security violation: Protocol '{}' is not supported",
            scheme
        ));
    }

    if let Some(host) = parsed.host_str() {
        let h = host.to_lowercase();
        if h == "169.254.169.254"
            || h == "metadata.google.internal"
            || h == "instance-data"
            || h.ends_with(".internal")
        {
            return Err("Security violation: Blocked access to cloud metadata endpoint".into());
        }
    }
    Ok(parsed)
}

fn open_file(save_dir: &str, filename: &str) {
    let file_path = PathBuf::from(save_dir).join(filename);
    if file_path.exists() {
        let ext = filename.split('.').next_back().unwrap_or("").to_lowercase();
        let is_executable = [
            "exe", "bat", "cmd", "scr", "vbs", "ps1", "msi", "reg", "com", "pif",
        ]
        .contains(&ext.as_str());
        if is_executable {
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", file_path.to_string_lossy()))
                .spawn();
        } else {
            let _ = std::process::Command::new("explorer.exe")
                .arg(file_path)
                .spawn();
        }
    }
}

fn open_folder(save_dir: &str, filename: &str) {
    let file_path = PathBuf::from(save_dir).join(filename);
    if file_path.exists() {
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", file_path.to_string_lossy()))
            .spawn();
    } else {
        let _ = std::process::Command::new("explorer.exe")
            .arg(save_dir)
            .spawn();
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_download(
    state: &AppState,
    id: Uuid,
    url: String,
    filename: Option<String>,
    save_dir: Option<PathBuf>,
    max_connections: Option<u32>,
    size_total: Option<u64>,
    cookies: Option<String>,
    referer: Option<String>,
    user_agent: Option<String>,
) -> Result<Uuid, String> {
    let lc = state.lifecycle.clone();
    state.rt_handle.spawn(async move {
        lc.record_activity().await;
    });
    validate_url_security(&url)?;
    let id_str = id.to_string();

    let pack_target = edm_core::FeaturePackManager::classify_target(&url);

    let raw_name = match filename {
        Some(ref f) if !f.trim().is_empty() && f != "download" && f != "download.bin" => f.clone(),
        _ => {
            if let Some(ref suggested) = pack_target.suggested_filename {
                suggested.clone()
            } else {
                let path_part = url
                    .split('/')
                    .next_back()
                    .unwrap_or("download.bin")
                    .split('?')
                    .next()
                    .unwrap_or("download.bin");
                if path_part.is_empty() || path_part == "download" || path_part == "download.bin" {
                    if let Ok(parsed) = url::Url::parse(&url) {
                        let mut found = None;
                        for (k, v) in parsed.query_pairs() {
                            if (k == "filename" || k == "file" || k == "title" || k == "name")
                                && !v.trim().is_empty()
                            {
                                found = Some(v.to_string());
                                break;
                            }
                        }
                        found.unwrap_or_else(|| "download.bin".to_string())
                    } else {
                        "download.bin".to_string()
                    }
                } else {
                    path_part.to_string()
                }
            }
        }
    };
    let clean_name = edm_core::sanitizer::Sanitizer::sanitize_filename(&raw_name);

    let save_path = save_dir.unwrap_or_else(|| {
        std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join("Downloads"))
            .unwrap_or_else(|_| std::env::temp_dir())
    });

    let resolved_path = edm_core::sanitizer::Sanitizer::resolve_duplicate(&save_path, &clean_name);
    let final_clean_name = resolved_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(clean_name);

    let mut config = AdaptiveConfig::default();
    if let Some(conns) = max_connections {
        config.max_connections = conns;
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let telemetry_store = Arc::new(Mutex::new(None));

    let handle = ActiveTaskHandle {
        cancelled: cancelled.clone(),
        telemetry: telemetry_store.clone(),
    };

    state.tasks.lock().unwrap().insert(id_str.clone(), handle);

    let ext = final_clean_name
        .split('.')
        .next_back()
        .unwrap_or("")
        .to_lowercase();
    let category = if pack_target.is_p2p {
        "Compressed"
    } else if pack_target.is_stream || ["mp4", "mkv", "webm", "avi", "mov"].contains(&ext.as_str())
    {
        "Video"
    } else if ["mp3", "flac", "wav", "aac"].contains(&ext.as_str()) {
        "Music"
    } else if ["zip", "rar", "7z", "tar", "gz", "iso"].contains(&ext.as_str()) {
        "Compressed"
    } else if ["pdf", "doc", "docx", "txt"].contains(&ext.as_str()) {
        "Documents"
    } else {
        "Programs"
    };

    let effective_size = size_total.or(pack_target.estimated_size);

    let record = DownloadRecord {
        id,
        url: url.clone(),
        final_url: None,
        filename: final_clean_name.clone(),
        save_dir: save_path.to_string_lossy().to_string(),
        category: category.into(),
        state: DownloadState::Downloading,
        size_total: effective_size,
        size_done: 0,
        resumable: true,
        etag: None,
        last_modified: None,
        content_type: None,
        referer: referer.clone(),
        user_agent: user_agent.clone(),
        connections: config.max_connections,
        created_at: Utc::now(),
        error_msg: None,
    };
    let _ = state.store.insert_download(&record);

    let ws_mgr = state.ws_manager.clone();
    let ws_id = id_str.clone();
    let ws_filename = final_clean_name.clone();
    let ws_savedir = save_path.clone();
    let ws_total = effective_size;
    state.rt_handle.spawn(async move {
        ws_mgr
            .register_task(
                ws_id,
                ws_filename,
                ws_savedir,
                ws_total,
                "downloading".into(),
            )
            .await;
    });

    let task = AdaptiveDownloadTask {
        id,
        url,
        filename: final_clean_name,
        save_dir: save_path,
        config,
        limiter: None,
        cancelled,
        cookies,
        referer,
        user_agent,
    };

    let engine = state.engine.clone();
    let telem_target = telemetry_store.clone();
    let store_clone = state.store.clone();
    let store_cb = state.store.clone();
    let ws_mgr_cb = state.ws_manager.clone();
    let ws_id_cb = id_str.clone();

    state.rt_handle.spawn(async move {
        let ws_mgr_tick = ws_mgr_cb.clone();
        let ws_id_tick = ws_id_cb.clone();
        let cb = Arc::new(move |telem: AdaptiveTelemetry| {
            if let Ok(mut lock) = telem_target.lock() {
                *lock = Some(telem.clone());
            }
            let _ = store_cb.update_download_progress(id, telem.downloaded_bytes);
            let ws_mgr = ws_mgr_tick.clone();
            let id_c = ws_id_tick.clone();
            let speed_bytes =
                (telem.rolling_throughput_bps / 8).max(telem.instant_throughput_bps / 8);
            tokio::spawn(async move {
                ws_mgr
                    .update_task_progress(
                        &id_c,
                        telem.downloaded_bytes,
                        telem.total_bytes,
                        speed_bytes,
                        "downloading",
                    )
                    .await;
            });
        });
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::limited(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0")
            .build()
            .unwrap_or_default();
        let result = edm_core::PackExecutor::execute(task, engine, client, Some(cb)).await;
        let (final_state, error_msg) = match result {
            Ok(_) => (DownloadState::Completed, None),
            Err(ref e) if e.contains("cancelled") => (DownloadState::Paused, None),
            Err(ref e) if e.contains("400") || e.contains("expired") => {
                (DownloadState::Failed, Some("Link expired or invalid (HTTP 400)"))
            }
            Err(ref e) if e.contains("403") => {
                (DownloadState::Failed, Some("HTTP 403 Forbidden"))
            }
            Err(ref e) if e.contains("410") => {
                (DownloadState::Failed, Some("HTTP 410 Gone (Link Expired)"))
            }
            Err(ref e) if e.contains("429") => {
                (DownloadState::Failed, Some("HTTP 429 Rate Limited"))
            }
            Err(ref e) if e.contains("stalled") => {
                (DownloadState::Failed, Some("Connection Stalled"))
            }
            Err(ref e) => (DownloadState::Failed, Some(e.as_str())),
        };
        let _ = store_clone.update_download_state(id, final_state, error_msg);

        let final_status_str = match &final_state {
            DownloadState::Completed => "completed".to_string(),
            DownloadState::Paused => "paused".to_string(),
            _ => "failed".to_string(),
        };
        let ws_mgr_fin = ws_mgr_cb.clone();
        let ws_id_fin = ws_id_cb.clone();
        let error_msg_owned = error_msg.map(String::from);
        let (final_done, final_total) = match store_clone.list_all_downloads() {
            Ok(records) => records
                .into_iter()
                .find(|d| d.id == id)
                .map(|d| (d.size_done, d.size_total))
                .unwrap_or((0, effective_size)),
            Err(_) => (0, effective_size),
        };
        tokio::spawn(async move {
            if final_state == DownloadState::Failed {
                ws_mgr_fin
                    .update_task_error(&ws_id_fin, error_msg_owned)
                    .await;
            } else {
                ws_mgr_fin
                    .update_task_progress(
                        &ws_id_fin,
                        final_done,
                        final_total,
                        0,
                        &final_status_str,
                    )
                    .await;
            }
        });
    });

    Ok(id)
}

async fn handle_extension_message(msg: ExtensionMessage, state: &AppState) -> AppReply {
    match msg {
        ExtensionMessage::Ping => AppReply::Pong,

        ExtensionMessage::Hello { .. } => AppReply::Settings {
            min_size: 1048576,
            take_over_extensions: vec![
                "zip".into(),
                "iso".into(),
                "exe".into(),
                "msi".into(),
                "7z".into(),
                "tar".into(),
                "gz".into(),
                "mp4".into(),
                "mkv".into(),
                "pdf".into(),
            ],
            excluded_domains: vec![],
        },

        ExtensionMessage::GetStatus => {
            let records = state.store.list_all_downloads().unwrap_or_default();
            let active = records
                .iter()
                .filter(|d| d.state == DownloadState::Downloading)
                .count();
            let queued = records
                .iter()
                .filter(|d| d.state == DownloadState::Queued)
                .count();
            let completed = records
                .iter()
                .filter(|d| d.state == DownloadState::Completed)
                .count();

            let mut agg_speed: u64 = 0;
            {
                let tasks = state.tasks.lock().unwrap();
                for r in &records {
                    if r.state == DownloadState::Downloading {
                        if let Some(h) = tasks.get(&r.id.to_string()) {
                            if let Ok(lock) = h.telemetry.lock() {
                                if let Some(ref telem) = *lock {
                                    agg_speed += telem.rolling_throughput_bps;
                                }
                            }
                        }
                    }
                }
            }

            AppReply::Status {
                status: "connected".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: PROTOCOL_VERSION,
                active_downloads: active,
                queued_tasks: queued,
                completed_tasks: completed,
                aggregate_speed_bps: agg_speed,
            }
        }

        ExtensionMessage::ListDownloads { filter } => {
            let records = state.store.list_all_downloads().unwrap_or_default();
            let filter_lower = filter.unwrap_or_else(|| "all".into()).to_lowercase();
            let mut overviews = Vec::new();
            let mut active_count = 0;
            let mut queued_count = 0;
            let mut completed_count = 0;
            let mut aggregate_speed = 0u64;

            let tasks = state.tasks.lock().unwrap();

            for r in records {
                let is_active = r.state == DownloadState::Downloading;
                let is_queued = r.state == DownloadState::Queued;
                let is_completed = r.state == DownloadState::Completed;

                let mut current_speed = 0u64;
                let mut current_done = r.size_done;
                let mut current_total = r.size_total;

                if is_active {
                    active_count += 1;
                    if let Some(h) = tasks.get(&r.id.to_string()) {
                        if let Ok(lock) = h.telemetry.lock() {
                            if let Some(ref telem) = *lock {
                                current_speed = telem.rolling_throughput_bps / 8;
                                current_done = telem.downloaded_bytes;
                                if telem.total_bytes.is_some() {
                                    current_total = telem.total_bytes;
                                }
                            }
                        }
                    }
                    aggregate_speed += current_speed;
                }
                if is_queued {
                    queued_count += 1;
                }
                if is_completed {
                    completed_count += 1;
                }

                let matches_filter = match filter_lower.as_str() {
                    "active" => is_active || is_queued,
                    "completed" => is_completed,
                    "failed" => {
                        r.state == DownloadState::Failed || r.state == DownloadState::Cancelled
                    }
                    _ => true,
                };

                if matches_filter {
                    overviews.push(DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: current_total,
                        size_done: current_done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: current_speed,
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_completed { Some(Utc::now()) } else { None },
                        error_msg: r.error_msg,
                    });
                }
            }

            AppReply::DownloadList {
                downloads: overviews,
                active_count,
                queued_count,
                completed_count,
                aggregate_speed_bps: aggregate_speed,
            }
        }

        ExtensionMessage::GetDownload { id } => {
            let records = state.store.list_all_downloads().unwrap_or_default();
            if let Some(r) = records.into_iter().find(|d| d.id == id) {
                let is_comp = r.state == DownloadState::Completed;
                let mut speed = 0u64;
                let mut done = r.size_done;
                let mut total = r.size_total;
                if r.state == DownloadState::Downloading {
                    let tasks = state.tasks.lock().unwrap();
                    if let Some(h) = tasks.get(&id.to_string()) {
                        if let Ok(lock) = h.telemetry.lock() {
                            if let Some(ref telem) = *lock {
                                speed = telem.rolling_throughput_bps;
                                done = telem.downloaded_bytes;
                                if telem.total_bytes.is_some() {
                                    total = telem.total_bytes;
                                }
                            }
                        }
                    }
                }
                AppReply::DownloadDetail {
                    download: DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: total,
                        size_done: done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: speed,
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_comp { Some(Utc::now()) } else { None },
                        error_msg: r.error_msg,
                    },
                }
            } else {
                AppReply::Error {
                    message: format!("Download task {} not found", id),
                }
            }
        }

        ExtensionMessage::AddDownload {
            url,
            filename,
            size,
            ..
        } => {
            let id = Uuid::new_v4();
            match execute_download(state, id, url, filename, None, None, size, None, None, None) {
                Ok(id) => AppReply::Accepted { id },
                Err(err) => AppReply::Error { message: err },
            }
        }

        ExtensionMessage::PauseDownload { id } => {
            let tasks = state.tasks.lock().unwrap();
            if let Some(task) = tasks.get(&id.to_string()) {
                task.cancelled.store(true, Ordering::Relaxed);
            }
            let _ = state
                .store
                .update_download_state(id, DownloadState::Paused, None);
            AppReply::Success {
                action: "pause".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::ResumeDownload { id } => {
            let records = state.store.list_all_downloads().unwrap_or_default();
            if let Some(r) = records.into_iter().find(|d| d.id == id) {
                let _ = execute_download(
                    state,
                    id,
                    r.url,
                    Some(r.filename),
                    Some(PathBuf::from(r.save_dir)),
                    Some(r.connections),
                    r.size_total,
                    None,
                    r.referer,
                    r.user_agent,
                );
                let _ = state
                    .store
                    .update_download_state(id, DownloadState::Downloading, None);
            }
            AppReply::Success {
                action: "resume".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::CancelDownload { id } => {
            let tasks = state.tasks.lock().unwrap();
            if let Some(task) = tasks.get(&id.to_string()) {
                task.cancelled.store(true, Ordering::Relaxed);
            }
            let _ = state.store.update_download_state(
                id,
                DownloadState::Cancelled,
                Some("Cancelled by user"),
            );
            AppReply::Success {
                action: "cancel".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RetryDownload { id } => {
            let records = state.store.list_all_downloads().unwrap_or_default();
            if let Some(r) = records.into_iter().find(|d| d.id == id) {
                let _ = execute_download(
                    state,
                    id,
                    r.url,
                    Some(r.filename),
                    Some(PathBuf::from(r.save_dir)),
                    Some(r.connections),
                    r.size_total,
                    None,
                    r.referer,
                    r.user_agent,
                );
                let _ = state
                    .store
                    .update_download_state(id, DownloadState::Downloading, None);
            }
            AppReply::Success {
                action: "retry".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadedFile { id } => {
            if let Ok(records) = state.store.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    open_file(&r.save_dir, &r.filename);
                }
            }
            AppReply::Success {
                action: "open_file".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadFolder { id } => {
            if let Ok(records) = state.store.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    open_folder(&r.save_dir, &r.filename);
                }
            }
            AppReply::Success {
                action: "open_folder".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RemoveDownloadHistory { id } => {
            let _ = state.store.delete_download(id);
            AppReply::Success {
                action: "remove_history".into(),
                id: Some(id),
            }
        }

        _ => AppReply::Error {
            message: "Unsupported message type".into(),
        },
    }
}

fn spawn_extension_bridge(state: AppState, rt_handle: tokio::runtime::Handle) {
    rt_handle.spawn(async move {
        use axum::extract::State as AxumState;
        use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
        use axum::routing::post;
        use axum::{Json, Router};
        use tower_http::cors::{AllowOrigin, CorsLayer};

        let app = Router::new()
            .route(
                "/api",
                post(
                    |headers: HeaderMap,
                     AxumState(state): AxumState<AppState>,
                     Json(msg): Json<ExtensionMessage>| async move {
                        // Guard 1: Strict Host enforcement (127.0.0.1:8998 or localhost:8998)
                        let host_val = headers
                            .get(axum::http::header::HOST)
                            .and_then(|h| h.to_str().ok());
                        if !ws_server::is_valid_loopback_host(host_val, 8998) {
                            return Err((
                                StatusCode::FORBIDDEN,
                                "Forbidden: Host must be loopback",
                            ));
                        }

                        // Guard 2: Token verification on /api requests
                        let auth_header = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|a| a.to_str().ok())
                            .or_else(|| headers.get("x-edm-token").and_then(|a| a.to_str().ok()));

                        let token_valid = if let Some(auth) = auth_header {
                            let clean_token = auth.strip_prefix("Bearer ").unwrap_or(auth).trim();
                            state.ws_manager.verify_token_constant_time(clean_token)
                        } else {
                            false
                        };

                        if !token_valid {
                            return Err((
                                StatusCode::UNAUTHORIZED,
                                "Unauthorized: Valid token required",
                            ));
                        }

                        // Guard 3: Origin check (only browser extensions or desktop local UI)
                        if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                            if let Ok(o) = origin.to_str() {
                                let is_chrome = o.starts_with("chrome-extension://")
                                    && o.contains(ws_server::EXTENSION_ID);
                                let is_firefox = o.starts_with("moz-extension://");
                                let is_local = o.starts_with("http://localhost:")
                                    || o.starts_with("http://127.0.0.1:")
                                    || o.starts_with("tauri://");
                                if !is_chrome && !is_firefox && !is_local {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Untrusted Origin",
                                    ));
                                }
                            }
                        }

                        let reply = handle_extension_message(msg, &state).await;
                        Ok(Json(reply))
                    },
                ),
            )
            .layer(
                CorsLayer::new()
                    .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
                        if let Ok(s) = origin.to_str() {
                            s.starts_with("chrome-extension://")
                                || s.starts_with("moz-extension://")
                                || s.starts_with("http://localhost:")
                                || s.starts_with("http://127.0.0.1:")
                                || s.starts_with("tauri://")
                        } else {
                            false
                        }
                    }))
                    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                    .allow_headers(tower_http::cors::Any),
            )
            .with_state(state);

        if let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:8998").await {
            let _ = axum::serve(listener, app).await;
        }
    });
}

#[command]
async fn probe_url(url: String) -> Result<serde_json::Value, String> {
    validate_url_security(&url)?;
    let pack_target = edm_core::FeaturePackManager::classify_target(&url);

    // 1. BitTorrent Magnet Link Probe
    if pack_target.pack_id == edm_core::FeaturePackId::BitTorrentPack {
        return Ok(serde_json::json!({
            "url": url,
            "final_url": url,
            "filename": pack_target.suggested_filename.or(Some("Torrent_Task".into())),
            "content_type": Some("application/x-bittorrent"),
            "size_total": null,
            "resumable": true,
            "etag": null,
            "last_modified": null
        }));
    }

    // 2. eDonkey2000 Link Probe
    if pack_target.pack_id == edm_core::FeaturePackId::Ed2kPack {
        return Ok(serde_json::json!({
            "url": url,
            "final_url": url,
            "filename": pack_target.suggested_filename.or(Some("eD2k_File".into())),
            "content_type": Some("application/x-ed2k"),
            "size_total": pack_target.estimated_size,
            "resumable": true,
            "etag": null,
            "last_modified": null
        }));
    }

    // 3. Video Stream Probe (Native Extractor or yt-dlp)
    if pack_target.pack_id == edm_core::FeaturePackId::YtDlpPack {
        use edm_core::packs::extractors::{SiteExtractor, VimeoExtractor, YouTubeExtractor};
        let yt = YouTubeExtractor;
        let vimeo = VimeoExtractor;
        let probe_client = Client::builder()
            .redirect(reqwest::redirect::Policy::limited(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();

        if yt.can_extract(&url) {
            if let Ok(meta) = yt.extract(&url, &probe_client).await {
                let best_size = meta.formats.iter().filter_map(|f| f.filesize).max();
                let sanitized = edm_core::sanitizer::Sanitizer::sanitize_filename(&meta.title);
                let final_stream_url = meta.best_stream_url.unwrap_or_else(|| url.clone());
                return Ok(serde_json::json!({
                    "url": url,
                    "final_url": final_stream_url,
                    "filename": Some(format!("{}.mp4", sanitized)),
                    "content_type": Some("video/mp4"),
                    "size_total": best_size,
                    "resumable": true,
                    "etag": null,
                    "last_modified": null
                }));
            }
        } else if vimeo.can_extract(&url) {
            if let Ok(meta) = vimeo.extract(&url, &probe_client).await {
                let best_size = meta.formats.iter().filter_map(|f| f.filesize).max();
                let sanitized = edm_core::sanitizer::Sanitizer::sanitize_filename(&meta.title);
                let final_stream_url = meta.best_stream_url.unwrap_or_else(|| url.clone());
                return Ok(serde_json::json!({
                    "url": url,
                    "final_url": final_stream_url,
                    "filename": Some(format!("{}.mp4", sanitized)),
                    "content_type": Some("video/mp4"),
                    "size_total": best_size,
                    "resumable": true,
                    "etag": null,
                    "last_modified": null
                }));
            }
        }

        if let Ok(info) = edm_core::packs::YtDlpPack::extract_info(&url).await {
            let best_size = info.formats.iter().filter_map(|f| f.filesize).max();
            let sanitized = edm_core::sanitizer::Sanitizer::sanitize_filename(&info.title);
            let final_stream_url = info.best_video_url.unwrap_or(info.webpage_url);
            return Ok(serde_json::json!({
                "url": url,
                "final_url": final_stream_url,
                "filename": Some(format!("{}.mp4", sanitized)),
                "content_type": Some("video/mp4"),
                "size_total": best_size,
                "resumable": true,
                "etag": null,
                "last_modified": null
            }));
        }
    }

    // 4. Standard HTTP / M3U8 / GitHub / HuggingFace Probe
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0")
        .build()
        .unwrap_or_default();
    let res = Probe::probe_url(&client, &url)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(res).map_err(|e| e.to_string())
}

#[command]
async fn start_download(
    state: State<'_, AppState>,
    url: String,
    filename: Option<String>,
    save_dir: Option<String>,
    max_connections: Option<u32>,
) -> Result<serde_json::Value, String> {
    let id = Uuid::new_v4();
    let save_path = save_dir.map(PathBuf::from);
    let download_id = execute_download(
        &state,
        id,
        url,
        filename,
        save_path,
        max_connections,
        None,
        None,
        None,
        None,
    )?;

    Ok(serde_json::json!({
        "status": "started",
        "id": download_id.to_string()
    }))
}

#[command]
async fn list_downloads(
    state: State<'_, AppState>,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let reply = handle_extension_message(ExtensionMessage::ListDownloads { filter }, &state).await;
    serde_json::to_value(reply).map_err(|e| e.to_string())
}

#[command]
async fn resume_download(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    if let Ok(uuid) = Uuid::parse_str(&id) {
        let records = state.store.list_all_downloads().unwrap_or_default();
        if let Some(r) = records.into_iter().find(|d| d.id == uuid) {
            let mut download_url = r.url.clone();
            let pack_target = edm_core::FeaturePackManager::classify_target(&download_url);
            if pack_target.pack_id == edm_core::FeaturePackId::YtDlpPack {
                use edm_core::packs::extractors::{
                    SiteExtractor, VimeoExtractor, YouTubeExtractor,
                };
                let yt = YouTubeExtractor;
                let vimeo = VimeoExtractor;
                let client = Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(15))
                    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36")
                    .build()
                    .unwrap_or_default();
                if yt.can_extract(&download_url) {
                    if let Ok(meta) = yt.extract(&download_url, &client).await {
                        if let Some(stream_url) = meta.best_stream_url {
                            download_url = stream_url;
                        }
                    }
                } else if vimeo.can_extract(&download_url) {
                    if let Ok(meta) = vimeo.extract(&download_url, &client).await {
                        if let Some(stream_url) = meta.best_stream_url {
                            download_url = stream_url;
                        }
                    }
                } else if let Ok(info) =
                    edm_core::packs::YtDlpPack::extract_info(&download_url).await
                {
                    if let Some(stream_url) = info.best_video_url {
                        download_url = stream_url;
                    }
                }
            }

            let _ = execute_download(
                &state,
                uuid,
                download_url,
                Some(r.filename),
                Some(PathBuf::from(r.save_dir)),
                Some(r.connections),
                r.size_total,
                None,
                r.referer,
                r.user_agent,
            );
            let _ = state
                .store
                .update_download_state(uuid, DownloadState::Downloading, None);
            return Ok(serde_json::json!({ "status": "resumed", "id": id }));
        }
    }
    Err(format!("Task {} not found", id))
}

#[command]
fn cancel_download(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        task.cancelled.store(true, Ordering::Relaxed);
    }
    if let Ok(uuid) = Uuid::parse_str(&id) {
        let _ = state.store.update_download_state(
            uuid,
            DownloadState::Cancelled,
            Some("Cancelled by user"),
        );
    }
    Ok(serde_json::json!({ "status": "cancelled", "id": id }))
}

pub(crate) async fn remove_download_task(
    state: &AppState,
    id_str: &str,
    delete_file: bool,
) -> Result<(), String> {
    // 1. Cancel in-memory active task
    {
        let tasks = state.tasks.lock().unwrap();
        if let Some(t) = tasks.get(id_str) {
            t.cancelled.store(true, Ordering::SeqCst);
        }
    }

    // 2. Lookup record in store for file paths if delete_file requested
    let id_uuid = Uuid::parse_str(id_str).map_err(|e| format!("Invalid UUID: {}", e))?;
    let maybe_record = state
        .store
        .list_all_downloads()
        .ok()
        .and_then(|records| records.into_iter().find(|d| d.id == id_uuid));

    // 3. Delete from persistent SQLite database
    let _ = state.store.delete_download(id_uuid);

    // 4. Remove from ws_manager live memory and broadcast task_removed immediately
    state.ws_manager.broadcast_task_removed(id_str).await;

    // 5. If delete_file, send target file and .edmpart to Recycle Bin
    if delete_file {
        if let Some(r) = maybe_record {
            let base_dir = PathBuf::from(r.save_dir);
            let target_file = base_dir.join(&r.filename);
            let part_file = base_dir.join(format!("{}.edmpart", r.filename));
            if target_file.exists() {
                let _ = ws_server::send_to_recycle_bin(&target_file);
            }
            if part_file.exists() {
                let _ = ws_server::send_to_recycle_bin(&part_file);
            }
        }
    }

    // 6. Notify desktop frontend window
    if let Ok(guard) = state.app_handle.lock() {
        if let Some(ref handle) = *guard {
            use tauri::Emitter;
            let _ = handle.emit(
                "downloads-changed",
                serde_json::json!({ "id": id_str, "action": "removed" }),
            );
        }
    }

    Ok(())
}

#[command]
async fn delete_download(
    state: State<'_, AppState>,
    id: String,
    delete_file: Option<bool>,
) -> Result<serde_json::Value, String> {
    remove_download_task(&state, &id, delete_file.unwrap_or(false)).await?;
    Ok(serde_json::json!({ "status": "deleted", "id": id }))
}

#[command]
fn open_file_path(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    if let Ok(uuid) = Uuid::parse_str(&id) {
        if let Ok(records) = state.store.list_all_downloads() {
            if let Some(r) = records.into_iter().find(|d| d.id == uuid) {
                open_file(&r.save_dir, &r.filename);
                return Ok(serde_json::json!({ "status": "opened" }));
            }
        }
    }
    Err("Not found".into())
}

#[command]
fn open_dir_path(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    if let Ok(uuid) = Uuid::parse_str(&id) {
        if let Ok(records) = state.store.list_all_downloads() {
            if let Some(r) = records.into_iter().find(|d| d.id == uuid) {
                open_folder(&r.save_dir, &r.filename);
                return Ok(serde_json::json!({ "status": "opened" }));
            }
        }
    }
    Err("Not found".into())
}

#[command]
fn pause_download(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        task.cancelled.store(true, Ordering::Relaxed);
        if let Ok(uuid) = Uuid::parse_str(&id) {
            let _ = state
                .store
                .update_download_state(uuid, DownloadState::Paused, None);
        }
        Ok(serde_json::json!({ "status": "paused", "id": id }))
    } else {
        Err(format!("Task {} not found", id))
    }
}

#[command]
fn get_download_telemetry(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        let lock = task.telemetry.lock().unwrap();
        if let Some(ref telem) = *lock {
            serde_json::to_value(telem).map_err(|e| e.to_string())
        } else {
            Ok(serde_json::json!({ "status": "initializing" }))
        }
    } else {
        Err(format!("Task {} not found", id))
    }
}

#[command]
fn get_stats(state: State<'_, AppState>) -> serde_json::Value {
    let tasks = state.tasks.lock().unwrap();
    let active_count = tasks.len();
    serde_json::json!({
        "status": "ready",
        "active_downloads": active_count,
        "engine": "adaptive_v1",
    })
}

#[command]
fn get_feature_packs() -> serde_json::Value {
    let packs = edm_core::FeaturePackManager::list_all_packs();
    serde_json::to_value(packs).unwrap_or_else(|_| serde_json::json!([]))
}

#[command]
fn get_settings(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    match state.store.get_setting("app_settings") {
        Ok(Some(json_str)) => {
            let val: serde_json::Value =
                serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
            Ok(Some(val))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
async fn save_settings(
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json_str = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .store
        .set_setting("app_settings", &json_str)
        .map_err(|e| e.to_string())?;

    let theme = settings
        .get("general")
        .and_then(|g| g.get("theme"))
        .and_then(|v| v.as_str())
        .or_else(|| settings.get("theme").and_then(|v| v.as_str()))
        .map(String::from);
    let palette = settings
        .get("general")
        .and_then(|g| g.get("palette"))
        .and_then(|v| v.as_str())
        .or_else(|| settings.get("palette").and_then(|v| v.as_str()))
        .map(String::from);

    state.ws_manager.update_theme_palette(theme, palette).await;
    state.ws_manager.broadcast_snapshot().await;

    let keep_awake = settings
        .get("general")
        .and_then(|g| g.get("keepAwake"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let idle_exit_mins = settings
        .get("general")
        .and_then(|g| g.get("idleExitMinutes"))
        .and_then(|v| {
            if v.is_null() || v.as_str() == Some("never") {
                None
            } else {
                v.as_u64()
            }
        });
    state
        .lifecycle
        .update_settings(keep_awake, idle_exit_mins)
        .await;

    Ok(serde_json::json!({ "status": "saved" }))
}

#[cfg(windows)]
fn set_app_user_model_id() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(AppID: *const u16) -> i32;
    }

    let wide: Vec<u16> = OsStr::new("com.edm.desktop")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[tauri::command]
fn app_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn app_toggle_maximize(window: tauri::WebviewWindow) {
    if let Ok(is_max) = window.is_maximized() {
        if is_max {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
async fn app_close(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    // Read user settings for minimizeToTray / close_to_tray
    let close_to_tray = if let Ok(Some(json_str)) = state.store.get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
            val.get("general")
                .and_then(|g| g.get("minimizeToTray"))
                .and_then(|m| m.as_bool())
                .unwrap_or(true)
        } else {
            true
        }
    } else {
        true
    };

    if close_to_tray {
        tracing::info!("Closing main window and destroying WebView2 to reclaim memory");
        let _ = window.destroy();
        state.lifecycle.check_lifecycle_step(0, false).await;
    } else {
        trigger_graceful_quit(window.app_handle().clone(), state.inner().clone());
    }
    Ok(())
}

#[tauri::command]
async fn get_lifecycle_status(
    state: State<'_, AppState>,
) -> Result<lifecycle::LifecycleStatus, String> {
    let active_count = {
        let mut count = 0;
        if let Ok(tasks) = state.tasks.lock() {
            for handle in tasks.values() {
                if !handle.cancelled.load(Ordering::Relaxed) {
                    count += 1;
                }
            }
        }
        count
    };
    Ok(state.lifecycle.get_status(active_count).await)
}

#[tauri::command]
async fn wake_engine(state: State<'_, AppState>, show_window: Option<bool>) -> Result<(), String> {
    state
        .lifecycle
        .record_wake(show_window.unwrap_or(false))
        .await;
    Ok(())
}

pub(crate) fn trigger_graceful_quit(app_handle: tauri::AppHandle, state: AppState) {
    // 5-second watchdog timer to force exit if cleanup hangs
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(5));
        std::process::exit(0);
    });

    // Cancel all running tasks and flush state
    let task_handles = {
        let tasks = state.tasks.lock().unwrap();
        tasks.values().cloned().collect::<Vec<_>>()
    };
    for h in task_handles {
        h.cancelled.store(true, Ordering::SeqCst);
    }

    // Flush any pending database operations
    if let Ok(records) = state.store.list_all_downloads() {
        for r in records {
            if r.state == DownloadState::Downloading {
                let _ = state
                    .store
                    .update_download_state(r.id, DownloadState::Paused, None);
            }
        }
    }

    app_handle.exit(0);
}

#[tauri::command]
fn app_start_dragging(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn get_extension_token(state: State<'_, AppState>) -> String {
    state.ws_manager.get_token().to_string()
}

fn main() {
    init_logging();

    #[cfg(windows)]
    set_app_user_model_id();

    register_native_messaging_host();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime");

    let rt_handle = rt.handle().clone();

    let store = open_persistent_store();
    let engine = Arc::new(AdaptiveEngine::new(store.clone()));

    let token = ws_server::get_or_create_token();
    let (create_task_tx, mut create_task_rx) =
        tokio::sync::mpsc::channel::<ws_server::CreateTaskCommand>(64);
    let (action_tx, mut action_rx) = tokio::sync::mpsc::channel::<ws_server::ActionCommand>(64);

    let ws_manager = Arc::new(ws_server::WsManager::new(
        token,
        ws_server::EXTENSION_ID.to_string(),
        store.clone(),
        create_task_tx,
        action_tx,
    ));

    let lifecycle = Arc::new(lifecycle::LifecycleManager::new(
        store.clone(),
        ws_manager.clone(),
    ));

    let app_state = AppState {
        store,
        engine,
        tasks: Arc::new(Mutex::new(HashMap::new())),
        rt_handle: rt_handle.clone(),
        ws_manager: ws_manager.clone(),
        tray_handle: Arc::new(Mutex::new(None)),
        app_handle: Arc::new(Mutex::new(None)),
        lifecycle: lifecycle.clone(),
    };

    // Background lifecycle monitoring loop (checks every 15 seconds)
    let lc_monitor = lifecycle.clone();
    let tasks_monitor = app_state.tasks.clone();
    rt_handle.spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            interval.tick().await;
            let active_count = {
                let mut count = 0;
                if let Ok(tasks) = tasks_monitor.lock() {
                    for handle in tasks.values() {
                        if !handle.cancelled.load(Ordering::Relaxed) {
                            count += 1;
                        }
                    }
                }
                count
            };
            lc_monitor.check_lifecycle_step(active_count, false).await;
        }
    });

    spawn_extension_bridge(app_state.clone(), rt_handle.clone());

    // Start WebSocket Server on 127.0.0.1:14370
    let ws_mgr_srv = ws_manager.clone();
    rt_handle.spawn(async move {
        ws_mgr_srv.sync_from_store().await;
        ws_server::start_ws_server(ws_mgr_srv).await;
    });

    // Inbound WebSocket Task Creator Loop
    let create_state = app_state.clone();
    rt_handle.spawn(async move {
        while let Some(cmd) = create_task_rx.recv().await {
            let cookie_header = if !cmd.cookies.is_empty() {
                Some(
                    cmd.cookies
                        .iter()
                        .map(|c| format!("{}={}", c.name, c.value))
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            } else {
                None
            };
            let id = Uuid::new_v4();
            let res = execute_download(
                &create_state,
                id,
                cmd.url,
                cmd.filename,
                None,
                None,
                None,
                cookie_header,
                cmd.referrer,
                cmd.user_agent,
            );
            let _ = cmd.resp_tx.send(res.map(|u| u.to_string()));
        }
    });

    // Inbound WebSocket Task Actions Loop
    let action_state = app_state.clone();
    rt_handle.spawn(async move {
        while let Some(cmd) = action_rx.recv().await {
            let res = match cmd.action.as_str() {
                "pause" => {
                    if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        {
                            let tasks = action_state.tasks.lock().unwrap();
                            if let Some(t) = tasks.get(&cmd.id) {
                                t.cancelled.store(true, Ordering::Relaxed);
                            }
                        }
                        let _ = action_state.store.update_download_state(
                            id_uuid,
                            DownloadState::Paused,
                            None,
                        );
                        action_state
                            .ws_manager
                            .update_task_progress(&cmd.id, 0, None, 0, "paused")
                            .await;
                        Ok(())
                    } else {
                        Err("Invalid task id".into())
                    }
                }
                "resume" => {
                    if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        let records = action_state.store.list_all_downloads().unwrap_or_default();
                        if let Some(r) = records.into_iter().find(|d| d.id == id_uuid) {
                            let _ = execute_download(
                                &action_state,
                                id_uuid,
                                r.url,
                                Some(r.filename),
                                Some(PathBuf::from(r.save_dir)),
                                Some(r.connections),
                                r.size_total,
                                None,
                                r.referer,
                                r.user_agent,
                            );
                            let _ = action_state.store.update_download_state(
                                id_uuid,
                                DownloadState::Downloading,
                                None,
                            );
                            action_state
                                .ws_manager
                                .update_task_progress(
                                    &cmd.id,
                                    r.size_done,
                                    r.size_total,
                                    0,
                                    "downloading",
                                )
                                .await;
                            Ok(())
                        } else {
                            Err("Task not found".into())
                        }
                    } else {
                        Err("Invalid task id".into())
                    }
                }
                "cancel" => {
                    if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        {
                            let tasks = action_state.tasks.lock().unwrap();
                            if let Some(t) = tasks.get(&cmd.id) {
                                t.cancelled.store(true, Ordering::Relaxed);
                            }
                        }
                        let _ = action_state.store.update_download_state(
                            id_uuid,
                            DownloadState::Cancelled,
                            Some("Cancelled by user"),
                        );
                        action_state
                            .ws_manager
                            .update_task_progress(&cmd.id, 0, None, 0, "failed")
                            .await;
                        Ok(())
                    } else {
                        Err("Invalid task id".into())
                    }
                }
                "remove" => {
                    let delete_file = cmd.delete_file;
                    remove_download_task(&action_state, &cmd.id, delete_file).await
                }
                "open_file" => {
                    let live_tasks = action_state.ws_manager.get_live_tasks();
                    let live = live_tasks.read().await;
                    if let Some(t) = live.get(&cmd.id) {
                        ws_server::secure_open_file(&t.save_dir, &t.filename, &t.status)
                    } else if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        let records = action_state.store.list_all_downloads().unwrap_or_default();
                        if let Some(r) = records.into_iter().find(|d| d.id == id_uuid) {
                            let status = match r.state {
                                DownloadState::Completed => "completed",
                                _ => "downloading",
                            };
                            ws_server::secure_open_file(
                                &PathBuf::from(r.save_dir),
                                &r.filename,
                                status,
                            )
                        } else {
                            Err("Task not found".into())
                        }
                    } else {
                        Err("Task not found".into())
                    }
                }
                "open_folder" => {
                    let live_tasks = action_state.ws_manager.get_live_tasks();
                    let live = live_tasks.read().await;
                    if let Some(t) = live.get(&cmd.id) {
                        ws_server::secure_open_folder(&t.save_dir, &t.filename)
                    } else if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        let records = action_state.store.list_all_downloads().unwrap_or_default();
                        if let Some(r) = records.into_iter().find(|d| d.id == id_uuid) {
                            ws_server::secure_open_folder(&PathBuf::from(r.save_dir), &r.filename)
                        } else {
                            Err("Task not found".into())
                        }
                    } else {
                        Err("Task not found".into())
                    }
                }
                _ => Err("Unsupported action".into()),
            };
            let _ = cmd.resp_tx.send(res);
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Autostart launches when an instance is already running exit silently
            let is_autostart = argv.iter().any(|arg| arg == "--autostart");
            let is_background = argv.iter().any(|arg| arg == "--background" || arg == "--listener-only");
            let show_window = argv.iter().any(|arg| arg == "--show-window");

            let state = app.state::<AppState>();
            let lc = state.lifecycle.clone();

            if !is_autostart && (!is_background || show_window) {
                state.rt_handle.spawn(async move {
                    lc.record_wake(true).await;
                });
            } else {
                state.rt_handle.spawn(async move {
                    lc.record_wake(false).await;
                });
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            let app_state_ref = app.state::<AppState>();
            app_state_ref.lifecycle.set_app_handle(app.handle().clone());

            let args: Vec<String> = std::env::args().collect();
            let is_autostart_boot = args.iter().any(|arg| arg == "--autostart");
            let is_background_boot = args.iter().any(|arg| arg == "--background" || arg == "--listener-only");
            let show_window = args.iter().any(|arg| arg == "--show-window");

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
                {
                    let _ = window.set_icon(icon);
                }
                let _ = window.center();

                if (is_autostart_boot || is_background_boot) && !show_window {
                    tracing::info!(
                        "EDM started in background mode; destroying window to minimize memory footprint"
                    );
                    let _ = window.destroy();
                } else {
                    tracing::info!(
                        "Main desktop window successfully loaded: {:?}",
                        window.url()
                    );
                }
            }

            // Phase 3: Tray Icon Setup
            let open_i = MenuItem::with_id(app, "open", "Open EDM", true, None::<&str>)?;
            let pause_all_i = MenuItem::with_id(app, "pause_all", "Pause all", true, None::<&str>)?;
            let resume_all_i =
                MenuItem::with_id(app, "resume_all", "Resume all", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[&open_i, &pause_all_i, &resume_all_i, &settings_i, &quit_i],
            )?;

            let tray_icon_bytes = include_bytes!("../icons/icon.ico");
            let icon_img = tauri::image::Image::from_bytes(tray_icon_bytes).map_err(|e| {
                tauri::Error::Anyhow(anyhow::anyhow!("Failed to parse icon.ico: {}", e))
            })?;

            let tray = TrayIconBuilder::new()
                .icon(icon_img)
                .tooltip("EDM — Edge Download Manager")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => {
                        let state = app.state::<AppState>();
                        let lc = state.lifecycle.clone();
                        state.rt_handle.spawn(async move {
                            lc.record_wake(true).await;
                        });
                    }
                    "pause_all" => {
                        let state = app.state::<AppState>();
                        let tasks = state.tasks.lock().unwrap();
                        for handle in tasks.values() {
                            handle.cancelled.store(true, Ordering::SeqCst);
                        }
                    }
                    "resume_all" => {
                        let state = app.state::<AppState>();
                        if let Ok(records) = state.store.list_all_downloads() {
                            for r in records {
                                if r.state == DownloadState::Paused {
                                    let _ = execute_download(
                                        &state,
                                        r.id,
                                        r.url,
                                        Some(r.filename),
                                        Some(PathBuf::from(r.save_dir)),
                                        Some(r.connections),
                                        r.size_total,
                                        None,
                                        r.referer,
                                        r.user_agent,
                                    );
                                    let _ = state.store.update_download_state(
                                        r.id,
                                        DownloadState::Downloading,
                                        None,
                                    );
                                }
                            }
                        }
                    }
                    "settings" => {
                        let state = app.state::<AppState>();
                        let lc = state.lifecycle.clone();
                        state.rt_handle.spawn(async move {
                            lc.record_wake(true).await;
                        });
                    }
                    "quit" => {
                        let state = app.state::<AppState>();
                        trigger_graceful_quit(app.clone(), state.inner().clone());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let state = tray.app_handle().state::<AppState>();
                        let lc = state.lifecycle.clone();
                        state.rt_handle.spawn(async move {
                            lc.record_wake(true).await;
                        });
                    }
                })
                .build(app)?;

            let app_state_ref = app.state::<AppState>();
            *app_state_ref.tray_handle.lock().unwrap() = Some(tray.clone());
            *app_state_ref.app_handle.lock().unwrap() = Some(app.handle().clone());

            // Initialize theme and palette in ws_manager from store
            if let Ok(Some(settings_str)) = app_state_ref.store.get_setting("app_settings") {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&settings_str) {
                    let theme = val
                        .get("general")
                        .and_then(|g| g.get("theme"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let palette = val
                        .get("general")
                        .and_then(|g| g.get("palette"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let ws_mgr = app_state_ref.ws_manager.clone();
                    app_state_ref.rt_handle.spawn(async move {
                        ws_mgr.update_theme_palette(theme, palette).await;
                    });
                }
            }

            // Tray tooltip ticker (at most once per second)
            let tray_app_state = app_state_ref.inner().clone();
            let ticker_tray = tray.clone();
            app_state_ref.rt_handle.spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let (active_count, total_speed) = {
                        let mut active = 0;
                        let mut speed = 0;
                        let tasks = tray_app_state.tasks.lock().unwrap();
                        for handle in tasks.values() {
                            if !handle.cancelled.load(Ordering::Relaxed) {
                                active += 1;
                                if let Ok(lock) = handle.telemetry.lock() {
                                    if let Some(ref telem) = *lock {
                                        speed += telem.rolling_throughput_bps / 8;
                                    }
                                }
                            }
                        }
                        (active, speed)
                    };

                    let speed_str = if total_speed > 1024 * 1024 {
                        format!("{:.1} MB/s", total_speed as f64 / (1024.0 * 1024.0))
                    } else if total_speed > 1024 {
                        format!("{:.1} KB/s", total_speed as f64 / 1024.0)
                    } else {
                        format!("{} B/s", total_speed)
                    };

                    let tooltip = if active_count > 0 {
                        format!("EDM: {} active ({})", active_count, speed_str)
                    } else {
                        "EDM — Edge Download Manager (Idle)".to_string()
                    };

                    let _ = ticker_tray.set_tooltip(Some(tooltip));
                }
            });

            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            probe_url,
            start_download,
            pause_download,
            resume_download,
            cancel_download,
            delete_download,
            list_downloads,
            open_file_path,
            open_dir_path,
            get_download_telemetry,
            get_stats,
            get_feature_packs,
            get_settings,
            save_settings,
            get_extension_token,
            app_minimize,
            app_toggle_maximize,
            app_close,
            app_start_dragging,
            updater::get_app_version,
            updater::check_for_updates,
            updater::install_update,
            get_lifecycle_status,
            wake_engine
        ])
        .build(tauri::generate_context!())
        .expect("error while building EDM desktop application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Keep the background runtime, tray icon, and WebSocket server alive when windows are destroyed
                api.prevent_exit();
            }
        });
}
