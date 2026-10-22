mod api;
mod config;
mod database;
mod engine;
mod logger;
mod ui;

use api::tasks::AppState;
use database::Database;
use engine::integrations::register_windows_integrations;
use engine::queue::QueueManager;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    logger::init();
    info!("⚡ Starting Vortex Downloader v0.6.9 (Pure Rust Engine)...");

    // Initialize Database
    let db = Database::new()?;
    let settings = db.load_settings()?;
    info!("Database initialized successfully with SQLite WAL mode.");

    // Register Windows Integrations if enabled
    if settings.protocol_vortex {
        if let Ok(exe) = std::env::current_exe() {
            register_windows_integrations(&exe);
        }
    }

    // Initialize Queue Manager
    let queue = Arc::new(QueueManager::new(db.clone()));
    queue.clone().start_worker_loop();

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(32)
        .build()?;

    let state = AppState {
        db: db.clone(),
        queue: queue.clone(),
        http_client,
    };

    // CORS configuration for browser extensions
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build Router: API routes + Embedded Static UI assets
    let app = api::create_api_router(state)
        .fallback(ui::embedded::static_handler)
        .layer(cors);

    let port = 5001;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Server listening on http://127.0.0.1:{}", port);

    // Open browser unless flagged
    let args: Vec<String> = std::env::args().collect();
    let no_browser = args.iter().any(|a| a == "--no-browser" || a == "-n");
    if !no_browser {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            let url = format!("http://localhost:{}", port);
            let _ = open::that(&url);
        });
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down Vortex Downloader...");
        })
        .await?;

    Ok(())
}
