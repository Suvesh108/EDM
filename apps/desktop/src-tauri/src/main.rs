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
use tauri::{command, State};
use uuid::Uuid;

mod ws_server;

#[derive(Clone)]
struct ActiveTaskHandle {
    cancelled: Arc<AtomicBool>,
    telemetry: Arc<Mutex<Option<AdaptiveTelemetry>>>,
}

#[derive(Clone)]
struct AppState {
    store: Store,
    engine: Arc<AdaptiveEngine>,
    tasks: Arc<Mutex<HashMap<String, ActiveTaskHandle>>>,
    rt_handle: tokio::runtime::Handle,
    ws_manager: Arc<ws_server::WsManager>,
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
    let mut nmh_path = current_dir.join("edm-nmh.exe");
    if !nmh_path.exists() {
        let dev_path =
            PathBuf::from(r"C:\Users\Suvesh\Desktop\projects\EDM\target\release\edm-nmh.exe");
        if dev_path.exists() {
            nmh_path = dev_path;
        }
    }

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

    let reg_targets = [
        r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh",
        r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh",
    ];

    for key in &reg_targets {
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

    let ext = clean_name
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
        filename: clean_name.clone(),
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
    };
    let _ = state.store.insert_download(&record);

    let ws_mgr = state.ws_manager.clone();
    let ws_id = id_str.clone();
    let ws_filename = clean_name.clone();
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
        filename: clean_name,
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
            tokio::spawn(async move {
                ws_mgr.update_task_progress(&id_c, telem.downloaded_bytes, telem.total_bytes, telem.rolling_throughput_bps, "downloading").await;
            });
        });
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::limited(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0")
            .build()
            .unwrap_or_default();
        let result = edm_core::PackExecutor::execute(task, engine, client, Some(cb)).await;
        let final_state = match result {
            Ok(_) => DownloadState::Completed,
            Err(e) if e.to_string().contains("cancelled") => DownloadState::Paused,
            Err(_) => DownloadState::Failed,
        };
        let _ = store_clone.update_download_state(id, final_state, None);

        let final_status_str = match &final_state {
            DownloadState::Completed => "completed",
            DownloadState::Paused => "paused",
            _ => "failed",
        };
        let ws_mgr_fin = ws_mgr_cb.clone();
        let ws_id_fin = ws_id_cb.clone();
        let (final_done, final_total) = match store_clone.list_all_downloads() {
            Ok(records) => records.into_iter().find(|d| d.id == id).map(|d| (d.size_done, d.size_total)).unwrap_or((0, effective_size)),
            Err(_) => (0, effective_size),
        };
        tokio::spawn(async move {
            ws_mgr_fin.update_task_progress(&ws_id_fin, final_done, final_total, 0, final_status_str).await;
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
            if agg_speed == 0 && active > 0 {
                agg_speed = active as u64 * 3_500_000;
            }

            AppReply::Status {
                status: "connected".into(),
                version: "0.0.1".into(),
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
                                current_speed = telem.rolling_throughput_bps;
                                current_done = telem.downloaded_bytes;
                                if telem.total_bytes.is_some() {
                                    current_total = telem.total_bytes;
                                }
                            }
                        }
                    }
                    if current_speed == 0 {
                        current_speed = 3_500_000;
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
                        error_msg: None,
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
                    if speed == 0 {
                        speed = 3_500_000;
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
                        error_msg: None,
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
                        // Guard 1: Loopback Host enforcement
                        if let Some(host) = headers.get(axum::http::header::HOST) {
                            if let Ok(h) = host.to_str() {
                                if !h.starts_with("127.0.0.1") && !h.starts_with("localhost") {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Host must be loopback",
                                    ));
                                }
                            }
                        }

                        // Guard 2: Origin check (allow browser extensions and loopback)
                        if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                            if let Ok(o) = origin.to_str() {
                                let is_ext = o.starts_with("chrome-extension://")
                                    || o.starts_with("moz-extension://");
                                let is_local = o.starts_with("http://localhost:")
                                    || o.starts_with("http://127.0.0.1:")
                                    || o.starts_with("tauri://");
                                if !is_ext && !is_local {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Untrusted Origin",
                                    ));
                                }
                            }
                        }

                        // Guard 3: Sec-Fetch-Site check
                        if let Some(sec_site) = headers.get("sec-fetch-site") {
                            if let Ok(site) = sec_site.to_str() {
                                if site == "cross-site" {
                                    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                                        if let Ok(o) = origin.to_str() {
                                            if !o.starts_with("chrome-extension://")
                                                && !o.starts_with("moz-extension://")
                                            {
                                                return Err((
                                                    StatusCode::FORBIDDEN,
                                                    "Forbidden: Cross-site request rejected",
                                                ));
                                            }
                                        }
                                    } else {
                                        return Err((
                                            StatusCode::FORBIDDEN,
                                            "Forbidden: Cross-site request rejected",
                                        ));
                                    }
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

    // 3. Video Stream Probe (yt-dlp)
    if pack_target.pack_id == edm_core::FeaturePackId::YtDlpPack {
        if let Ok(info) = edm_core::packs::YtDlpPack::extract_info(&url).await {
            let best_size = info.formats.iter().filter_map(|f| f.filesize).max();
            let sanitized = edm_core::sanitizer::Sanitizer::sanitize_filename(&info.title);
            return Ok(serde_json::json!({
                "url": url,
                "final_url": info.webpage_url,
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
fn resume_download(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    if let Ok(uuid) = Uuid::parse_str(&id) {
        let records = state.store.list_all_downloads().unwrap_or_default();
        if let Some(r) = records.into_iter().find(|d| d.id == uuid) {
            let _ = execute_download(
                &state,
                uuid,
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

#[command]
fn delete_download(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        task.cancelled.store(true, Ordering::Relaxed);
    }
    if let Ok(uuid) = Uuid::parse_str(&id) {
        let _ = state.store.delete_download(uuid);
    }
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
fn save_settings(
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json_str = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .store
        .set_setting("app_settings", &json_str)
        .map_err(|e| e.to_string())?;
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
fn app_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn app_start_dragging(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn get_extension_token(state: State<'_, AppState>) -> String {
    state.ws_manager.get_token().to_string()
}

#[cfg(windows)]
fn enforce_single_instance() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *mut std::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let mutex_name: Vec<u16> = OsStr::new("Global\\EDM_SingleInstance_Mutex_14370")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, mutex_name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        eprintln!("EDM is already running. Exiting second instance.");
        std::process::exit(0);
    }
    let _ = handle;
}

#[cfg(not(windows))]
fn enforce_single_instance() {}

fn main() {
    #[cfg(windows)]
    set_app_user_model_id();

    enforce_single_instance();

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

    let app_state = AppState {
        store,
        engine,
        tasks: Arc::new(Mutex::new(HashMap::new())),
        rt_handle: rt_handle.clone(),
        ws_manager: ws_manager.clone(),
    };

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
                    if let Ok(id_uuid) = Uuid::parse_str(&cmd.id) {
                        {
                            let tasks = action_state.tasks.lock().unwrap();
                            if let Some(t) = tasks.get(&cmd.id) {
                                t.cancelled.store(true, Ordering::Relaxed);
                            }
                        }
                        let _ = action_state.store.delete_download(id_uuid);
                        let live_tasks = action_state.ws_manager.get_live_tasks();
                        let mut live = live_tasks.write().await;
                        live.remove(&cmd.id);
                        Ok(())
                    } else {
                        Err("Invalid task id".into())
                    }
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

    // Keep Tokio runtime active in background thread
    std::thread::spawn(move || {
        rt.block_on(async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
            }
        });
    });

    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
                {
                    let _ = window.set_icon(icon);
                }
            }
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
            app_start_dragging
        ])
        .run(tauri::generate_context!())
        .expect("error while running EDM desktop application");
}
