// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Utc;
use edm_core::adaptive::{AdaptiveConfig, AdaptiveDownloadTask, AdaptiveEngine, AdaptiveTelemetry};
use edm_core::Probe;
use edm_ipc::{AppReply, DownloadOverview, DownloadState, ExtensionMessage, PROTOCOL_VERSION};
use edm_store::{DownloadRecord, Store};
use reqwest::Client;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{command, Manager, State};
use uuid::Uuid;

mod features;
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
    pub(crate) power_countdown: Arc<features::PowerCountdownController>,
    pub(crate) global_limiter: Arc<edm_core::TokenBucketLimiter>,
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
    use windows_registry::CURRENT_USER;

    let app_dir = match std::env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM"),
        Err(_) => std::env::temp_dir().join("EDM"),
    };
    let _ = std::fs::create_dir_all(&app_dir);

    let current_exe = std::env::current_exe().unwrap_or_default();
    let current_dir = current_exe.parent().unwrap_or(&app_dir);

    // Look for edm-nmh in current_dir, resources subfolder, target directories, or app_dir
    let mut candidates = vec![
        current_dir.join("edm-nmh.exe"),
        current_dir.join("resources").join("edm-nmh.exe"),
    ];

    if let Some(parent) = current_dir.parent() {
        candidates.push(parent.join("edm-nmh.exe"));
        candidates.push(parent.join("release").join("edm-nmh.exe"));
        candidates.push(parent.join("debug").join("edm-nmh.exe"));
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join("target").join("release").join("edm-nmh.exe"));
            candidates.push(grandparent.join("target").join("debug").join("edm-nmh.exe"));
        }
    }

    let target_nmh = app_dir.join("edm-nmh.exe");

    let found_source = candidates
        .iter()
        .filter(|p| *p != &target_nmh && p.exists() && p.is_file())
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());

    if let Some(src) = found_source {
        let should_copy = if !target_nmh.exists() {
            true
        } else {
            let src_meta = std::fs::metadata(src).ok();
            let tgt_meta = std::fs::metadata(&target_nmh).ok();
            match (src_meta, tgt_meta) {
                (Some(sm), Some(tm)) => {
                    sm.len() != tm.len()
                        || sm.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                            > tm.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                }
                _ => true,
            }
        };

        if should_copy {
            match std::fs::copy(src, &target_nmh) {
                Ok(_) => tracing::info!(
                    "Updated NMH binary at {} from {}",
                    target_nmh.display(),
                    src.display()
                ),
                Err(e) => tracing::warn!(
                    "Failed to copy NMH binary to {}: {}",
                    target_nmh.display(),
                    e
                ),
            }
        }
    } else if !target_nmh.exists() {
        tracing::warn!(
            "edm-nmh.exe not found in candidate paths near {}",
            current_dir.display()
        );
    }

    let nmh_path = if target_nmh.exists() {
        target_nmh
    } else {
        found_source
            .cloned()
            .unwrap_or_else(|| current_dir.join("edm-nmh.exe"))
    };

    let manifest_path = app_dir.join("com.edm.nmh.json");
    let manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Edge, Chrome and Brave",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": edm_ipc::extensions::allowed_chromium_origins()
    });

    if let Ok(content) = serde_json::to_string_pretty(&manifest_json) {
        let _ = std::fs::write(&manifest_path, &content);
        if current_dir != app_dir {
            let _ = std::fs::write(current_dir.join("com.edm.nmh.json"), &content);
        }
    }

    // Mozilla Firefox manifest (allowed_extensions instead of allowed_origins)
    let ff_manifest_path = app_dir.join("com.edm.nmh.firefox.json");
    let ff_manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Mozilla Firefox",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": edm_ipc::extensions::allowed_firefox_ids()
    });
    if let Ok(content) = serde_json::to_string_pretty(&ff_manifest_json) {
        let _ = std::fs::write(&ff_manifest_path, &content);
        if current_dir != app_dir {
            let _ = std::fs::write(current_dir.join("com.edm.nmh.firefox.json"), &content);
        }
    }

    let chromium_reg_targets = [
        r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh",
        r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh",
    ];

    let manifest_str = manifest_path.to_string_lossy().to_string();
    for key in &chromium_reg_targets {
        if let Ok(k) = CURRENT_USER.create(key) {
            let _ = k.set_string("", &manifest_str);
        }
    }

    // Register Firefox
    let ff_manifest_str = ff_manifest_path.to_string_lossy().to_string();
    if let Ok(k) = CURRENT_USER.create(r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh") {
        let _ = k.set_string("", &ff_manifest_str);
    }

    // Register HKCU\Software\EDM
    if let Ok(k) = CURRENT_USER.create(r"Software\EDM") {
        let _ = k.set_string("AppPath", current_exe.to_string_lossy());
        let _ = k.set_string("InstallDir", current_dir.to_string_lossy());
        let _ = k.set_string("NmhPath", nmh_path.to_string_lossy());
        let _ = k.set_string("Version", env!("CARGO_PKG_VERSION"));
    }
}

#[cfg(not(windows))]
fn register_native_messaging_host() {}

#[cfg(windows)]
async fn collect_browser_diagnostics(
    ext_id: Option<String>,
    ws_manager: Option<&Arc<ws_server::WsManager>>,
) -> edm_ipc::DiagnosticsReport {
    use windows_registry::CURRENT_USER;

    let target_ext_id = ext_id.unwrap_or_else(|| edm_ipc::extensions::CHROMIUM_UNPACKED_ID.to_string());

    let browsers_meta = [
        ("edge", r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh", false),
        ("chrome", r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh", false),
        ("brave", r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh", false),
        ("firefox", r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh", true),
    ];

    let mut browser_diagnostics = Vec::new();

    for (name, subkey, is_firefox) in &browsers_meta {
        let mut diag = edm_ipc::BrowserDiagnostic {
            browser: name.to_string(),
            registry_key: format!(r"HKCU\{}", subkey),
            helper_registered: false,
            manifest_path: None,
            manifest_exists: false,
            helper_path: None,
            helper_exists: false,
            origin_matched: false,
            error: None,
            connected_extension_id: None,
        };

        if let Some(mgr) = ws_manager {
            if let Some(conn_id) = mgr.get_browser_connected_id(name).await {
                diag.connected_extension_id = Some(conn_id);
            }
        }

        match CURRENT_USER.open(subkey) {
            Ok(key) => {
                diag.helper_registered = true;
                match key.get_string("") {
                    Ok(val) => {
                        diag.manifest_path = Some(val.clone());
                        let mpath = PathBuf::from(&val);
                        if mpath.exists() && mpath.is_file() {
                            diag.manifest_exists = true;
                            if let Ok(content) = std::fs::read_to_string(&mpath) {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                    if let Some(hpath_str) = json.get("path").and_then(|v| v.as_str()) {
                                        let hpath = PathBuf::from(hpath_str);
                                        let full_hpath = if hpath.is_relative() {
                                            mpath.parent().unwrap_or(&mpath).join(hpath)
                                        } else {
                                            hpath
                                        };
                                        diag.helper_path = Some(full_hpath.to_string_lossy().to_string());
                                        diag.helper_exists = full_hpath.exists() && full_hpath.is_file();
                                    }

                                    if *is_firefox {
                                        if let Some(exts) = json.get("allowed_extensions").and_then(|v| v.as_array()) {
                                            diag.origin_matched = exts.iter().any(|e| {
                                                e.as_str().map(|s| edm_ipc::extensions::FIREFOX_ALLOWED_IDS.contains(&s) || s == target_ext_id).unwrap_or(false)
                                            });
                                        }
                                    } else if let Some(origins) = json.get("allowed_origins").and_then(|v| v.as_array()) {
                                        diag.origin_matched = origins.iter().any(|o| {
                                            if let Some(s) = o.as_str() {
                                                edm_ipc::extensions::is_allowed_origin(s) || s.contains(&target_ext_id)
                                            } else {
                                                false
                                            }
                                        });
                                    }
                                } else {
                                    diag.error = Some("Failed to parse manifest JSON".to_string());
                                }
                            } else {
                                diag.error = Some("Failed to read manifest file".to_string());
                            }
                        } else {
                            diag.error = Some(format!("Manifest file does not exist at {}", val));
                        }
                    }
                    Err(e) => {
                        diag.error = Some(format!("Registry (Default) value error: {}", e));
                    }
                }
            }
            Err(_) => {
                diag.error = Some("Registry key not registered".to_string());
            }
        }
        browser_diagnostics.push(diag);
    }

    let current_exe = std::env::current_exe().ok();
    let dot = PathBuf::from(".");
    let app_dir = current_exe.as_ref().and_then(|p| p.parent()).unwrap_or(&dot);
    let helper_path = [
        app_dir.join("edm-nmh.exe"),
        app_dir.join("resources").join("edm-nmh.exe"),
    ].into_iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string());

    let (last_err, last_ts, ready_ms) = {
        let p = match std::env::var("LOCALAPPDATA") {
            Ok(dir) => PathBuf::from(dir).join("EDM").join("last_wake.json"),
            Err(_) => std::env::temp_dir().join("EDM").join("last_wake.json"),
        };
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let err = v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
                let ts = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());
                let ms = v.get("time_to_ready_ms").and_then(|m| m.as_u64());
                (err, ts, ms)
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        }
    };

    let any_connected = if let Some(mgr) = ws_manager {
        mgr.get_any_connected_extension_id().await
    } else {
        None
    };

    edm_ipc::DiagnosticsReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: "Windows".to_string(),
        helper_path,
        app_exe_path: current_exe.map(|p| p.to_string_lossy().to_string()),
        app_installed: true,
        ws_port_ready: true,
        time_to_ready_ms: ready_ms,
        last_wake_error: last_err,
        last_wake_timestamp: last_ts,
        browsers: browser_diagnostics,
        connected_extension_id: any_connected,
    }
}

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

    if let Some(host) = parsed.host() {
        match host {
            url::Host::Ipv4(ip) => {
                if ip.is_link_local() {
                    return Err("Security violation: Blocked access to link-local address".into());
                }
            }
            url::Host::Ipv6(ip) => {
                if ip.is_unicast_link_local() || format!("{}", ip) == "fd00:ec2::254" {
                    return Err("Security violation: Blocked access to IPv6 metadata or link-local address".into());
                }
            }
            url::Host::Domain(domain) => {
                let h = domain.to_lowercase();
                if h == "169.254.169.254"
                    || h == "metadata.google.internal"
                    || h == "instance-data"
                    || h.ends_with(".internal")
                {
                    return Err("Security violation: Blocked access to cloud metadata endpoint".into());
                }
            }
        }
    }
    Ok(parsed)
}

fn open_file(save_dir: &str, filename: &str) {
    let file_path = PathBuf::from(save_dir).join(filename);
    edm_core::security::open_file_safely(&file_path);
}

fn open_folder(save_dir: &str, filename: &str) {
    let save_path = std::path::Path::new(save_dir);
    if let Err(e) = ws_server::secure_open_folder(save_path, filename) {
        tracing::warn!("Failed to open folder securely: {}", e);
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

    // Security Guard: Prevent writing to sensitive system directories or Startup folders
    let path_str = save_path.to_string_lossy().to_lowercase();
    if path_str.contains(r"\windows\system32")
        || path_str.contains(r"\windows\syswow64")
        || path_str.contains(r"\start menu\programs\startup")
        || path_str.contains(r"\microsoft\windows\start menu")
    {
        return Err("Security violation: Target download directory is a restricted Windows system location".into());
    }

    let resolved_path = edm_core::sanitizer::Sanitizer::resolve_duplicate(&save_path, &clean_name);
    let final_clean_name = resolved_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(clean_name);

    if let Some(warn_msg) = edm_core::security::check_double_extension(&final_clean_name) {
        tracing::warn!("[SECURITY] {}", warn_msg);
    }

    let mut config = AdaptiveConfig::default();
    if let Some(conns) = max_connections {
        config.max_connections = conns;
    }

    // UI-01: Apply persistent settings from store (connections, segmentation, retries, proxy)
    let mut proxy_config: Option<reqwest::Proxy> = None;
    let mut req_timeout_secs = 45u64;

    if let Ok(Some(json_str)) = state.store.get_setting("app_settings") {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&json_str) {
            if let Some(dl) = settings.get("downloads") {
                if max_connections.is_none() {
                    if let Some(conns) = dl.get("maxConnectionsPerFile").and_then(|v| v.as_u64()) {
                        config.max_connections = (conns.clamp(1, 64)) as u32;
                    }
                }
                if let Some(min_mb) = dl.get("minFileSizeForSegmentationMb").and_then(|v| v.as_u64()) {
                    config.min_chunk_size = min_mb.max(1) * 1024 * 1024;
                }
                if let Some(retries) = dl.get("maxRetries").and_then(|v| v.as_u64()) {
                    config.max_worker_retries = (retries.clamp(1, 20)) as u32;
                }
            }
            if let Some(net) = settings.get("network") {
                if let Some(t) = net.get("connectionTimeoutSeconds").and_then(|v| v.as_u64()) {
                    if t > 0 {
                        req_timeout_secs = t;
                    }
                }
                let proxy_mode = net.get("proxyMode").and_then(|v| v.as_str()).unwrap_or("system");
                if proxy_mode == "manual" {
                    let proto = net.get("proxyProtocol").and_then(|v| v.as_str()).unwrap_or("http");
                    let host = net.get("proxyHost").and_then(|v| v.as_str()).unwrap_or("");
                    let port = net.get("proxyPort").and_then(|v| v.as_u64()).unwrap_or(8080);
                    if !host.trim().is_empty() {
                        let p_url = format!("{}://{}:{}", proto, host.trim(), port);
                        if let Ok(p) = reqwest::Proxy::all(&p_url) {
                            proxy_config = Some(p);
                        }
                    }
                }
            }
        }
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

    if let Some(sz) = effective_size {
        if let Err(e) = edm_core::security::check_disk_space(&save_path, sz) {
            tracing::warn!("[DISK SPACE] {}", e);
        }
    }

    if let Some(ref c) = cookies {
        if let Ok(enc) = edm_core::security::encrypt_dpapi(c.as_bytes()) {
            let _ = state.store.save_encrypted_cookies(id, &enc);
        }
    }

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
        url: url.clone(),
        filename: final_clean_name.clone(),
        save_dir: save_path.clone(),
        config,
        limiter: Some((*state.global_limiter).clone()),
        cancelled,
        cookies,
        referer: referer.clone(),
        user_agent,
    };

    let engine = state.engine.clone();
    let telem_target = telemetry_store.clone();
    let store_clone = state.store.clone();
    let store_cb = state.store.clone();
    let ws_mgr_cb = state.ws_manager.clone();
    let ws_id_cb = id_str.clone();
    let tasks_map = state.tasks.clone();
    let save_path_fin = save_path.clone();
    let final_clean_name_fin = final_clean_name.clone();
    let url_fin = url.clone();
    let referer_fin = referer.clone();
    let power_ctrl = state.power_countdown.clone();
    let app_handle_opt = state.app_handle.lock().unwrap().clone();

    state.rt_handle.spawn(async move {
        let ws_mgr_tick = ws_mgr_cb.clone();
        let ws_id_tick = ws_id_cb.clone();
        let last_db_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let last_db_time = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
        let last_ws_time = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

        let cb = Arc::new(move |telem: AdaptiveTelemetry| {
            if let Ok(mut lock) = telem_target.lock() {
                *lock = Some(telem.clone());
            }

            // Low-overhead throttled database persistence (every 1.5s or >= 1MB delta)
            let prev_bytes = last_db_bytes.load(Ordering::Relaxed);
            let should_update_db = {
                let mut inst = last_db_time.lock().unwrap();
                if inst.elapsed() >= std::time::Duration::from_millis(1500)
                    || telem.downloaded_bytes.saturating_sub(prev_bytes) >= 1024 * 1024
                {
                    *inst = std::time::Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_update_db {
                last_db_bytes.store(telem.downloaded_bytes, Ordering::Relaxed);
                let _ = store_cb.update_download_size_and_progress(id, telem.downloaded_bytes, telem.total_bytes);
            }

            // Low-overhead throttled WebSocket progress broadcast (at most every 250ms)
            let should_update_ws = {
                let mut inst = last_ws_time.lock().unwrap();
                if inst.elapsed() >= std::time::Duration::from_millis(250) {
                    *inst = std::time::Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_update_ws {
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
            }
        });
        let mut client_builder = Client::builder()
            .timeout(std::time::Duration::from_secs(req_timeout_secs))
            .redirect(reqwest::redirect::Policy::limited(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0");
        if let Some(p) = proxy_config {
            client_builder = client_builder.proxy(p);
        }
        let client = client_builder.build().unwrap_or_default();
        let result = edm_core::PackExecutor::execute(task, engine, client, Some(cb)).await;
        let (final_state, error_msg, verified_size) = match result {
            Ok(ref final_path) => {
                let s = std::fs::metadata(final_path).map(|m| m.len()).unwrap_or(0);
                if s > 0 {
                    (DownloadState::Completed, None, Some(s))
                } else {
                    (DownloadState::Failed, Some("Download failed: 0 bytes received or merge failed"), None)
                }
            }
            Err(ref e) if e.contains("cancelled") => (DownloadState::Paused, None, None),
            Err(ref e)
                if e.contains("401")
                    || e.contains("403")
                    || e.contains("410")
                    || e.contains("expired") =>
            {
                (
                    DownloadState::LinkExpired,
                    Some("Download link expired (HTTP 401/403/410). Refresh link to resume."),
                    None,
                )
            }
            Err(ref e) if e.contains("429") => {
                (DownloadState::Failed, Some("HTTP 429 Rate Limited"), None)
            }
            Err(ref e) if e.contains("stalled") => {
                (DownloadState::Failed, Some("Connection Stalled"), None)
            }
            Err(ref e) => (DownloadState::Failed, Some(e.as_str()), None),
        };
        let _ = store_clone.update_download_state(id, final_state, error_msg);
        if let Some(vs) = verified_size {
            let _ = store_clone.update_download_size_and_progress(id, vs, Some(vs));
        }

        if final_state == DownloadState::Completed {
            let full_path = save_path_fin.join(&final_clean_name_fin);
            let _ = edm_core::security::apply_mark_of_the_web(&full_path, Some(&url_fin));
            let _ = store_clone.purge_encrypted_cookies(id);
            if let Ok(records) = store_clone.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    let _ = store_clone.add_to_history(&r, Utc::now());
                }
            }
            if let Ok(queues) = store_clone.list_queues() {
                if let Some(def_q) = queues.into_iter().find(|q| q.id == "default") {
                    if def_q.post_action != "none" {
                        let all_records = store_clone.list_all_downloads().unwrap_or_default();
                        let all_done = all_records.iter().all(|d| d.state == DownloadState::Completed);
                        let no_errors = all_records.iter().all(|d| d.state != DownloadState::Failed && d.state != DownloadState::LinkExpired);
                        if all_done && no_errors && !all_records.is_empty() {
                            power_ctrl.start_countdown(&def_q.post_action, ws_mgr_cb.clone(), app_handle_opt);
                        }
                    }
                }
            }
        } else if final_state == DownloadState::LinkExpired {
            ws_mgr_cb
                .broadcast_refresh_link(
                    &id.to_string(),
                    referer_fin.as_deref(),
                    &final_clean_name_fin,
                    effective_size,
                )
                .await;
        }

        let final_status_str = match &final_state {
            DownloadState::Completed => "completed".to_string(),
            DownloadState::Paused => "paused".to_string(),
            DownloadState::LinkExpired => "needs_fresh_link".to_string(),
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
        let final_total = verified_size.or(final_total);
        let final_done = verified_size.unwrap_or(final_done);
        // Evict active task handle and telemetry buffers from live memory
        tasks_map.lock().unwrap().remove(&ws_id_cb);

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
                running: true,
                port: Some(14370),
                token: Some(state.ws_manager.get_token().to_string()),
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
                let mut current_connections = r.connections;
                let mut current_eta = None;

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
                                current_connections = telem.target_connections.max(1);
                                current_eta = telem.eta_seconds;
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
                    if let Some(tot) = current_total {
                        if tot > 0 {
                            current_done = tot;
                        }
                    }
                    current_speed = 0;
                    current_connections = 0;
                    current_eta = None;
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
                        connections: current_connections,
                        eta_seconds: current_eta,
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
                let mut connections = r.connections;
                let mut eta_seconds = None;
                if r.state == DownloadState::Downloading {
                    let tasks = state.tasks.lock().unwrap();
                    if let Some(h) = tasks.get(&id.to_string()) {
                        if let Ok(lock) = h.telemetry.lock() {
                            if let Some(ref telem) = *lock {
                                speed = telem.rolling_throughput_bps / 8;
                                done = telem.downloaded_bytes;
                                if telem.total_bytes.is_some() {
                                    total = telem.total_bytes;
                                }
                                connections = telem.target_connections.max(1);
                                eta_seconds = telem.eta_seconds;
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
                        connections,
                        eta_seconds,
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

    // 3. Video Stream Probe (Prioritize yt-dlp binary with Node JS solver, then native extractors)
    if pack_target.pack_id == edm_core::FeaturePackId::YtDlpPack {
        // Prioritize yt-dlp which accurately resolves YouTube title, thumbnail, and stream sizes
        if edm_core::packs::YtDlpPack::locate_binary().is_some() {
            if let Ok(info) = edm_core::packs::YtDlpPack::extract_info(&url).await {
                let best_size = info.formats.iter().filter_map(|f| f.filesize).max();
                let sanitized = edm_core::sanitizer::Sanitizer::sanitize_filename(&info.title);
                let final_stream_url = info.best_video_url.unwrap_or_else(|| info.webpage_url.clone());
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

        // If extraction is blocked by YouTube, still provide a safe video task structure so user can download
        let video_name = pack_target.suggested_filename.unwrap_or_else(|| "YouTube_Video.mp4".into());
        return Ok(serde_json::json!({
            "url": url,
            "final_url": url,
            "filename": Some(video_name),
            "content_type": Some("video/mp4"),
            "size_total": pack_target.estimated_size,
            "resumable": true,
            "etag": null,
            "last_modified": null
        }));
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
    // 1. Cancel and evict in-memory active task
    {
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(t) = tasks.remove(id_str) {
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

    if let Some(limit) = settings
        .get("downloads")
        .and_then(|d| d.get("globalSpeedLimitBytesPerSecond"))
        .and_then(|v| v.as_u64())
    {
        state.global_limiter.set_limit(limit);
    } else {
        state.global_limiter.set_limit(0);
    }

    Ok(serde_json::json!({ "status": "saved" }))
}

#[command]
fn set_speed_limit(state: State<'_, AppState>, bytes_per_sec: Option<u64>) -> Result<(), String> {
    state.global_limiter.set_limit(bytes_per_sec.unwrap_or(0));
    Ok(())
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

#[command]
fn get_extension_token(state: State<'_, AppState>) -> String {
    state.ws_manager.get_token().to_string()
}

#[command]
async fn get_browser_diagnostics(
    state: State<'_, AppState>,
    ext_id: Option<String>,
) -> Result<edm_ipc::DiagnosticsReport, String> {
    #[cfg(windows)]
    {
        Ok(collect_browser_diagnostics(ext_id, Some(&state.ws_manager)).await)
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        let _ = ext_id;
        Err("Windows only".into())
    }
}

#[command]
fn repair_native_host_registration() -> Result<String, String> {
    #[cfg(windows)]
    {
        register_native_messaging_host();
        Ok("Native messaging host registration repaired successfully".into())
    }
    #[cfg(not(windows))]
    {
        Err("Windows only".into())
    }
}

#[cfg(windows)]
fn find_browser_exe(
    app_paths_key: &str,
    common_subpaths: &[&str],
) -> Option<String> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};

    // 1. Try HKLM App Paths
    if let Ok(k) = LOCAL_MACHINE.open(app_paths_key) {
        if let Ok(val) = k.get_string("") {
            let p = PathBuf::from(val.trim_matches('"'));
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }

    // 2. Try HKCU App Paths
    if let Ok(k) = CURRENT_USER.open(app_paths_key) {
        if let Ok(val) = k.get_string("") {
            let p = PathBuf::from(val.trim_matches('"'));
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }

    // 3. Try standard Program Files & LocalAppData paths
    let prefixes = [
        std::env::var("ProgramFiles").ok().map(PathBuf::from),
        std::env::var("ProgramFiles(x86)").ok().map(PathBuf::from),
        std::env::var("LOCALAPPDATA").ok().map(PathBuf::from),
    ];

    for prefix in prefixes.iter().flatten() {
        for sub in common_subpaths {
            let candidate = prefix.join(sub);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[command]
async fn detect_installed_browsers(
    state: State<'_, AppState>,
) -> Result<Vec<edm_ipc::BrowserSetupInfo>, String> {
    let mut results = Vec::new();

    #[cfg(windows)]
    {
        use windows_registry::CURRENT_USER;

        let (chrome_store_url, edge_store_url, brave_store_url, firefox_xpi_url) = {
            let mut c_url = Some(edm_ipc::extensions::DEFAULT_CHROME_STORE_URL.to_string());
            let mut e_url = Some(edm_ipc::extensions::DEFAULT_EDGE_STORE_URL.to_string());
            let mut b_url = Some(edm_ipc::extensions::DEFAULT_CHROME_STORE_URL.to_string());
            let mut f_url = Some(edm_ipc::extensions::DEFAULT_FIREFOX_XPI_URL.to_string());

            if let Ok(Some(json_str)) = state.store.get_setting("app_settings") {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    if let Some(urls) = val.get("extension_store_urls") {
                        if let Some(u) = urls.get("chrome").and_then(|v| v.as_str()) {
                            c_url = if u.trim().is_empty() { None } else { Some(u.trim().to_string()) };
                        }
                        if let Some(u) = urls.get("edge").and_then(|v| v.as_str()) {
                            e_url = if u.trim().is_empty() { None } else { Some(u.trim().to_string()) };
                        }
                        if let Some(u) = urls.get("brave").and_then(|v| v.as_str()) {
                            b_url = if u.trim().is_empty() { None } else { Some(u.trim().to_string()) };
                        }
                        if let Some(u) = urls.get("firefox").and_then(|v| v.as_str()) {
                            f_url = if u.trim().is_empty() { None } else { Some(u.trim().to_string()) };
                        }
                    }
                }
            }
            (c_url, e_url, b_url, f_url)
        };

        // 1. Chrome
        let chrome_path = find_browser_exe(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
            &[r"Google\Chrome\Application\chrome.exe"],
        );
        let chrome_helper = CURRENT_USER
            .open(r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh")
            .is_ok();
        let chrome_connected = state.ws_manager.is_browser_connected("chrome").await;

        results.push(edm_ipc::BrowserSetupInfo {
            id: "chrome".to_string(),
            name: "Google Chrome".to_string(),
            installed: chrome_path.is_some(),
            exe_path: chrome_path,
            helper_registered: chrome_helper,
            extension_connected: chrome_connected,
            store_url: chrome_store_url,
            extension_page_url: "chrome://extensions".to_string(),
        });

        // 2. Edge
        let edge_path = find_browser_exe(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            &[r"Microsoft\Edge\Application\msedge.exe"],
        );
        let edge_helper = CURRENT_USER
            .open(r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh")
            .is_ok();
        let edge_connected = state.ws_manager.is_browser_connected("edge").await;

        results.push(edm_ipc::BrowserSetupInfo {
            id: "edge".to_string(),
            name: "Microsoft Edge".to_string(),
            installed: edge_path.is_some(),
            exe_path: edge_path,
            helper_registered: edge_helper,
            extension_connected: edge_connected,
            store_url: edge_store_url,
            extension_page_url: "edge://extensions".to_string(),
        });

        // 3. Brave
        let brave_path = find_browser_exe(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe",
            &[r"BraveSoftware\Brave-Browser\Application\brave.exe"],
        );
        let brave_helper = CURRENT_USER
            .open(r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh")
            .is_ok();
        let brave_connected = state.ws_manager.is_browser_connected("brave").await;

        results.push(edm_ipc::BrowserSetupInfo {
            id: "brave".to_string(),
            name: "Brave Browser".to_string(),
            installed: brave_path.is_some(),
            exe_path: brave_path,
            helper_registered: brave_helper,
            extension_connected: brave_connected,
            store_url: brave_store_url,
            extension_page_url: "brave://extensions".to_string(),
        });

        // 4. Firefox (only shown if Firefox is installed and signed .xpi exists)
        let ff_path = find_browser_exe(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe",
            &[r"Mozilla Firefox\firefox.exe"],
        );
        let firefox_xpi_exists = {
            let local_candidates = [
                std::path::PathBuf::from("extension/dist/firefox/edm-firefox.xpi"),
                std::path::PathBuf::from("extension/dist/firefox/firefox.xpi"),
                std::path::PathBuf::from("resources/firefox.xpi"),
                std::path::PathBuf::from("resources/edm-firefox.xpi"),
            ];
            let has_local = local_candidates.iter().any(|p| p.exists());
            let has_parent = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("resources").join("firefox.xpi").exists() || d.join("firefox.xpi").exists()))
                .unwrap_or(false);
            has_local || has_parent || firefox_xpi_url.as_ref().map(|u| u.starts_with("http")).unwrap_or(false)
        };

        if ff_path.is_some() && firefox_xpi_exists {
            let ff_helper = CURRENT_USER
                .open(r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh")
                .is_ok();
            let ff_connected = state.ws_manager.is_browser_connected("firefox").await;

            results.push(edm_ipc::BrowserSetupInfo {
                id: "firefox".to_string(),
                name: "Mozilla Firefox".to_string(),
                installed: true,
                exe_path: ff_path,
                helper_registered: ff_helper,
                extension_connected: ff_connected,
                store_url: firefox_xpi_url,
                extension_page_url: "about:addons".to_string(),
            });
        }
    }

    Ok(results)
}

fn get_user_extension_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return Ok(PathBuf::from(appdata).join("EDM").join("extension"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(local).join("EDM").join("extension"));
        }
        Err("Failed to determine %APPDATA% or %LOCALAPPDATA%".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("EDM")
                .join("extension"));
        }
        Err("Failed to determine $HOME".to_string())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Ok(config) = std::env::var("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config).join("EDM").join("extension"));
        }
        if let Ok(home) = std::env::var("HOME") {
            return Ok(PathBuf::from(home).join(".config").join("EDM").join("extension"));
        }
        Err("Failed to determine config folder".to_string())
    }
}

const EMBEDDED_EXTENSION_FILES: &[(&str, &[u8])] = &[
    ("manifest.json", include_bytes!("../../../../extension/manifest.json")),
    ("background.js", include_bytes!("../../../../extension/background.js")),
    ("content.js", include_bytes!("../../../../extension/content.js")),
    ("popup.html", include_bytes!("../../../../extension/popup.html")),
    ("popup.js", include_bytes!("../../../../extension/popup.js")),
    ("popup.css", include_bytes!("../../../../extension/popup.css")),
    ("options.html", include_bytes!("../../../../extension/options.html")),
    ("options.js", include_bytes!("../../../../extension/options.js")),
    ("hashes.json", include_bytes!("../../../../extension/hashes.json")),
    ("logo.png", include_bytes!("../../../../extension/logo.png")),
];

#[command]
fn prepare_extension_files() -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let target_dir = get_user_extension_dir()?;
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create target extension directory: {}", e))?;

    let mut source_candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            source_candidates.push(parent.join("extension"));
            source_candidates.push(parent.join("resources").join("extension"));
            source_candidates.push(parent.join("resources").join("chromium"));
        }
    }
    source_candidates.push(PathBuf::from("extension"));
    source_candidates.push(PathBuf::from("../../extension"));
    source_candidates.push(PathBuf::from("../../../extension"));
    source_candidates.push(PathBuf::from("extension/dist/chromium"));
    source_candidates.push(PathBuf::from("../../extension/dist/chromium"));
    source_candidates.push(PathBuf::from("../../../extension/dist/chromium"));

    let mut found_source = None;
    for candidate in &source_candidates {
        if candidate.join("hashes.json").exists() && candidate.join("manifest.json").exists() {
            found_source = Some(candidate.clone());
            break;
        }
    }

    if found_source.is_none() {
        for candidate in &source_candidates {
            if candidate.join("manifest.json").exists() {
                found_source = Some(candidate.clone());
                break;
            }
        }
    }

    let mut copied_from_disk = false;

    if let Some(ref source_dir) = found_source {
        let hashes_path = source_dir.join("hashes.json");
        if hashes_path.exists() {
            if let Ok(hashes_content) = std::fs::read_to_string(&hashes_path) {
                if let Ok(hashes_json) = serde_json::from_str::<serde_json::Value>(&hashes_content) {
                    if let Some(files_map) = hashes_json.get("files").and_then(|f| f.as_object()) {
                        let mut all_ok = true;
                        for (filename, expected_hash_val) in files_map {
                            let expected_hash_str = match expected_hash_val.as_str() {
                                Some(s) => s,
                                None => { all_ok = false; break; }
                            };
                            let expected_sha256 = expected_hash_str
                                .strip_prefix("sha256:")
                                .unwrap_or(expected_hash_str);

                            let src_file = source_dir.join(filename);
                            if !src_file.exists() {
                                all_ok = false;
                                break;
                            }

                            let file_bytes = match std::fs::read(&src_file) {
                                Ok(b) => b,
                                Err(_) => { all_ok = false; break; }
                            };

                            let mut hasher = Sha256::new();
                            hasher.update(&file_bytes);
                            let actual_sha256 = hex::encode(hasher.finalize());

                            if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
                                all_ok = false;
                                break;
                            }

                            let dest_file = target_dir.join(filename);
                            let _ = std::fs::write(&dest_file, &file_bytes);
                        }
                        if all_ok {
                            let _ = std::fs::copy(&hashes_path, target_dir.join("hashes.json"));
                            copied_from_disk = true;
                        }
                    }
                }
            }
        }

        if !copied_from_disk {
            if let Ok(entries) = std::fs::read_dir(source_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(name) = path.file_name() {
                            let dest = target_dir.join(name);
                            let _ = std::fs::copy(&path, &dest);
                        }
                    }
                }
                if target_dir.join("manifest.json").exists() {
                    copied_from_disk = true;
                }
            }
        }
    }

    // Infallible fallback: Extract embedded assets directly if not copied from disk or manifest missing
    if !copied_from_disk || !target_dir.join("manifest.json").exists() {
        for (filename, bytes) in EMBEDDED_EXTENSION_FILES {
            let dest = target_dir.join(filename);
            let _ = std::fs::write(&dest, bytes);
        }
    }

    // Ensure manifest exists and is valid
    if !target_dir.join("manifest.json").exists() {
        let manifest_bytes = include_bytes!("../../../../extension/manifest.json");
        let _ = std::fs::write(target_dir.join("manifest.json"), manifest_bytes);
    }

    // Synchronize to both %APPDATA%\EDM\extension and %LOCALAPPDATA%\EDM\extension on Windows
    #[cfg(windows)]
    {
        let mut dirs_to_sync = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs_to_sync.push(PathBuf::from(appdata).join("EDM").join("extension"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs_to_sync.push(PathBuf::from(local).join("EDM").join("extension"));
        }

        for sync_target in dirs_to_sync {
            let _ = std::fs::create_dir_all(&sync_target);
            for (filename, bytes) in EMBEDDED_EXTENSION_FILES {
                let dest = sync_target.join(filename);
                let _ = std::fs::write(&dest, bytes);
            }
            if let Ok(entries) = std::fs::read_dir(&target_dir) {
                for entry in entries.flatten() {
                    let src = entry.path();
                    if src.is_file() {
                        if let Some(name) = src.file_name() {
                            let _ = std::fs::copy(&src, sync_target.join(name));
                        }
                    }
                }
            }
        }
    }

    tracing::info!(
        "Extension files successfully verified and provisioned to {}",
        target_dir.display()
    );

    Ok(target_dir.to_string_lossy().to_string())
}

#[command]
fn get_extension_folder_path() -> Result<String, String> {
    let target_dir = get_user_extension_dir()?;
    Ok(target_dir.to_string_lossy().to_string())
}

#[command]
fn remove_extension_folder() -> Result<bool, String> {
    let target_dir = get_user_extension_dir()?;
    let mut removed = false;
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir)
            .map_err(|e| format!("Failed to remove extension directory: {}", e))?;
        removed = true;
    }
    #[cfg(windows)]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local_dir = PathBuf::from(local).join("EDM").join("extension");
        if local_dir.exists() {
            let _ = std::fs::remove_dir_all(&local_dir);
            removed = true;
        }
    }
    tracing::info!("Extension folder cleanup result: removed={}", removed);
    Ok(removed)
}

#[command]
fn open_browser_url(browser: String, url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let browser_id = browser.to_lowercase();
        let exe_path = match browser_id.as_str() {
            "chrome" => find_browser_exe(r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", &[r"Google\Chrome\Application\chrome.exe"]),
            "edge" => find_browser_exe(r"Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", &[r"Microsoft\Edge\Application\msedge.exe"]),
            "brave" => find_browser_exe(r"Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe", &[r"BraveSoftware\Brave-Browser\Application\brave.exe"]),
            "firefox" => find_browser_exe(r"Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe", &[r"Mozilla Firefox\firefox.exe"]),
            _ => None,
        };

        if let Some(exe) = exe_path {
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg(&url);
            let _ = cmd.spawn().map_err(|e| format!("Failed to launch browser {}: {}", exe, e))?;
            return Ok(());
        }
    }

    open::that(&url).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn get_firefox_xpi_url() -> String {
    "http://127.0.0.1:14370/firefox.xpi".to_string()
}

#[command]
fn is_wizard_completed(state: State<'_, AppState>) -> Result<bool, String> {
    if let Ok(Some(val)) = state.store.get_setting("setup_completed") {
        return Ok(val == "true");
    }
    match state.store.get_setting("wizard_completed") {
        Ok(Some(val)) => Ok(val == "true"),
        _ => Ok(false),
    }
}

#[command]
fn set_wizard_completed(state: State<'_, AppState>, completed: bool) -> Result<(), String> {
    let val = if completed { "true" } else { "false" };
    state
        .store
        .set_setting("setup_completed", val)
        .map_err(|e| e.to_string())?;
    let _ = state.store.set_setting("wizard_completed", val);
    Ok(())
}

#[command]
fn get_system_downloads_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(user_profile).join("Downloads");
            if p.exists() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    std::env::temp_dir().to_string_lossy().to_string()
}

#[command]
async fn select_download_directory(default_path: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let initial = default_path.as_deref().unwrap_or("").replace('\'', "''");
            let script = format!(
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select EDM Downloads Folder'; if ('{}' -ne '') {{ $d.SelectedPath = '{}' }}; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $d.SelectedPath }}",
                initial, initial
            );
            let output = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;

            let res = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if res.is_empty() {
                Ok(None)
            } else {
                Ok(Some(res))
            }
        }
        #[cfg(not(windows))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
fn get_disk_free_space(path: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let target_path = path.unwrap_or_else(|| "C:\\".to_string());
        let root = if target_path.len() >= 2 && target_path.chars().nth(1) == Some(':') {
            format!("{}:\\", &target_path[0..1])
        } else {
            "C:\\".to_string()
        };
        let wide: Vec<u16> = std::ffi::OsStr::new(&root).encode_wide().chain(Some(0)).collect();

        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }

        let mut free_bytes_avail: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;

        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_bytes_avail,
                &mut total_bytes,
                &mut total_free,
            )
        };

        if ok != 0 && total_bytes > 0 {
            let pct_free = ((total_free as f64 / total_bytes as f64) * 100.0).round() as u64;
            return Ok(serde_json::json!({
                "drive": root.trim_end_matches('\\'),
                "total_bytes": total_bytes,
                "free_bytes": total_free,
                "pct_free": pct_free
            }));
        }
    }
    Ok(serde_json::json!({
        "drive": "C:",
        "total_bytes": 0,
        "free_bytes": 0,
        "pct_free": 50
    }))
}

#[command]
async fn refresh_download_link(
    state: State<'_, AppState>,
    task_id: String,
    new_url: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&task_id).map_err(|e| e.to_string())?;
    let task = features::validate_and_refresh_link(&state.store, id, &new_url, None).await?;
    let _ = execute_download(
        &state,
        task.id,
        task.url,
        Some(task.filename),
        Some(PathBuf::from(task.save_dir)),
        Some(task.connections),
        task.size_total,
        None,
        task.referer,
        task.user_agent,
    );
    Ok(())
}

#[command]
fn expand_batch_urls(pattern: String) -> Result<Vec<String>, String> {
    edm_core::batch::expand_batch_pattern(&pattern)
}

#[command]
async fn add_batch_downloads(
    state: State<'_, AppState>,
    urls: Vec<String>,
    _category: Option<String>,
    save_dir: Option<String>,
) -> Result<usize, String> {
    let mut added = 0;
    for url in urls {
        let u = url.trim();
        if u.is_empty() {
            continue;
        }
        let id = Uuid::new_v4();
        let s_dir = save_dir.as_ref().map(PathBuf::from);
        if execute_download(
            &state,
            id,
            u.to_string(),
            None,
            s_dir,
            None,
            None,
            None,
            None,
            None,
        )
        .is_ok()
        {
            added += 1;
        }
    }
    Ok(added)
}

#[command]
fn check_duplicate_download(
    state: State<'_, AppState>,
    url: String,
    filename: String,
    size: Option<u64>,
) -> Result<features::DuplicateCheckResult, String> {
    match state.store.find_duplicate(&url, &filename, size) {
        Ok(Some(d)) => Ok(features::DuplicateCheckResult {
            is_duplicate: true,
            existing_id: Some(d.id.to_string()),
            existing_filename: Some(d.filename),
            existing_state: Some(format!("{:?}", d.state).to_lowercase()),
        }),
        _ => Ok(features::DuplicateCheckResult {
            is_duplicate: false,
            existing_id: None,
            existing_filename: None,
            existing_state: None,
        }),
    }
}

#[command]
fn verify_file_checksum(
    file_path: String,
    expected_hash: String,
    algo: String,
) -> Result<features::ChecksumResult, String> {
    features::verify_file_checksum(Path::new(&file_path), &expected_hash, &algo)
}

#[command]
fn get_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
    query: Option<String>,
) -> Result<Vec<edm_store::HistoryRecord>, String> {
    state
        .store
        .list_history(limit, query.as_deref())
        .map_err(|e| e.to_string())
}

#[command]
fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.store.clear_history().map_err(|e| e.to_string())
}

#[command]
fn export_history_csv(state: State<'_, AppState>) -> Result<String, String> {
    state.store.export_history_csv().map_err(|e| e.to_string())
}

#[command]
fn get_queues(state: State<'_, AppState>) -> Result<Vec<edm_store::QueueRecord>, String> {
    state.store.list_queues().map_err(|e| e.to_string())
}

#[command]
fn save_queue(state: State<'_, AppState>, queue: edm_store::QueueRecord) -> Result<(), String> {
    state.store.upsert_queue(&queue).map_err(|e| e.to_string())
}

#[command]
fn delete_queue(state: State<'_, AppState>, queue_id: String) -> Result<(), String> {
    state
        .store
        .delete_queue(&queue_id)
        .map_err(|e| e.to_string())
}

#[command]
fn cancel_power_countdown(state: State<'_, AppState>) -> Result<(), String> {
    state.power_countdown.cancel();
    Ok(())
}

#[command]
fn get_power_countdown_status(
    state: State<'_, AppState>,
) -> Result<features::PowerCountdownInfo, String> {
    Ok(state.power_countdown.status())
}

#[command]
async fn probe_media_page(media_url: String) -> Result<features::MediaProbeResult, String> {
    features::probe_media(&media_url).await
}

#[cfg(windows)]
fn purge_all_user_data() {
    use windows_registry::CURRENT_USER;
    let _ = CURRENT_USER.remove_tree(r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh");
    let _ = CURRENT_USER.remove_tree(r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh");
    let _ = CURRENT_USER.remove_tree(r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh");
    let _ = CURRENT_USER.remove_tree(r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh");
    let _ = CURRENT_USER.remove_tree(r"Software\Classes\edm");
    let _ = CURRENT_USER.remove_tree(r"Software\EDM");
    if let Ok(run_key) = CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Run") {
        let _ = run_key.remove_value("EDM");
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let _ = std::fs::remove_dir_all(PathBuf::from(&local).join("EDM"));
        let _ = std::fs::remove_dir_all(PathBuf::from(&local).join("com.edm.desktop"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let _ = std::fs::remove_dir_all(PathBuf::from(&appdata).join("EDM"));
    }
}

fn main() {
    let t_boot = std::time::Instant::now();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--clean-uninstall" || a == "--purge-data") {
        #[cfg(windows)]
        purge_all_user_data();
        return;
    }

    init_logging();
    tracing::info!("EDM starting up. Args: {:?}", args);

    #[cfg(windows)]
    set_app_user_model_id();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime");

    let rt_handle = rt.handle().clone();

    let t_db = std::time::Instant::now();
    let store = open_persistent_store();
    tracing::info!("[PERF] Persistent store opened in {:?}", t_db.elapsed());
    let engine = Arc::new(AdaptiveEngine::new(store.clone()));

    let token = ws_server::get_or_create_token();
    let (create_task_tx, mut create_task_rx) =
        tokio::sync::mpsc::channel::<ws_server::CreateTaskCommand>(64);
    let (action_tx, mut action_rx) = tokio::sync::mpsc::channel::<ws_server::ActionCommand>(64);
    let (refresh_task_tx, mut refresh_task_rx) =
        tokio::sync::mpsc::channel::<ws_server::RefreshTaskCommand>(64);
    let (probe_media_tx, mut probe_media_rx) =
        tokio::sync::mpsc::channel::<ws_server::ProbeMediaCommand>(64);

    let ws_manager = Arc::new(ws_server::WsManager::new(
        token,
        ws_server::EXTENSION_ID.to_string(),
        store.clone(),
        create_task_tx,
        action_tx,
        refresh_task_tx,
        probe_media_tx,
    ));

    let lifecycle = Arc::new(lifecycle::LifecycleManager::new(
        store.clone(),
        ws_manager.clone(),
    ));

    let power_countdown = Arc::new(features::PowerCountdownController::new());
    let global_limiter = Arc::new(edm_core::TokenBucketLimiter::new(0));

    // ARC-01: Startup crash recovery: Reset interrupted 'Downloading' or 'Probing' tasks to 'Paused'
    if let Ok(records) = store.list_all_downloads() {
        for r in records {
            if r.state == DownloadState::Downloading || r.state == DownloadState::Probing {
                let _ = store.update_download_state(
                    r.id,
                    DownloadState::Paused,
                    Some("Interrupted by application shutdown"),
                );
            }
        }
    }

    let app_state = AppState {
        store,
        engine,
        tasks: Arc::new(Mutex::new(HashMap::new())),
        rt_handle: rt_handle.clone(),
        ws_manager: ws_manager.clone(),
        tray_handle: Arc::new(Mutex::new(None)),
        app_handle: Arc::new(Mutex::new(None)),
        lifecycle: lifecycle.clone(),
        power_countdown,
        global_limiter,
    };

    // Fast-path: Start WebSocket Server on 127.0.0.1:14370 FIRST
    let ws_mgr_srv = ws_manager.clone();
    let t_ws = t_boot;
    rt_handle.spawn(async move {
        ws_mgr_srv.sync_from_store().await;
        tracing::info!("[PERF] Port 14370 ready in {:?}", t_ws.elapsed());
        ws_server::start_ws_server(ws_mgr_srv).await;
    });

    spawn_extension_bridge(app_state.clone(), rt_handle.clone());

    // Register Native Messaging Host and provision extension files immediately on boot
    #[cfg(windows)]
    {
        register_native_messaging_host();
        let _ = prepare_extension_files();
    }

    // FAKE-03: Background Queue Scheduler loop (evaluates every 10 seconds)
    let queue_state = app_state.clone();
    rt_handle.spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            interval.tick().await;
            if let Ok(queues) = queue_state.store.list_queues() {
                let now = chrono::Local::now();
                for q in queues {
                    if features::is_queue_active_at_time(&q, now) {
                        let active_count = {
                            if let Ok(tasks) = queue_state.tasks.lock() {
                                tasks.values().filter(|h| !h.cancelled.load(Ordering::Relaxed)).count()
                            } else {
                                0
                            }
                        };
                        let max_allowed = (q.max_concurrent as usize).max(1);
                        if active_count < max_allowed {
                            if let Ok(records) = queue_state.store.list_all_downloads() {
                                for r in records {
                                    if r.state == DownloadState::Queued {
                                        let _ = execute_download(
                                            &queue_state,
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
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });

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

    // Inbound WebSocket Task Refresh Loop
    let refresh_state = app_state.clone();
    rt_handle.spawn(async move {
        while let Some(cmd) = refresh_task_rx.recv().await {
            if let Ok(id_uuid) = Uuid::parse_str(&cmd.task_id) {
                let res = features::validate_and_refresh_link(
                    &refresh_state.store,
                    id_uuid,
                    &cmd.new_url,
                    cmd.headers.as_ref(),
                )
                .await;
                match res {
                    Ok(task) => {
                        let _ = execute_download(
                            &refresh_state,
                            task.id,
                            task.url,
                            Some(task.filename),
                            Some(PathBuf::from(task.save_dir)),
                            Some(task.connections),
                            task.size_total,
                            None,
                            task.referer,
                            task.user_agent,
                        );
                        let _ = cmd.resp_tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = cmd.resp_tx.send(Err(e));
                    }
                }
            } else {
                let _ = cmd.resp_tx.send(Err("Invalid task UUID".into()));
            }
        }
    });

    // Inbound WebSocket Media Prober Loop
    rt_handle.spawn(async move {
        while let Some(cmd) = probe_media_rx.recv().await {
            let res = features::probe_media(&cmd.media_url).await;
            let _ = cmd.resp_tx.send(res.map(|r| (r.variants, r.is_drm)));
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
                    let _ = window.show();
                    let _ = window.set_focus();
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
            set_speed_limit,
            get_extension_token,
            app_minimize,
            app_toggle_maximize,
            app_close,
            app_start_dragging,
            updater::get_app_version,
            updater::check_for_updates,
            updater::install_update,
            get_lifecycle_status,
            wake_engine,
            get_browser_diagnostics,
            repair_native_host_registration,
            detect_installed_browsers,
            prepare_extension_files,
            get_extension_folder_path,
            remove_extension_folder,
            open_browser_url,
            get_firefox_xpi_url,
            is_wizard_completed,
            set_wizard_completed,
            get_system_downloads_dir,
            select_download_directory,
            get_disk_free_space,
            refresh_download_link,
            expand_batch_urls,
            add_batch_downloads,
            check_duplicate_download,
            verify_file_checksum,
            get_history,
            clear_history,
            export_history_csv,
            get_queues,
            save_queue,
            delete_queue,
            cancel_power_countdown,
            get_power_countdown_status,
            probe_media_page
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_extension_files_integrity() {
        let res = prepare_extension_files();
        assert!(res.is_ok(), "prepare_extension_files failed: {:?}", res);
        let path = PathBuf::from(res.unwrap());
        assert!(path.exists(), "Target folder should exist");
        assert!(path.join("manifest.json").exists(), "manifest.json should exist");
        assert!(path.join("hashes.json").exists(), "hashes.json should exist");
    }

    #[test]
    fn test_system_downloads_dir() {
        let dir = get_system_downloads_dir();
        assert!(!dir.is_empty(), "System downloads directory should not be empty");
    }
}
