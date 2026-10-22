use crate::api::tasks::AppState;
use crate::config::AppSettings;
use crate::engine::integrations::register_windows_integrations;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

pub async fn get_settings_handler(
    State(state): State<AppState>,
) -> Result<Json<AppSettings>, (StatusCode, String)> {
    let settings = state
        .db
        .load_settings()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(settings))
}

pub async fn update_settings_handler(
    State(state): State<AppState>,
    Json(payload): Json<AppSettings>,
) -> Result<Json<AppSettings>, (StatusCode, String)> {
    state
        .db
        .save_settings(&payload)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // If Windows integrations enabled, register protocol
    if payload.protocol_vortex {
        if let Ok(exe) = std::env::current_exe() {
            register_windows_integrations(&exe);
        }
    }

    Ok(Json(payload))
}
