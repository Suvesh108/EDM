use edm_ipc::DownloadState;
use edm_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WsTaskItem {
    pub id: String,
    pub filename: String,
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

pub struct LiveTaskState {
    pub id: String,
    pub filename: String,
    pub total: Option<u64>,
    pub downloaded: u64,
    pub speed: u64,
    pub status: String,
    pub save_dir: PathBuf,
}

#[derive(Clone)]
pub struct WsManager {
    token: String,
    allowed_extension_id: String,
    live_tasks: Arc<RwLock<HashMap<String, LiveTaskState>>>,
    store: Store,
    tx_broadcast: broadcast::Sender<String>,
    create_task_tx: mpsc::Sender<CreateTaskCommand>,
    action_tx: mpsc::Sender<ActionCommand>,
}

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

pub struct ActionCommand {
    pub id: String,
    pub action: String,
    pub resp_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
}

impl WsManager {
    pub fn new(
        token: String,
        allowed_extension_id: String,
        store: Store,
        create_task_tx: mpsc::Sender<CreateTaskCommand>,
        action_tx: mpsc::Sender<ActionCommand>,
    ) -> Self {
        let (tx_broadcast, _) = broadcast::channel(64);
        Self {
            token,
            allowed_extension_id,
            live_tasks: Arc::new(RwLock::new(HashMap::new())),
            store,
            tx_broadcast,
            create_task_tx,
            action_tx,
        }
    }

    pub fn get_token(&self) -> &str {
        &self.token
    }

    pub fn get_live_tasks(&self) -> Arc<RwLock<HashMap<String, LiveTaskState>>> {
        self.live_tasks.clone()
    }

    pub async fn update_task_progress(
        &self,
        id: &str,
        downloaded: u64,
        total: Option<u64>,
        speed: u64,
        status: &str,
    ) {
        let mut map = self.live_tasks.write().await;
        if let Some(task) = map.get_mut(id) {
            task.downloaded = downloaded;
            if total.is_some() {
                task.total = total;
            }
            task.speed = speed;
            task.status = status.to_string();
        }
    }

    pub async fn register_task(
        &self,
        id: String,
        filename: String,
        save_dir: PathBuf,
        total: Option<u64>,
        status: String,
    ) {
        let mut map = self.live_tasks.write().await;
        map.insert(
            id.clone(),
            LiveTaskState {
                id,
                filename,
                total,
                downloaded: 0,
                speed: 0,
                status,
                save_dir,
            },
        );
    }

    pub async fn sync_from_store(&self) {
        if let Ok(records) = self.store.list_all_downloads() {
            let mut map = self.live_tasks.write().await;
            for r in records {
                let status_str = match r.state {
                    DownloadState::Downloading => "downloading",
                    DownloadState::Queued | DownloadState::Created | DownloadState::Probing => {
                        "queued"
                    }
                    DownloadState::Paused
                    | DownloadState::NeedsAttention
                    | DownloadState::LinkExpired => "paused",
                    DownloadState::Completed => "completed",
                    DownloadState::Failed | DownloadState::Cancelled => "failed",
                    DownloadState::Verifying => "downloading",
                };

                map.entry(r.id.to_string())
                    .or_insert_with(|| LiveTaskState {
                        id: r.id.to_string(),
                        filename: r.filename,
                        total: r.size_total,
                        downloaded: r.size_done,
                        speed: 0,
                        status: status_str.to_string(),
                        save_dir: PathBuf::from(r.save_dir),
                    });
            }
        }
    }

    pub async fn build_snapshot(&self) -> Vec<WsTaskItem> {
        let map = self.live_tasks.read().await;
        let mut items: Vec<WsTaskItem> = map
            .values()
            .map(|t| WsTaskItem {
                id: t.id.clone(),
                filename: t.filename.clone(),
                total: t.total,
                downloaded: t.downloaded,
                speed: t.speed,
                status: t.status.clone(),
            })
            .collect();

        // Sort consistently by id
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }
}

pub fn get_or_create_token() -> String {
    let config_dir = match std::env::var("APPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
        Err(_) => match std::env::var("LOCALAPPDATA") {
            Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
            Err(_) => std::env::temp_dir().join("EDM").join("config"),
        },
    };

    let _ = std::fs::create_dir_all(&config_dir);
    let token_file = config_dir.join("token.txt");

    if let Ok(existing) = std::fs::read_to_string(&token_file) {
        let trimmed = existing.trim().to_string();
        if trimmed.len() >= 32 {
            return trimmed;
        }
    }

    // Generate random 64-character token
    let u1 = Uuid::new_v4().as_u128();
    let u2 = Uuid::new_v4().as_u128();
    let new_token = format!("{:032x}{:032x}", u1, u2);
    let _ = std::fs::write(&token_file, &new_token);
    new_token
}

pub async fn start_ws_server(manager: Arc<WsManager>) {
    let _ = start_ws_server_on(WS_BIND_ADDR, manager).await;
}

pub async fn start_ws_server_on(addr: &str, manager: Arc<WsManager>) -> Result<SocketAddr, String> {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => {
            info!("EDM WebSocket server listening strictly on {}", addr);
            l
        }
        Err(e) => {
            error!("Failed to bind WebSocket server on {}: {}", addr, e);
            return Err(e.to_string());
        }
    };
    let local_addr = listener.local_addr().map_err(|e| e.to_string())?;

    // Spawn 500ms broadcast ticker
    let ticker_mgr = manager.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        let mut last_serialized = String::new();

        loop {
            interval.tick().await;
            let snapshot = ticker_mgr.build_snapshot().await;
            if let Ok(json) =
                serde_json::to_string(&OutboundWsMessage::Snapshot { tasks: snapshot })
            {
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
            let mgr = srv_mgr.clone();
            tokio::spawn(async move {
                handle_ws_connection(stream, peer_addr, mgr).await;
            });
        }
    });

    Ok(local_addr)
}

async fn handle_ws_connection(stream: TcpStream, peer_addr: SocketAddr, manager: Arc<WsManager>) {
    debug!("Incoming WebSocket connection from {}", peer_addr);

    // Verify Origin during upgrade
    let mut origin_valid = false;
    let expected_origin = format!("chrome-extension://{}", manager.allowed_extension_id);

    #[allow(clippy::result_large_err)]
    let callback = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if let Some(origin) = req.headers().get("Origin") {
            if let Ok(origin_str) = origin.to_str() {
                let trimmed = origin_str.trim_end_matches('/');
                let expected_trimmed = expected_origin.trim_end_matches('/');
                if trimmed == expected_trimmed {
                    origin_valid = true;
                    return Ok(resp);
                }
            }
        }
        // Reject invalid origin
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
            if let Ok(InboundWsMessage::Hello { token }) =
                serde_json::from_str::<InboundWsMessage>(&text)
            {
                token == manager.token
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
        return;
    }

    // Send ready
    let ready_msg = serde_json::to_string(&OutboundWsMessage::Ready).unwrap();
    if ws_tx.send(Message::Text(ready_msg.into())).await.is_err() {
        return;
    }

    info!(
        "WebSocket client authenticated successfully from {}",
        peer_addr
    );

    let mut is_subscribed = false;
    let mut rx_broadcast = manager.tx_broadcast.subscribe();

    loop {
        tokio::select! {
            // Outbound broadcast snapshots
            Ok(snapshot_json) = rx_broadcast.recv() => {
                if is_subscribed
                    && ws_tx.send(Message::Text(snapshot_json.into())).await.is_err() {
                    break;
                }
            }

            // Inbound messages from extension
            msg_opt = ws_rx.next() => {
                let msg = match msg_opt {
                    Some(Ok(m)) => m,
                    _ => break,
                };

                match msg {
                    Message::Text(text) => {
                        match serde_json::from_str::<InboundWsMessage>(&text) {
                            Ok(InboundWsMessage::Ping) => {
                                let pong = serde_json::to_string(&OutboundWsMessage::Pong).unwrap();
                                let _ = ws_tx.send(Message::Text(pong.into())).await;
                            }
                            Ok(InboundWsMessage::Subscribe) => {
                                is_subscribed = true;
                                // Instantly send initial snapshot
                                let snapshot = manager.build_snapshot().await;
                                let msg = serde_json::to_string(&OutboundWsMessage::Snapshot { tasks: snapshot }).unwrap();
                                let _ = ws_tx.send(Message::Text(msg.into())).await;
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

                                if manager.create_task_tx.send(cmd).await.is_ok() {
                                    match resp_rx.await {
                                        Ok(Ok(task_id)) => {
                                            let ack = serde_json::to_string(&OutboundWsMessage::Ack {
                                                req_id,
                                                ok: true,
                                                id: Some(task_id),
                                                error: None,
                                            }).unwrap();
                                            let _ = ws_tx.send(Message::Text(ack.into())).await;
                                        }
                                        Ok(Err(err)) => {
                                            let ack = serde_json::to_string(&OutboundWsMessage::Ack {
                                                req_id,
                                                ok: false,
                                                id: None,
                                                error: Some(err),
                                            }).unwrap();
                                            let _ = ws_tx.send(Message::Text(ack.into())).await;
                                        }
                                        Err(_) => {
                                            let ack = serde_json::to_string(&OutboundWsMessage::Ack {
                                                req_id,
                                                ok: false,
                                                id: None,
                                                error: Some("Internal task creation timeout".into()),
                                            }).unwrap();
                                            let _ = ws_tx.send(Message::Text(ack.into())).await;
                                        }
                                    }
                                }
                            }
                            Ok(InboundWsMessage::TaskAction { id, action }) => {
                                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                                let cmd = ActionCommand {
                                    id,
                                    action,
                                    resp_tx,
                                };
                                let _ = manager.action_tx.send(cmd).await;
                                let _ = resp_rx.await;
                            }
                            _ => {}
                        }
                    }
                    Message::Ping(p) => {
                        let _ = ws_tx.send(Message::Pong(p)).await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    debug!("WebSocket connection closed for {}", peer_addr);
}

/// Secure open_file: Only for completed tasks, only if file exists, reveals executable extensions in folder
pub fn secure_open_file(
    save_dir: &std::path::Path,
    filename: &str,
    status: &str,
) -> Result<(), String> {
    if status != "completed" {
        return Err("Cannot open file: download is not completed".into());
    }

    let file_path = save_dir.join(filename);
    if !file_path.exists() {
        return Err(format!(
            "File does not exist: {}",
            file_path.to_string_lossy()
        ));
    }

    let ext = filename.split('.').next_back().unwrap_or("").to_lowercase();
    let is_executable = matches!(
        ext.as_str(),
        "exe" | "msi" | "bat" | "cmd" | "ps1" | "scr" | "com" | "vbs" | "js" | "reg" | "pif"
    );

    if is_executable {
        // Do NOT launch executable; reveal in Explorer
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", file_path.to_string_lossy()))
                .spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("xdg-open").arg(save_dir).spawn();
        }
    } else {
        open::that(&file_path).map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Secure open_folder: explorer /select,<path>
pub fn secure_open_folder(save_dir: &std::path::Path, filename: &str) -> Result<(), String> {
    let file_path = save_dir.join(filename);
    #[cfg(windows)]
    {
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
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(save_dir).spawn();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

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

        // Send incorrect token
        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: "wrong_token_here".into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();

        // Socket must close
        let next_msg = ws_stream.next().await;
        match next_msg {
            None => {} // Closed immediately
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
    async fn test_create_task_ack() {
        let token = "test_token_valid_1234567890abcdef123456";
        let (addr, _mgr, mut create_rx, _act_rx) = setup_test_server(token).await;

        // Spawn mock handler for create_task
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

        // 1. Authenticate
        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();

        // Expect ready
        let ready_msg = ws_stream.next().await.unwrap().unwrap();
        assert!(ready_msg.to_text().unwrap().contains("\"type\":\"ready\""));

        // 2. Send create_task
        let req_id = "test-req-999".to_string();
        let create_msg = serde_json::to_string(&InboundWsMessage::CreateTask {
            req_id: req_id.clone(),
            url: "https://example.com/file.zip".into(),
            cookies: vec![],
            referrer: None,
            user_agent: None,
            filename: Some("file.zip".into()),
        })
        .unwrap();
        ws_stream
            .send(Message::Text(create_msg.into()))
            .await
            .unwrap();

        // Expect ack
        let ack_msg = ws_stream.next().await.unwrap().unwrap();
        let parsed: OutboundWsMessage = serde_json::from_str(ack_msg.to_text().unwrap()).unwrap();
        match parsed {
            OutboundWsMessage::Ack {
                req_id: rid,
                ok,
                id,
                ..
            } => {
                assert_eq!(rid, req_id);
                assert!(ok);
                assert_eq!(id, Some("task-uuid-abc-123".into()));
            }
            other => panic!("Expected Ack message, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_snapshot_received_after_subscribe() {
        let token = "test_token_valid_1234567890abcdef123456";
        let (addr, mgr, _create_rx, _act_rx) = setup_test_server(token).await;

        // Register a mock task
        mgr.register_task(
            "task-01".into(),
            "archive.iso".into(),
            PathBuf::from(r"C:\Downloads"),
            Some(100_000_000),
            "downloading".into(),
        )
        .await;

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

        // 1. Authenticate
        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();

        let _ = ws_stream.next().await.unwrap().unwrap(); // Ready

        // 2. Subscribe
        let sub = serde_json::to_string(&InboundWsMessage::Subscribe).unwrap();
        ws_stream.send(Message::Text(sub.into())).await.unwrap();

        // 3. Receive Snapshot
        let snap_msg = ws_stream.next().await.unwrap().unwrap();
        let parsed: OutboundWsMessage = serde_json::from_str(snap_msg.to_text().unwrap()).unwrap();
        match parsed {
            OutboundWsMessage::Snapshot { tasks } => {
                assert_eq!(tasks.len(), 1);
                assert_eq!(tasks[0].id, "task-01");
                assert_eq!(tasks[0].filename, "archive.iso");
                assert_eq!(tasks[0].status, "downloading");
                assert_eq!(tasks[0].total, Some(100_000_000));
            }
            other => panic!("Expected Snapshot message, got {:?}", other),
        }
    }

    #[test]
    fn test_open_file_refused_for_incomplete_tasks() {
        let temp_dir = std::env::temp_dir();
        // 1. Status is downloading
        let res = secure_open_file(&temp_dir, "test.zip", "downloading");
        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err(),
            "Cannot open file: download is not completed"
        );

        // 2. Status is queued
        let res2 = secure_open_file(&temp_dir, "test.zip", "queued");
        assert!(res2.is_err());
        assert_eq!(
            res2.unwrap_err(),
            "Cannot open file: download is not completed"
        );

        // 3. Status is paused
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
                // If unknown task id, return error or ignore
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

        // 1. Authenticate
        let hello = serde_json::to_string(&InboundWsMessage::Hello {
            token: token.into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(hello.into())).await.unwrap();
        let _ = ws_stream.next().await.unwrap().unwrap(); // Ready

        // 2. Send action on non-existent task
        let act = serde_json::to_string(&InboundWsMessage::TaskAction {
            id: "unknown-uuid-999".into(),
            action: "pause".into(),
        })
        .unwrap();
        ws_stream.send(Message::Text(act.into())).await.unwrap();

        // Server connection remains healthy and alive, handles ping/pong
        ws_stream
            .send(Message::Text("{\"type\":\"ping\"}".into()))
            .await
            .unwrap();
        let pong = ws_stream.next().await.unwrap().unwrap();
        assert!(pong.to_text().unwrap().contains("\"type\":\"pong\""));
    }
}
