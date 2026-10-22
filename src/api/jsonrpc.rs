use crate::api::tasks::AppState;
use crate::database::Task;
use crate::engine::categorization::resolve_destination_path;
use axum::extract::State;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Vec<Value>>,
}

#[derive(Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

pub async fn jsonrpc_handler(
    State(state): State<AppState>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let req_id = req.id.clone();
    let method = req.method.as_str();
    let params = req.params.unwrap_or_default();

    // Validate secret token if configured
    let settings = state.db.load_settings().unwrap_or_default();
    let mut param_offset = 0;
    if !settings.pair_token.is_empty() {
        if let Some(first) = params.first().and_then(|v| v.as_str()) {
            if first.starts_with("token:") {
                let token = &first["token:".len()..];
                if token != settings.pair_token {
                    return Json(JsonRpcResponse {
                        jsonrpc: "2.0".to_string(),
                        id: req_id,
                        result: None,
                        error: Some(json!({ "code": 1, "message": "Unauthorized" })),
                    });
                }
                param_offset = 1;
            }
        }
    }

    match method {
        "aria2.getVersion" => Json(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req_id,
            result: Some(json!({
                "version": "1.36.0",
                "enabledFeatures": ["Async DNS", "BitTorrent", "Firefox3-Cookie", "GZip", "HTTPS", "Message Digest", "Metalink", "XML-RPC"]
            })),
            error: None,
        }),

        "aria2.addUri" => {
            let uris = params
                .get(param_offset)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if let Some(first_url) = uris.first().and_then(|u| u.as_str()) {
                let options = params.get(param_offset + 1).cloned().unwrap_or(json!({}));
                let out_filename = options
                    .get("out")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let base_dir = PathBuf::from(&settings.download_path);
                let fallback_name = out_filename
                    .unwrap_or_else(|| "download.bin".to_string());
                let (cat, resolved_path) =
                    resolve_destination_path(&fallback_name, &base_dir, settings.auto_categorize);

                let gid = uuid::Uuid::new_v4().to_string();
                let now = Utc::now();
                let task = Task {
                    id: gid.clone(),
                    url: first_url.to_string(),
                    title: fallback_name.clone(),
                    filename: fallback_name,
                    save_path: resolved_path.to_string_lossy().to_string(),
                    total_bytes: -1,
                    downloaded_bytes: 0,
                    status: "queued".to_string(),
                    speed: 0.0,
                    eta: 0,
                    threads: settings.pre_allocated_threads,
                    category: cat.as_str().to_string(),
                    error_msg: None,
                    created_at: now,
                    updated_at: now,
                    completed_at: None,
                };

                let _ = state.db.insert_task(&task);

                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: Some(json!(gid)),
                    error: None,
                })
            } else {
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: None,
                    error: Some(json!({ "code": -32602, "message": "Invalid params: URI missing" })),
                })
            }
        }

        "aria2.tellStatus" => {
            if let Some(gid) = params.get(param_offset).and_then(|v| v.as_str()) {
                if let Ok(Some(task)) = state.db.get_task(gid) {
                    let status_str = match task.status.as_str() {
                        "downloading" => "active",
                        "queued" => "waiting",
                        "paused" => "paused",
                        "completed" => "complete",
                        _ => "error",
                    };

                    let res = json!({
                        "gid": task.id,
                        "status": status_str,
                        "totalLength": task.total_bytes.max(0).to_string(),
                        "completedLength": task.downloaded_bytes.to_string(),
                        "downloadSpeed": (task.speed as u64).to_string(),
                        "dir": task.save_path,
                        "files": [{
                            "index": "1",
                            "path": task.save_path,
                            "length": task.total_bytes.max(0).to_string(),
                            "completedLength": task.downloaded_bytes.to_string(),
                            "selected": "true",
                            "uris": [{ "uri": task.url, "status": "used" }]
                        }]
                    });

                    return Json(JsonRpcResponse {
                        jsonrpc: "2.0".to_string(),
                        id: req_id,
                        result: Some(res),
                        error: None,
                    });
                }
            }
            Json(JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req_id,
                result: None,
                error: Some(json!({ "code": 1, "message": "GID not found" })),
            })
        }

        "aria2.tellActive" => {
            let tasks = state.db.list_tasks().unwrap_or_default();
            let active: Vec<_> = tasks
                .into_iter()
                .filter(|t| t.status == "downloading")
                .map(|t| {
                    json!({
                        "gid": t.id,
                        "status": "active",
                        "totalLength": t.total_bytes.max(0).to_string(),
                        "completedLength": t.downloaded_bytes.to_string(),
                        "downloadSpeed": (t.speed as u64).to_string(),
                    })
                })
                .collect();

            Json(JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req_id,
                result: Some(json!(active)),
                error: None,
            })
        }

        "aria2.pause" => {
            if let Some(gid) = params.get(param_offset).and_then(|v| v.as_str()) {
                state.queue.pause_task(gid);
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: Some(json!(gid)),
                    error: None,
                })
            } else {
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: None,
                    error: Some(json!({ "code": 1, "message": "Missing GID" })),
                })
            }
        }

        "aria2.unpause" => {
            if let Some(gid) = params.get(param_offset).and_then(|v| v.as_str()) {
                state.queue.resume_task(gid);
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: Some(json!(gid)),
                    error: None,
                })
            } else {
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: None,
                    error: Some(json!({ "code": 1, "message": "Missing GID" })),
                })
            }
        }

        "aria2.remove" => {
            if let Some(gid) = params.get(param_offset).and_then(|v| v.as_str()) {
                state.queue.cancel_task(gid);
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: Some(json!(gid)),
                    error: None,
                })
            } else {
                Json(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: req_id,
                    result: None,
                    error: Some(json!({ "code": 1, "message": "Missing GID" })),
                })
            }
        }

        _ => Json(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req_id,
            result: None,
            error: Some(json!({ "code": -32601, "message": "Method not found" })),
        }),
    }
}
