// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use edm_core::adaptive::{
    AdaptiveConfig, AdaptiveDownloadTask, AdaptiveEngine, AdaptiveTelemetry,
};
use edm_core::Probe;
use edm_store::Store;
use reqwest::Client;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{command, State};
use uuid::Uuid;

struct ActiveTaskHandle {
    cancelled: Arc<AtomicBool>,
    telemetry: Arc<Mutex<Option<AdaptiveTelemetry>>>,
}

struct AppState {
    _store: Store,
    engine: Arc<AdaptiveEngine>,
    tasks: Arc<Mutex<HashMap<String, ActiveTaskHandle>>>,
}

fn validate_url_security(raw_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw_url).map_err(|e| format!("Security violation: Invalid URL format: {}", e))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Security violation: Only HTTP and HTTPS protocols are allowed".into());
    }
    if let Some(host) = parsed.host_str() {
        let h = host.to_lowercase();
        if h == "169.254.169.254" || h == "metadata.google.internal" || h == "instance-data" || h.ends_with(".internal") {
            return Err("Security violation: Blocked access to cloud metadata endpoint".into());
        }
    }
    Ok(parsed)
}

#[command]
async fn probe_url(url: String) -> Result<serde_json::Value, String> {
    validate_url_security(&url)?;
    let client = Client::new();
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
    validate_url_security(&url)?;
    let id = Uuid::new_v4();
    let id_str = id.to_string();

    let raw_name = filename.unwrap_or_else(|| {
        url.split('/').last().unwrap_or("download.bin").split('?').next().unwrap_or("download.bin").to_string()
    });
    let clean_name = edm_core::sanitizer::Sanitizer::sanitize_filename(&raw_name);

    let save_path = save_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());

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

    let task = AdaptiveDownloadTask {
        id,
        url,
        filename: clean_name,
        save_dir: save_path,
        config,
        limiter: None,
        cancelled,
    };

    let engine = state.engine.clone();
    let telem_target = telemetry_store.clone();

    tokio::spawn(async move {
        let cb = Arc::new(move |telem: AdaptiveTelemetry| {
            if let Ok(mut lock) = telem_target.lock() {
                *lock = Some(telem);
            }
        });
        let _ = engine.download(task, Some(cb)).await;
    });

    Ok(serde_json::json!({
        "status": "started",
        "id": id_str
    }))
}

#[command]
fn pause_download(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        task.cancelled.store(true, Ordering::Relaxed);
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
fn get_settings(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    match state._store.get_setting("app_settings") {
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
        ._store
        .set_setting("app_settings", &json_str)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": "saved" }))
}

fn main() {
    let store = Store::open_in_memory().expect("failed to open store");
    let engine = Arc::new(AdaptiveEngine::new(store.clone()));
    let app_state = AppState {
        _store: store,
        engine,
        tasks: Arc::new(Mutex::new(HashMap::new())),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            probe_url,
            start_download,
            pause_download,
            get_download_telemetry,
            get_stats,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running EDM desktop application");
}
