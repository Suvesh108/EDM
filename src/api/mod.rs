pub mod jsonrpc;
pub mod settings;
pub mod sse;
pub mod tasks;

use axum::routing::{get, post};
use axum::Router;
use tasks::AppState;

pub fn create_api_router(state: AppState) -> Router {
    Router::new()
        // Tasks API
        .route("/api/tasks", get(tasks::list_tasks_handler).post(tasks::create_task_handler))
        .route("/api/tasks/probe", post(tasks::probe_handler))
        .route("/api/tasks/:id", get(tasks::get_task_handler).delete(tasks::delete_task_handler))
        .route("/api/tasks/:id/pause", post(tasks::pause_task_handler))
        .route("/api/tasks/:id/resume", post(tasks::resume_task_handler))
        .route("/api/tasks/:id/open_file", post(tasks::open_file_handler))
        .route("/api/tasks/:id/open_folder", post(tasks::open_folder_handler))
        // Settings API
        .route("/api/settings", get(settings::get_settings_handler).post(settings::update_settings_handler))
        // Server-Sent Events live telemetry
        .route("/api/events", get(sse::sse_handler))
        // Aria2 JSON-RPC 2.0 Compatibility Endpoint
        .route("/jsonrpc", post(jsonrpc::jsonrpc_handler))
        .with_state(state)
}
