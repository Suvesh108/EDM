use edm_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

#[allow(dead_code)]
pub const WS_PORT: u16 = 14370;
pub const WS_BIND_ADDR: &str = "127.0.0.1:14370";
pub const EXTENSION_ID: &str = "ginpdimhcdbojbhemgjedghkeolbcmgj";
#[allow(dead_code)]
pub const FIREFOX_EXTENSION_ID: &str = "edm@suvesh.dev";

// Security invariants
pub const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024; // 64 KiB
pub const MAX_CONCURRENT_CONNECTIONS: usize = 32;

static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WsTaskItem {
    pub id: String,
    pub filename: String,
    pub save_dir: PathBuf,
    pub total: Option<u64>,
    pub downloaded: u64,
    pub speed: u64,
    pub status: String, // "queued" | "downloading" | "paused" | "completed" | "failed"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsCookie {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundWsMessage {
    Hello {
        token: String,
    },
    Ping,
    Subscribe,
    CreateTask {
        req_id: String,
        url: String,
        #[serde(default)]
        cookies: Vec<WsCookie>,
        #[serde(default)]
        referrer: Option<String>,
        #[serde(default)]
        user_agent: Option<String>,
        #[serde(default)]
        filename: Option<String>,
    },
    TaskAction {
        id: String,
        action: String, // "pause" | "resume" | "cancel" | "remove" | "open_file" | "open_folder"
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundWsMessage {
    Ready,
    Pong,
    Ack {
        req_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Snapshot {
        tasks: Vec<WsTaskItem>,
    },
}

#[derive(Debug)]
pub struct CreateTaskCommand {
    #[allow(dead_code)]
    pub req_id: String,
    pub url: String,
    pub cookies: Vec<WsCookie>,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub filename: Option<String>,
    pub resp_tx: tokio::sync::oneshot::Sender<Result<String, String>>,
}

#[derive(Debug)]
pub struct ActionCommand {
    pub id: String,
    pub action: String,
    pub resp_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
}

pub struct WsManager {
    token: String,
    pub allowed_extension_id: String,
    pub store: Store,
    pub tasks: Arc<RwLock<HashMap<String, WsTaskItem>>>,
    pub tx_broadcast: broadcast::Sender<String>,
    pub tx_create_task: mpsc::Sender<CreateTaskCommand>,
    pub tx_action: mpsc::Sender<ActionCommand>,
}

impl WsManager {
    pub fn new(
        token: String,
        allowed_extension_id: String,
        store: Store,
        tx_create_task: mpsc::Sender<CreateTaskCommand>,
        tx_action: mpsc::Sender<ActionCommand>,
    ) -> Self {
        let (tx_broadcast, _) = broadcast::channel(128);
        Self {
            token,
            allowed_extension_id,
            store,
            tasks: Arc::new(RwLock::new(HashMap::new())),
            tx_broadcast,
            tx_create_task,
            tx_action,
        }
    }

    pub fn get_token(&self) -> &str {
        &self.token
    }

    pub fn get_live_tasks(&self) -> Arc<RwLock<HashMap<String, WsTaskItem>>> {
        self.tasks.clone()
    }

    pub async fn register_task(
        &self,
        id: String,
        filename: String,
        save_dir: PathBuf,
        total: Option<u64>,
        status: String,
    ) {
        let mut map = self.tasks.write().await;
        map.insert(
            id.clone(),
            WsTaskItem {
                id,
                filename,
                save_dir,
                total,
                downloaded: 0,
                speed: 0,
                status,
            },
        );
    }

    /// Constant-time token verification to defend against timing attacks
    pub fn verify_token_constant_time(&self, candidate: &str) -> bool {
        if candidate.len() != self.token.len() {
            return false;
        }
        candidate.as_bytes().ct_eq(self.token.as_bytes()).into()
    }

    pub async fn update_task_progress(
        &self,
        id: &str,
        downloaded: u64,
        total: Option<u64>,
        speed: u64,
        status: &str,
    ) {
        let mut map = self.tasks.write().await;
        if let Some(item) = map.get_mut(id) {
            item.downloaded = downloaded;
            if total.is_some() {
                item.total = total;
            }
            item.speed = speed;
            item.status = status.to_string();
        }
    }

    #[allow(dead_code)]
    pub async fn remove_task(&self, id: &str) {
        let mut map = self.tasks.write().await;
        map.remove(id);
    }

    pub async fn sync_from_store(&self) {
        if let Ok(records) = self.store.list_all_downloads() {
            let mut map = self.tasks.write().await;
            for r in records {
                let status = match r.state {
                    edm_ipc::DownloadState::Queued => "queued",
                    edm_ipc::DownloadState::Downloading => "downloading",
                    edm_ipc::DownloadState::Paused => "paused",
                    edm_ipc::DownloadState::Completed => "completed",
                    edm_ipc::DownloadState::Failed => "failed",
                    edm_ipc::DownloadState::Cancelled => "cancelled",
                    _ => "queued",
                };
                map.insert(
                    r.id.to_string(),
                    WsTaskItem {
                        id: r.id.to_string(),
                        filename: r.filename,
                        save_dir: PathBuf::from(r.save_dir),
                        total: r.size_total,
                        downloaded: r.size_done,
                        speed: 0,
                        status: status.to_string(),
                    },
                );
            }
        }
    }
}

pub fn get_or_create_token() -> String {
    let config_dir = match std::env::var("APPDATA") {
        Ok(appdata) => PathBuf::from(appdata).join("EDM").join("config"),
        Err(_) => std::env::temp_dir().join("EDM").join("config"),
    };
    let _ = std::fs::create_dir_all(&config_dir);
    let token_file = config_dir.join("token.txt");

    if let Ok(existing) = std::fs::read_to_string(&token_file) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() && trimmed.len() >= 32 {
            return trimmed.to_string();
        }
    }

    let raw_token = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let _ = std::fs::write(&token_file, &raw_token);
    raw_token
}

/// Validate that Host header matches 127.0.0.1 or localhost (DNS rebinding defense)
pub fn is_valid_loopback_host(host_header: Option<&str>, port: u16) -> bool {
    if let Some(host) = host_header {
        let host_trimmed = host.trim();
        let expected_ip = format!("127.0.0.1:{}", port);
        let expected_lh = format!("localhost:{}", port);
        host_trimmed == expected_ip
            || host_trimmed == expected_lh
            || host_trimmed == "127.0.0.1"
            || host_trimmed == "localhost"
    } else {
        false
    }
}

pub async fn start_ws_server(manager: Arc<WsManager>) {
    let addr = WS_BIND_ADDR;
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => {
            info!("EDM WebSocket & HTTP Token Server listening on ws://{}", addr);
            l
        }
        Err(e) => {
            error!("Failed to bind WebSocket server to {}: {}", addr, e);
            return;
        }
    };

    let ticker_mgr = manager.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        let mut last_serialized = String::new();
        loop {
            interval.tick().await;
            let tasks: Vec<WsTaskItem> = {
                let map = ticker_mgr.tasks.read().await;
                map.values().cloned().collect()
            };

            let snapshot = OutboundWsMessage::Snapshot { tasks };
            if let Ok(json) = serde_json::to_string(&snapshot) {
                if json != last_serialized {
                    last_serialized = json.clone();
                    let _ = ticker_mgr.tx_broadcast.send(json);
                }
            }
        }
    });

    let srv_mgr = manager.clone();
    tokio::spawn(async move {
        while let Ok((stream, peer_addr)) = listener.accept().await {
            let active = ACTIVE_CONNECTIONS.load(Ordering::Relaxed);
            if active >= MAX_CONCURRENT_CONNECTIONS {
                warn!("Rejecting connection from {}: max concurrent connections reached ({})", peer_addr, active);
                drop(stream);
                continue;
            }

            let mgr = srv_mgr.clone();
            tokio::spawn(async move {
                ACTIVE_CONNECTIONS.fetch_add(1, Ordering::Relaxed);
                let mut peek_buf = [0u8; 1024];
                let mut peek_len = 0;
                for _ in 0..20 {
                    peek_len = stream.peek(&mut peek_buf).await.unwrap_or(0);
                    if peek_len > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let peek_str = String::from_utf8_lossy(&peek_buf[..peek_len]);

                if peek_str.starts_with("GET /token") || peek_str.starts_with("OPTIONS /token") {
                    handle_http_token_request(stream, peer_addr, mgr).await;
                } else {
                    handle_ws_connection(stream, peer_addr, mgr).await;
                }
                ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
}

#[allow(dead_code)]
pub async fn start_ws_server_on(
    bind_addr: &str,
    manager: Arc<WsManager>,
) -> Result<SocketAddr, Box<dyn std::error::Error + Send + Sync>> {
    let listener = TcpListener::bind(bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let srv_mgr = manager.clone();

    tokio::spawn(async move {
        while let Ok((stream, peer_addr)) = listener.accept().await {
            let active = ACTIVE_CONNECTIONS.load(Ordering::Relaxed);
            if active >= MAX_CONCURRENT_CONNECTIONS {
                drop(stream);
                continue;
            }
            let mgr = srv_mgr.clone();
            tokio::spawn(async move {
                ACTIVE_CONNECTIONS.fetch_add(1, Ordering::Relaxed);
                let mut peek_buf = [0u8; 1024];
                let mut peek_len = 0;
                for _ in 0..20 {
                    peek_len = stream.peek(&mut peek_buf).await.unwrap_or(0);
                    if peek_len > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let peek_str = String::from_utf8_lossy(&peek_buf[..peek_len]);

                if peek_str.starts_with("GET /token") || peek_str.starts_with("OPTIONS /token") {
                    handle_http_token_request(stream, peer_addr, mgr).await;
                } else {
                    handle_ws_connection(stream, peer_addr, mgr).await;
                }
                ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });

    Ok(local_addr)
}

async fn handle_http_token_request(
    mut stream: TcpStream,
    peer_addr: SocketAddr,
    manager: Arc<WsManager>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf).await {
        Ok(read_bytes) if read_bytes > 0 => read_bytes,
        _ => return,
    };
    let request_str = String::from_utf8_lossy(&buf[..n]);

    let mut origin: Option<String> = None;
    let mut host: Option<String> = None;
    for line in request_str.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("origin:") {
            origin = Some(line[7..].trim().trim_end_matches('/').to_string());
        } else if lower.starts_with("host:") {
            host = Some(line[5..].trim().to_string());
        }
    }

    // Guard 1: DNS rebinding defense on Host header
    let port = stream.local_addr().map(|a| a.port()).unwrap_or(WS_PORT);
    if !is_valid_loopback_host(host.as_deref(), port) {
        warn!("Invalid Host header on /token from {}: {:?}", peer_addr, host);
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid Host Header";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    // Guard 2: Origin requirement
    // Allow Origin chrome-extension:// and moz-extension://, or direct loopback callers (no Origin header).
    // External web origins (http://, https://) are strictly forbidden!
    let is_forbidden = if let Some(ref o) = origin {
        let lower = o.to_ascii_lowercase();
        let is_chrome = lower.starts_with("chrome-extension://");
        let is_firefox = lower.starts_with("moz-extension://");
        !is_chrome && !is_firefox
    } else {
        // Direct local loopback request: no Origin header sent (e.g. extension worker fetch or local tool)
        // Browsers NEVER omit Origin on cross-origin web requests, so any web page has an Origin header.
        false
    };

    let ac_origin = if let Some(ref o) = origin {
        let lower = o.to_ascii_lowercase();
        if lower.starts_with("chrome-extension://") || lower.starts_with("moz-extension://") {
            o.as_str()
        } else {
            "null"
        }
    } else {
        "*"
    };

    if request_str.starts_with("OPTIONS") {
        let resp = format!(
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n",
            if !is_forbidden { ac_origin } else { "null" }
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    if is_forbidden {
        warn!(
            "Forbidden origin '{:?}' on HTTP /token request from {}",
            origin,
            peer_addr
        );
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden Origin";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    let body = serde_json::json!({
        "token": manager.get_token(),
        "extension_id": manager.allowed_extension_id
    })
    .to_string();

    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        ac_origin,
        body
    );
    let _ = stream.write_all(resp.as_bytes()).await;
}

async fn handle_ws_connection(stream: TcpStream, peer_addr: SocketAddr, manager: Arc<WsManager>) {
    debug!("Incoming WebSocket connection from {}", peer_addr);

    let mut origin_valid = false;
    let _expected_origin = format!("chrome-extension://{}", manager.allowed_extension_id);
    let port = stream.local_addr().map(|a| a.port()).unwrap_or(WS_PORT);

    #[allow(clippy::result_large_err)]
    let callback = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        // Guard 1: Host header validation
        let host_val = req.headers().get("Host").and_then(|h| h.to_str().ok());
        if !is_valid_loopback_host(host_val, port) {
            let err_resp = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Some("Invalid Host Header".to_string()))
                .unwrap();
            return Err(err_resp);
        }

        // Guard 2: Origin header validation
        if let Some(origin) = req.headers().get("Origin") {
            if let Ok(origin_str) = origin.to_str() {
                let trimmed = origin_str.trim_end_matches('/');
                let is_chrome = trimmed.starts_with("chrome-extension://");
                let is_firefox = trimmed.starts_with("moz-extension://");
                if is_chrome || is_firefox {
                    origin_valid = true;
                    return Ok(resp);
                }
            }
        }
        let err_resp = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Some("Forbidden Origin".to_string()))
            .unwrap();
        Err(err_resp)
    };

    let ws_stream = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!("Rejected WebSocket handshake from {}: {}", peer_addr, e);
            return;
        }
    };

    if !origin_valid {
        warn!("Forbidden origin on WebSocket from {}", peer_addr);
        return;
    }

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Enforce first message MUST be: hello {token} within 5 seconds
    let hello_result = tokio::time::timeout(Duration::from_secs(5), ws_rx.next()).await;
    let authenticated = match hello_result {
        Ok(Some(Ok(Message::Text(text)))) => {
            if text.len() > MAX_WS_MESSAGE_SIZE {
                false
            } else if let Ok(InboundWsMessage::Hello { token }) =
                serde_json::from_str::<InboundWsMessage>(&text)
            {
                manager.verify_token_constant_time(&token)
            } else {
                false
            }
        }
        _ => false,
    };

    if !authenticated {
        warn!(
            "WebSocket authentication failed from {}. Closing socket immediately.",
            peer_addr
        );
        let _ = ws_tx.close().await;
        // Introduce small artificial rate-limit delay on failed attempts
        tokio::time::sleep(Duration::from_millis(500)).await;
        return;
    }

    debug!("WebSocket authenticated successfully from {}", peer_addr);

    // Reply with ready
    let ready_json = serde_json::to_string(&OutboundWsMessage::Ready).unwrap();
    if ws_tx.send(Message::Text(ready_json.into())).await.is_err() {
        return;
    }

    let mut rx_broadcast = manager.tx_broadcast.subscribe();
    let mut is_subscribed = false;

    loop {
        tokio::select! {
            // Outbound broadcast
            msg_res = rx_broadcast.recv(), if is_subscribed => {
                match msg_res {
                    Ok(json) => {
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        debug!("WebSocket client lagged by {} messages", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            // Inbound messages from extension
            ws_msg = ws_rx.next() => {
                match ws_msg {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_WS_MESSAGE_SIZE {
                            warn!("Oversized WebSocket message received ({} bytes) from {}", text.len(), peer_addr);
                            break;
                        }
                        match serde_json::from_str::<InboundWsMessage>(&text) {
                            Ok(InboundWsMessage::Ping) => {
                                let pong = serde_json::to_string(&OutboundWsMessage::Pong).unwrap();
                                if ws_tx.send(Message::Text(pong.into())).await.is_err() {
                                    break;
                                }
                            }
                            Ok(InboundWsMessage::Subscribe) => {
                                is_subscribed = true;
                                let tasks: Vec<WsTaskItem> = {
                                    let map = manager.tasks.read().await;
                                    map.values().cloned().collect()
                                };
                                let snapshot = OutboundWsMessage::Snapshot { tasks };
                                if let Ok(json) = serde_json::to_string(&snapshot) {
                                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Ok(InboundWsMessage::CreateTask { req_id, url, cookies, referrer, user_agent, filename }) => {
                                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                                let cmd = CreateTaskCommand {
                                    req_id: req_id.clone(),
                                    url,
                                    cookies,
                                    referrer,
                                    user_agent,
                                    filename,
                                    resp_tx,
                                };

                                let ack = if manager.tx_create_task.send(cmd).await.is_ok() {
                                    match tokio::time::timeout(Duration::from_secs(4), resp_rx).await {
                                        Ok(Ok(Ok(task_id))) => OutboundWsMessage::Ack {
                                            req_id,
                                            ok: true,
                                            id: Some(task_id),
                                            error: None,
                                        },
                                        Ok(Ok(Err(err))) => OutboundWsMessage::Ack {
                                            req_id,
                                            ok: false,
                                            id: None,
                                            error: Some(err),
                                        },
                                        _ => OutboundWsMessage::Ack {
                                            req_id,
                                            ok: false,
                                            id: None,
                                            error: Some("Timeout creating download task".into()),
                                        },
                                    }
                                } else {
                                    OutboundWsMessage::Ack {
                                        req_id,
                                        ok: false,
                                        id: None,
                                        error: Some("Internal task dispatcher unavailable".into()),
                                    }
                                };

                                if let Ok(json) = serde_json::to_string(&ack) {
                                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Ok(InboundWsMessage::TaskAction { id, action }) => {
                                let (resp_tx, _) = tokio::sync::oneshot::channel();
                                let cmd = ActionCommand {
                                    id,
                                    action,
                                    resp_tx,
                                };
                                let _ = manager.tx_action.send(cmd).await;
                            }
                            Ok(InboundWsMessage::Hello { .. }) => {
                                // Redundant hello ignored
                            }
                            Err(e) => {
                                warn!("Malformed JSON from extension {}: {}", peer_addr, e);
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    debug!("WebSocket connection closed for {}", peer_addr);
}

pub fn secure_open_file(
    save_dir: &std::path::Path,
    filename: &str,
    status: &str,
) -> Result<(), String> {
    if status != "completed" {
        return Err("Cannot open file: download is not completed".into());
    }

    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid file path".into());
    }

    let target = save_dir.join(filename);
    if !target.exists() {
        return Err("File does not exist on disk".into());
    }

    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let canonical_dir = save_dir
        .canonicalize()
        .map_err(|e| format!("Cannot resolve dir: {}", e))?;

    if !canonical_target.starts_with(&canonical_dir) {
        return Err("Access denied: path traversal detected".into());
    }

    open::that(&canonical_target).map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

pub fn secure_open_folder(save_dir: &std::path::Path, filename: &str) -> Result<(), String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid file path".into());
    }

    let target = save_dir.join(filename);
    if !target.exists() {
        if save_dir.exists() {
            open::that(save_dir).map_err(|e| format!("Failed to open directory: {}", e))?;
            return Ok(());
        }
        return Err("Directory does not exist".into());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = std::process::Command::new("explorer");
        let arg = format!("/select,\"{}\"", target.display());
        cmd.raw_arg(&arg);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.spawn().map_err(|e| format!("Failed to highlight file: {}", e))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        open::that(save_dir).map_err(|e| format!("Failed to open directory: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_test_server(
        token: &str,
    ) -> (
        SocketAddr,
        Arc<WsManager>,
        mpsc::Receiver<CreateTaskCommand>,
        mpsc::Receiver<ActionCommand>,
    ) {
        let store = Store::open_in_memory().unwrap();
        let (create_tx, create_rx) = mpsc::channel(32);
        let (action_tx, action_rx) = mpsc::channel(32);

        let manager = Arc::new(WsManager::new(
            token.to_string(),
            EXTENSION_ID.to_string(),
            store,
            create_tx,
            action_tx,
        ));

        let addr = start_ws_server_on("127.0.0.1:0", manager.clone())
            .await
            .unwrap();
        (addr, manager, create_rx, action_rx)
    }

    #[tokio::test]
    async fn test_bad_token_rejected() {
        let (addr, _mgr, _create_rx, _act_rx) =
            setup_test_server("correct_token_1234567890_abcdef12345").await;

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", format!("chrome-extension://{}", EXTENSION_ID))
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let (mut ws_stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("Handshake should succeed");

        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: "wrong_token_here".into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();

        let next_msg = ws_stream.next().await;
        match next_msg {
            None => {}
            Some(Ok(Message::Close(_))) => {}
            Some(Err(_)) => {}
            other => panic!("Expected connection closure on bad token, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_bad_origin_rejected() {
        let (addr, _mgr, _create_rx, _act_rx) =
            setup_test_server("token_1234567890_abcdef123456789012").await;

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", "https://malicious-website.com")
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let result = tokio_tungstenite::connect_async(request).await;
        assert!(
            result.is_err(),
            "Connection from malicious origin must be rejected"
        );
    }

    #[tokio::test]
    async fn test_bad_host_rejected() {
        let (addr, _mgr, _create_rx, _act_rx) =
            setup_test_server("token_1234567890_abcdef123456789012").await;

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", format!("chrome-extension://{}", EXTENSION_ID))
            .header("Host", "attacker.dnsrebinding.com")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let result = tokio_tungstenite::connect_async(request).await;
        assert!(result.is_err(), "Wrong host must be rejected");
    }

    #[tokio::test]
    async fn test_token_endpoint_security() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let token = "super_secure_token_constant_time_987654";
        let (addr, _mgr, _create_rx, _act_rx) = setup_test_server(token).await;

        // 1. Untrusted External Web Origin -> 403
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("GET /token HTTP/1.1\r\nHost: {}\r\nOrigin: https://attacker.com\r\n\r\n", addr).as_bytes())
            .await
            .unwrap();
        let mut resp = [0u8; 512];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(resp_str.contains("403 Forbidden"), "External web origin must be 403");

        // 2. Loopback HTTP Origin -> 403 (Token endpoint requires extension origin only)
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("GET /token HTTP/1.1\r\nHost: {}\r\nOrigin: http://127.0.0.1:3000\r\n\r\n", addr).as_bytes())
            .await
            .unwrap();
        let mut resp = [0u8; 512];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(resp_str.contains("403 Forbidden"), "Loopback origin must be rejected on /token");

        // 3. Valid Chrome Extension Origin -> 200 OK
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let valid_origin = format!("chrome-extension://{}", EXTENSION_ID);
        stream
            .write_all(format!("GET /token HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\n\r\n", addr, valid_origin).as_bytes())
            .await
            .unwrap();
        let mut resp = [0u8; 1024];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(resp_str.contains("200 OK"), "Valid extension origin must succeed");
        assert!(resp_str.contains(token));

        // 4. Missing Origin (direct loopback / extension service worker fetch) -> 200 OK
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("GET /token HTTP/1.1\r\nHost: {}\r\n\r\n", addr).as_bytes())
            .await
            .unwrap();
        let mut resp = [0u8; 1024];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(resp_str.contains("200 OK"), "Direct loopback without origin must succeed");
        assert!(resp_str.contains(token));
    }

    #[tokio::test]
    async fn test_oversized_ws_message_rejected() {
        let token = "test_token_valid_1234567890abcdef123456";
        let (addr, _mgr, _create_rx, _act_rx) = setup_test_server(token).await;

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", format!("chrome-extension://{}", EXTENSION_ID))
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let (mut ws_stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        // Authenticate
        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();
        let _ = ws_stream.next().await.unwrap().unwrap(); // Ready

        // Send oversized payload > 64 KiB
        let huge_text = "A".repeat(70 * 1024);
        let _ = ws_stream.send(Message::Text(huge_text.into())).await;

        // Connection should terminate
        let next_msg = ws_stream.next().await;
        match next_msg {
            None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {}
            other => panic!("Expected connection close on oversized message, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_create_task_ack() {
        let token = "test_token_valid_1234567890abcdef123456";
        let (addr, _mgr, mut create_rx, _act_rx) = setup_test_server(token).await;

        tokio::spawn(async move {
            if let Some(cmd) = create_rx.recv().await {
                let _ = cmd.resp_tx.send(Ok("task-uuid-abc-123".into()));
            }
        });

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", format!("chrome-extension://{}", EXTENSION_ID))
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let (mut ws_stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();
        let _ = ws_stream.next().await.unwrap().unwrap();

        let create = serde_json::to_string(&InboundWsMessage::CreateTask {
            req_id: "req-999".into(),
            url: "https://example.com/file.zip".into(),
            cookies: vec![],
            referrer: None,
            user_agent: None,
            filename: Some("file.zip".into()),
        })
        .unwrap();
        ws_stream.send(Message::Text(create.into())).await.unwrap();

        let ack_msg = ws_stream.next().await.unwrap().unwrap();
        let ack_text = ack_msg.to_text().unwrap();
        let parsed: OutboundWsMessage = serde_json::from_str(ack_text).unwrap();
        match parsed {
            OutboundWsMessage::Ack { req_id, ok, id, .. } => {
                assert_eq!(req_id, "req-999");
                assert!(ok);
                assert_eq!(id, Some("task-uuid-abc-123".into()));
            }
            other => panic!("Expected Ack, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_open_file_refused_for_incomplete_tasks() {
        let temp_dir = std::env::temp_dir();

        let res1 = secure_open_file(&temp_dir, "../test.zip", "completed");
        assert!(res1.is_err());
        assert_eq!(res1.unwrap_err(), "Invalid file path");

        let res2 = secure_open_file(&temp_dir, "non_existent_file_xyz_123.bin", "completed");
        assert!(res2.is_err());
        assert_eq!(res2.unwrap_err(), "File does not exist on disk");

        let res3 = secure_open_file(&temp_dir, "test.zip", "paused");
        assert!(res3.is_err());
        assert_eq!(
            res3.unwrap_err(),
            "Cannot open file: download is not completed"
        );
    }

    #[tokio::test]
    async fn test_unknown_task_id_ignored() {
        let token = "test_token_valid_1234567890abcdef123456";
        let (addr, _mgr, _create_rx, mut act_rx) = setup_test_server(token).await;

        tokio::spawn(async move {
            while let Some(cmd) = act_rx.recv().await {
                let _ = cmd.resp_tx.send(Err("Task not found".into()));
            }
        });

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}", addr))
            .header("Origin", format!("chrome-extension://{}", EXTENSION_ID))
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();

        let (mut ws_stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();
        let _ = ws_stream.next().await.unwrap().unwrap();

        let act = serde_json::to_string(&InboundWsMessage::TaskAction {
            id: "unknown-uuid-999".into(),
            action: "pause".into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(act.into())).await.unwrap();

        ws_stream
            .send(Message::Text("{\"type\":\"ping\"}".into()))
            .await
            .unwrap();
        let pong = ws_stream.next().await.unwrap().unwrap();
        assert!(pong.to_text().unwrap().contains("\"type\":\"pong\""));
    }
}
