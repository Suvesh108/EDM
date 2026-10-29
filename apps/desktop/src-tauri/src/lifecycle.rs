use edm_store::Store;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Active,
    Warm,
    ListenerSleep,
    DeepSleep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleStatus {
    pub state: LifecycleState,
    pub active_tasks: usize,
    pub window_open: bool,
    pub warm_timeout_secs: u64,
    pub idle_exit_minutes: Option<u64>,
    pub wake_count: u64,
    pub seconds_in_state: u64,
}

pub struct LifecycleManager {
    current_state: Arc<RwLock<LifecycleState>>,
    state_entered_at: Arc<RwLock<Instant>>,
    last_activity_at: Arc<RwLock<Instant>>,
    last_wake_at: Arc<RwLock<Option<Instant>>>,
    wake_count: Arc<AtomicU64>,
    warm_timeout_secs: Arc<AtomicU64>,
    idle_exit_minutes: Arc<RwLock<Option<u64>>>,
    keep_awake: Arc<AtomicBool>,
    app_handle: Arc<std::sync::Mutex<Option<AppHandle>>>,
    store: Store,
    ws_manager: Arc<crate::ws_server::WsManager>,
}

impl LifecycleManager {
    pub fn new(store: Store, ws_manager: Arc<crate::ws_server::WsManager>) -> Self {
        // Read initial settings
        let mut exit_mins = Some(15u64); // default 15 mins
        let mut keep = false;

        if let Ok(Some(s)) = store.get_setting("app_settings") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(general) = val.get("general") {
                    if let Some(k) = general.get("keepAwake").and_then(|v| v.as_bool()) {
                        keep = k;
                    }
                    if let Some(exit_val) = general.get("idleExitMinutes") {
                        if exit_val.is_null() || exit_val.as_str() == Some("never") {
                            exit_mins = None;
                        } else if let Some(n) = exit_val.as_u64() {
                            exit_mins = Some(n);
                        }
                    }
                }
            }
        }

        Self {
            current_state: Arc::new(RwLock::new(LifecycleState::Active)),
            state_entered_at: Arc::new(RwLock::new(Instant::now())),
            last_activity_at: Arc::new(RwLock::new(Instant::now())),
            last_wake_at: Arc::new(RwLock::new(None)),
            wake_count: Arc::new(AtomicU64::new(0)),
            warm_timeout_secs: Arc::new(AtomicU64::new(60)), // starts at 60s
            idle_exit_minutes: Arc::new(RwLock::new(exit_mins)),
            keep_awake: Arc::new(AtomicBool::new(keep)),
            app_handle: Arc::new(std::sync::Mutex::new(None)),
            store,
            ws_manager,
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    pub fn get_app_handle(&self) -> Option<AppHandle> {
        self.app_handle.lock().unwrap().clone()
    }

    #[allow(dead_code)]
    pub async fn get_state(&self) -> LifecycleState {
        *self.current_state.read().await
    }

    pub async fn record_activity(&self) {
        *self.last_activity_at.write().await = Instant::now();
        let current = *self.current_state.read().await;
        if current != LifecycleState::Active {
            self.transition_to(
                LifecycleState::Active,
                "Active download or user interaction",
            )
            .await;
        }
    }

    pub async fn record_wake(&self, show_window: bool) {
        let now = Instant::now();
        self.wake_count.fetch_add(1, Ordering::Relaxed);

        // Adaptive Warm Timeout: if woken recently (< 10 min), stretch warm duration up to 300s
        let mut prev_wake = self.last_wake_at.write().await;
        if let Some(last) = *prev_wake {
            if now.duration_since(last) < Duration::from_secs(600) {
                let current_timeout = self.warm_timeout_secs.load(Ordering::Relaxed);
                let new_timeout = (current_timeout + 60).min(300);
                self.warm_timeout_secs.store(new_timeout, Ordering::Relaxed);
                info!(
                    "Frequent wakes detected; stretched Warm timeout to {}s",
                    new_timeout
                );
            }
        }
        *prev_wake = Some(now);
        *self.last_activity_at.write().await = now;

        self.transition_to(LifecycleState::Active, "Woken by browser extension / NMH")
            .await;

        if show_window {
            self.ensure_window_open().await;
        }
    }

    pub async fn update_settings(&self, keep_awake: bool, idle_exit_mins: Option<u64>) {
        self.keep_awake.store(keep_awake, Ordering::Relaxed);
        *self.idle_exit_minutes.write().await = idle_exit_mins;
    }

    pub async fn ensure_window_open(&self) {
        if let Some(app) = self.get_app_handle() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                // Recreate main window on-demand using WebviewWindowBuilder
                info!("Recreating main webview window on-demand...");
                let builder =
                    WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
                        .title("EDM — Edge Download Manager")
                        .inner_size(1080.0, 720.0)
                        .min_inner_size(800.0, 500.0)
                        .center()
                        .decorations(false)
                        .transparent(true);

                match builder.build() {
                    Ok(w) => {
                        let _ = w.show();
                        let _ = w.set_focus();
                        info!("Main webview window successfully created on-demand");
                    }
                    Err(e) => {
                        warn!("Failed to create main webview window: {}", e);
                    }
                }
            }
        }
    }

    pub async fn destroy_window_if_closed(&self) {
        if let Some(app) = self.get_app_handle() {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(is_visible) = window.is_visible() {
                    if !is_visible {
                        info!("Destroying hidden main window to release WebView2 processes and memory");
                        let _ = window.destroy();
                    }
                }
            }
        }
    }

    pub async fn check_lifecycle_step(
        &self,
        active_download_count: usize,
        uncommitted_writes: bool,
    ) {
        // Invariant Guard 1: Never sleep or exit if tasks are downloading/queued, writes pending, or keep-awake set
        let has_active_tasks = active_download_count > 0;
        let is_keep_awake = self.keep_awake.load(Ordering::Relaxed);

        let window_open = if let Some(app) = self.get_app_handle() {
            if let Some(window) = app.get_webview_window("main") {
                window.is_visible().unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };

        if has_active_tasks || uncommitted_writes || window_open || is_keep_awake {
            if *self.current_state.read().await != LifecycleState::Active {
                self.transition_to(LifecycleState::Active, "Active tasks or window present")
                    .await;
            }
            return;
        }

        let now = Instant::now();
        let last_act = *self.last_activity_at.read().await;
        let idle_dur = now.duration_since(last_act);
        let current = *self.current_state.read().await;

        match current {
            LifecycleState::Active => {
                // Step down from Active to Warm when idle with window closed
                self.transition_to(LifecycleState::Warm, "No active tasks and window closed")
                    .await;
                // Destroy window after grace period to reclaim WebView2 RAM
                self.destroy_window_if_closed().await;
            }

            LifecycleState::Warm => {
                let warm_limit =
                    Duration::from_secs(self.warm_timeout_secs.load(Ordering::Relaxed));
                if idle_dur >= warm_limit {
                    // Transition to ListenerSleep: drop heavy buffers, HTTP connection pools
                    self.transition_to(
                        LifecycleState::ListenerSleep,
                        "Warm timeout elapsed with zero activity",
                    )
                    .await;
                }
            }

            LifecycleState::ListenerSleep => {
                let exit_mins = *self.idle_exit_minutes.read().await;
                if let Some(mins) = exit_mins {
                    let exit_limit = Duration::from_secs(mins * 60);
                    if idle_dur >= exit_limit {
                        self.transition_to(
                            LifecycleState::DeepSleep,
                            "Configured idle exit duration reached in Listener Sleep",
                        )
                        .await;
                        // Clean shutdown
                        info!("EDM entering Deep Sleep (process complete exit)");
                        std::process::exit(0);
                    }
                }
            }

            LifecycleState::DeepSleep => {
                // Already exited or exiting
            }
        }
    }

    async fn transition_to(&self, next: LifecycleState, reason: &str) {
        let mut cur = self.current_state.write().await;
        if *cur != next {
            info!(
                "Lifecycle Transition: {:?} -> {:?} (Reason: {})",
                *cur, next, reason
            );
            *cur = next;
            *self.state_entered_at.write().await = Instant::now();

            let state_str = match next {
                LifecycleState::Active => "active",
                LifecycleState::Warm => "warm",
                LifecycleState::ListenerSleep => "listener_sleep",
                LifecycleState::DeepSleep => "deep_sleep",
            };
            self.ws_manager
                .update_lifecycle_state(Some(state_str.to_string()))
                .await;
            self.ws_manager.broadcast_snapshot().await;

            if next == LifecycleState::ListenerSleep {
                // Drop idle connections, checkpoint SQLite
                let _ = self.store.checkpoint();
            }
        }
    }

    pub async fn get_status(&self, active_tasks: usize) -> LifecycleStatus {
        let state = *self.current_state.read().await;
        let entered_at = *self.state_entered_at.read().await;
        let window_open = if let Some(app) = self.get_app_handle() {
            if let Some(window) = app.get_webview_window("main") {
                window.is_visible().unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };

        LifecycleStatus {
            state,
            active_tasks,
            window_open,
            warm_timeout_secs: self.warm_timeout_secs.load(Ordering::Relaxed),
            idle_exit_minutes: *self.idle_exit_minutes.read().await,
            wake_count: self.wake_count.load(Ordering::Relaxed),
            seconds_in_state: Instant::now().duration_since(entered_at).as_secs(),
        }
    }
}
