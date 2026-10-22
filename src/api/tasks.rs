use crate::database::{Database, Task};
use crate::engine::categorization::resolve_destination_path;
use crate::engine::http_downloader::probe_url;
use crate::engine::media_extractor::{extract_media_info, is_media_url};
use crate::engine::queue::QueueManager;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub queue: Arc<QueueManager>,
    pub http_client: reqwest::Client,
}

#[derive(Deserialize)]
pub struct ProbeRequest {
    pub url: String,
}

#[derive(Serialize)]
pub struct ProbeResponse {
    pub url: String,
    pub filename: String,
    pub total_bytes: i64,
    pub accepts_ranges: bool,
    pub is_media: bool,
    pub media_info: Option<serde_json::Value>,
}

pub async fn probe_handler(
    State(state): State<AppState>,
    Json(payload): Json<ProbeRequest>,
) -> Result<Json<ProbeResponse>, (StatusCode, String)> {
    let url = payload.url.trim();
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Empty URL".to_string()));
    }

    let is_media = is_media_url(url);
    let mut media_json = None;

    if is_media {
        if let Ok(meta) = extract_media_info(url).await {
            media_json = serde_json::to_value(&meta).ok();
        }
    }

    match probe_url(&state.http_client, url).await {
        Ok(probe) => Ok(Json(ProbeResponse {
            url: probe.url,
            filename: probe.filename,
            total_bytes: probe.total_bytes,
            accepts_ranges: probe.accepts_ranges,
            is_media,
            media_info: media_json,
        })),
        Err(e) => {
            // If probe failed but it's a media URL, return fallback
            if is_media {
                Ok(Json(ProbeResponse {
                    url: url.to_string(),
                    filename: "media_download.mp4".to_string(),
                    total_bytes: -1,
                    accepts_ranges: true,
                    is_media: true,
                    media_info: media_json,
                }))
            } else {
                Err((StatusCode::BAD_REQUEST, e))
            }
        }
    }
}

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub url: String,
    pub filename: Option<String>,
    pub save_path: Option<String>,
    pub threads: Option<u32>,
}

pub async fn create_task_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<Json<Task>, (StatusCode, String)> {
    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "URL is required".to_string()));
    }

    let settings = state
        .db
        .load_settings()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Probe to resolve filename & size if not given
    let probe = probe_url(&state.http_client, &url).await.ok();
    let filename = payload
        .filename
        .filter(|f| !f.trim().is_empty())
        .or_else(|| probe.as_ref().map(|p| p.filename.clone()))
        .unwrap_or_else(|| "download.bin".to_string());

    let total_bytes = probe.as_ref().map(|p| p.total_bytes).unwrap_or(-1);

    let base_dir = PathBuf::from(&settings.download_path);
    let (cat, resolved_path) =
        resolve_destination_path(&filename, &base_dir, settings.auto_categorize);

    let save_path = payload
        .save_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| resolved_path.to_string_lossy().to_string());

    let threads = payload
        .threads
        .unwrap_or(settings.pre_allocated_threads)
        .clamp(1, 64);

    let now = Utc::now();
    let task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        url,
        title: filename.clone(),
        filename,
        save_path,
        total_bytes,
        downloaded_bytes: 0,
        status: "queued".to_string(),
        speed: 0.0,
        eta: 0,
        threads,
        category: cat.as_str().to_string(),
        error_msg: None,
        created_at: now,
        updated_at: now,
        completed_at: None,
    };

    state
        .db
        .insert_task(&task)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(task))
}

pub async fn list_tasks_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<Task>>, (StatusCode, String)> {
    let tasks = state
        .db
        .list_tasks()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(tasks))
}

pub async fn get_task_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Task>, (StatusCode, String)> {
    match state.db.get_task(&id) {
        Ok(Some(task)) => Ok(Json(task)),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Task not found".to_string())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

pub async fn pause_task_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    state.queue.pause_task(&id);
    StatusCode::OK
}

pub async fn resume_task_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    state.queue.resume_task(&id);
    StatusCode::OK
}

pub async fn delete_task_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    state.queue.cancel_task(&id);
    StatusCode::OK
}

pub async fn open_file_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if let Ok(Some(task)) = state.db.get_task(&id) {
        let p = Path::new(&task.save_path);
        if p.exists() {
            let _ = open::that(p);
            return Ok(StatusCode::OK);
        }
    }
    Err((StatusCode::NOT_FOUND, "File not found on disk".to_string()))
}

pub async fn open_folder_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if let Ok(Some(task)) = state.db.get_task(&id) {
        let p = Path::new(&task.save_path);
        let folder = if p.is_file() {
            p.parent().unwrap_or(p)
        } else {
            p
        };
        if folder.exists() {
            let _ = open::that(folder);
            return Ok(StatusCode::OK);
        }
    }
    Err((StatusCode::NOT_FOUND, "Folder not found".to_string()))
}
