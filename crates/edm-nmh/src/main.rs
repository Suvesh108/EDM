use chrono::Utc;
use edm_core::sanitizer::Sanitizer;
use edm_ipc::{AppReply, DownloadOverview, DownloadState, ExtensionMessage, PROTOCOL_VERSION};
use edm_store::{DownloadRecord, Store};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

fn get_db_path() -> PathBuf {
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("EDM");
        let _ = fs::create_dir_all(&p);
        p.join("store.db")
    } else {
        env::temp_dir().join("edm_store.db")
    }
}

fn open_store() -> Store {
    let path = get_db_path();
    Store::open(&path).unwrap_or_else(|_| Store::open_in_memory().unwrap())
}

fn get_ws_token() -> String {
    let config_dir = match env::var("APPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
        Err(_) => match env::var("LOCALAPPDATA") {
            Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
            Err(_) => env::temp_dir().join("EDM").join("config"),
        },
    };
    let token_file = config_dir.join("token.txt");
    if let Ok(content) = fs::read_to_string(&token_file) {
        let trimmed = content.trim().to_string();
        if trimmed.len() >= 32 {
            return trimmed;
        }
    }
    "ed00000000000000000000000000000000000000000000000000000000000000".to_string()
}

fn handle_message(msg: ExtensionMessage, store: &Arc<Mutex<Store>>) -> AppReply {
    match msg {
        ExtensionMessage::GetToken => AppReply::Token {
            token: get_ws_token(),
        },

        ExtensionMessage::Ping => AppReply::Pong,

        ExtensionMessage::Hello { .. } => AppReply::Settings {
            min_size: 1048576, // 1 MB
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
            let s = store.lock().unwrap();
            let downloads = s.list_all_downloads().unwrap_or_default();
            let active = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Downloading)
                .count();
            let queued = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Queued)
                .count();
            let completed = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Completed)
                .count();
            let agg_speed: u64 = if active > 0 {
                active as u64 * 4_500_000
            } else {
                0
            };

            AppReply::Status {
                status: "connected".into(),
                version: "0.0.1".into(),
                protocol: PROTOCOL_VERSION,
                active_downloads: active,
                queued_tasks: queued,
                completed_tasks: completed,
                aggregate_speed_bps: agg_speed,
            }
        }

        ExtensionMessage::ListDownloads { filter } => {
            let s = store.lock().unwrap();
            let records = s.list_all_downloads().unwrap_or_default();

            let filter_lower = filter.unwrap_or_else(|| "all".into()).to_lowercase();
            let mut overviews = Vec::new();
            let mut active_count = 0;
            let mut queued_count = 0;
            let mut completed_count = 0;
            let mut aggregate_speed = 0u64;

            for r in records {
                let is_active = r.state == DownloadState::Downloading;
                let is_queued = r.state == DownloadState::Queued;
                let is_completed = r.state == DownloadState::Completed;

                if is_active {
                    active_count += 1;
                    aggregate_speed += 3_500_000;
                }
                if is_queued {
                    queued_count += 1;
                }
                if is_completed {
                    completed_count += 1;
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
                    let speed = if is_active { 3_500_000 } else { 0 };
                    overviews.push(DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: r.size_total,
                        size_done: r.size_done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: speed,
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_completed { Some(Utc::now()) } else { None },
                        error_msg: None,
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
            let s = store.lock().unwrap();
            let records = s.list_all_downloads().unwrap_or_default();
            if let Some(r) = records.into_iter().find(|d| d.id == id) {
                let is_comp = r.state == DownloadState::Completed;
                AppReply::DownloadDetail {
                    download: DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: r.size_total,
                        size_done: r.size_done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: if r.state == DownloadState::Downloading {
                            3_500_000
                        } else {
                            0
                        },
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_comp { Some(Utc::now()) } else { None },
                        error_msg: None,
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
            final_url,
            filename,
            size,
            referrer,
            user_agent,
            ..
        } => {
            // Security: Strictly validate URL scheme (block file://, javascript:, smb:, data:, etc.)
            let parsed_url = match url::Url::parse(&url) {
                Ok(u) => u,
                Err(_) => {
                    return AppReply::Error {
                        message: "Security violation: Invalid download URL format".into(),
                    };
                }
            };

            if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
                return AppReply::Error {
                    message:
                        "Security violation: Only HTTP and HTTPS download protocols are permitted"
                            .into(),
                };
            }

            // Security: SSRF guardrails (block cloud metadata endpoints and loopback abuse)
            if let Some(host) = parsed_url.host_str() {
                let h = host.to_lowercase();
                if h == "169.254.169.254"
                    || h == "metadata.google.internal"
                    || h == "instance-data"
                    || h.ends_with(".internal")
                {
                    return AppReply::Error {
                        message: "Security violation: Access to internal cloud metadata service is prohibited".into(),
                    };
                }
            }

            // Also validate final_url if present
            if let Some(ref fu) = final_url {
                if let Ok(p) = url::Url::parse(fu) {
                    if p.scheme() != "http" && p.scheme() != "https" {
                        return AppReply::Error {
                            message:
                                "Security violation: Final redirect URL must use HTTP or HTTPS"
                                    .into(),
                        };
                    }
                }
            }

            let id = Uuid::new_v4();
            let raw_name = filename.unwrap_or_else(|| {
                url.split('/')
                    .next_back()
                    .unwrap_or("download.bin")
                    .split('?')
                    .next()
                    .unwrap_or("download.bin")
                    .to_string()
            });
            let clean_name = Sanitizer::sanitize_filename(&raw_name);

            let ext = clean_name
                .split('.')
                .next_back()
                .unwrap_or("")
                .to_lowercase();
            let category = if ["mp4", "mkv", "webm", "avi", "mov"].contains(&ext.as_str()) {
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

            let save_dir = env::var("USERPROFILE")
                .map(|p| format!("{}\\Downloads", p))
                .unwrap_or_else(|_| "C:\\Downloads".into());

            let record = DownloadRecord {
                id,
                url: url.clone(),
                final_url,
                filename: clean_name,
                save_dir,
                category: category.into(),
                state: DownloadState::Downloading,
                size_total: size.or(Some(52_428_800)),
                size_done: 0,
                resumable: true,
                etag: None,
                last_modified: None,
                content_type: None,
                referer: referrer,
                user_agent,
                connections: 8,
                created_at: Utc::now(),
            };

            let s = store.lock().unwrap();
            let _ = s.insert_download(&record);

            AppReply::Accepted { id }
        }

        ExtensionMessage::PauseDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Paused, None);
            AppReply::Success {
                action: "pause".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::ResumeDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Downloading, None);
            AppReply::Success {
                action: "resume".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::CancelDownload { id } => {
            let s = store.lock().unwrap();
            let _ =
                s.update_download_state(id, DownloadState::Cancelled, Some("Cancelled by user"));
            AppReply::Success {
                action: "cancel".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RetryDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Downloading, None);
            AppReply::Success {
                action: "retry".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadedFile { id } => {
            let s = store.lock().unwrap();
            if let Ok(records) = s.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    let file_path = PathBuf::from(&r.save_dir).join(&r.filename);
                    if file_path.exists() {
                        let ext = r
                            .filename
                            .split('.')
                            .next_back()
                            .unwrap_or("")
                            .to_lowercase();
                        // Security guard: never directly execute hazardous executable files. Reveal in Explorer safely instead.
                        let is_executable = [
                            "exe", "bat", "cmd", "scr", "vbs", "ps1", "msi", "reg", "com", "pif",
                        ]
                        .contains(&ext.as_str());
                        if is_executable {
                            let _ = std::process::Command::new("explorer.exe")
                                .arg(format!("/select,{}", file_path.to_string_lossy()))
                                .spawn();
                        } else {
                            let _ = std::process::Command::new("explorer.exe")
                                .arg(file_path)
                                .spawn();
                        }
                    }
                }
            }
            AppReply::Success {
                action: "open_file".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadFolder { id } => {
            let s = store.lock().unwrap();
            if let Ok(records) = s.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    let file_path = PathBuf::from(&r.save_dir).join(&r.filename);
                    if file_path.exists() {
                        let _ = std::process::Command::new("explorer.exe")
                            .arg(format!("/select,{}", file_path.to_string_lossy()))
                            .spawn();
                    } else {
                        let _ = std::process::Command::new("explorer.exe")
                            .arg(&r.save_dir)
                            .spawn();
                    }
                }
            }
            AppReply::Success {
                action: "open_folder".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RemoveDownloadHistory { id } => {
            let s = store.lock().unwrap();
            let _ = s.delete_download(id);
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

fn read_message<R: Read>(mut reader: R) -> io::Result<Option<ExtensionMessage>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes) {
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_ne_bytes(len_bytes) as usize;
    if len > 10 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Message too large",
        ));
    }

    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;

    let msg: ExtensionMessage =
        serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(Some(msg))
}

fn write_reply<W: Write>(mut writer: W, reply: &AppReply) -> io::Result<()> {
    let json_bytes =
        serde_json::to_vec(reply).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let len = (json_bytes.len() as u32).to_ne_bytes();
    writer.write_all(&len)?;
    writer.write_all(&json_bytes)?;
    writer.flush()?;
    Ok(())
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let store = Arc::new(Mutex::new(open_store()));

    // If --serve argument is provided, start local loopback HTTP API for fallback connectivity
    if args.iter().any(|a| a == "--serve") {
        use axum::extract::State;
        use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
        use axum::routing::post;
        use axum::{Json, Router};
        use tower_http::cors::{AllowOrigin, CorsLayer};

        let store_state = store.clone();
        let app = Router::new()
            .route(
                "/api",
                post(
                    |headers: HeaderMap,
                     State(s): State<Arc<Mutex<Store>>>,
                     Json(msg): Json<ExtensionMessage>| async move {
                        // Security Guard 1: Loopback Host enforcement
                        if let Some(host) = headers.get(axum::http::header::HOST) {
                            if let Ok(h) = host.to_str() {
                                if !h.starts_with("127.0.0.1") && !h.starts_with("localhost") {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Host must be loopback",
                                    ));
                                }
                            }
                        }

                        // Security Guard 2: Anti-CSRF Origin check (reject malicious website origins)
                        if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                            if let Ok(o) = origin.to_str() {
                                let is_ext = o.starts_with("chrome-extension://")
                                    || o.starts_with("moz-extension://");
                                let is_local = o.starts_with("http://localhost:")
                                    || o.starts_with("http://127.0.0.1:")
                                    || o.starts_with("tauri://");
                                if !is_ext && !is_local {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Untrusted Origin",
                                    ));
                                }
                            }
                        }

                        // Security Guard 3: Block cross-site browser fetches
                        if let Some(sec_site) = headers.get("sec-fetch-site") {
                            if let Ok(site) = sec_site.to_str() {
                                if site == "cross-site" {
                                    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                                        if let Ok(o) = origin.to_str() {
                                            if !o.starts_with("chrome-extension://")
                                                && !o.starts_with("moz-extension://")
                                            {
                                                return Err((
                                                    StatusCode::FORBIDDEN,
                                                    "Forbidden: Cross-site request rejected",
                                                ));
                                            }
                                        }
                                    } else {
                                        return Err((
                                            StatusCode::FORBIDDEN,
                                            "Forbidden: Cross-site request rejected",
                                        ));
                                    }
                                }
                            }
                        }

                        let reply = handle_message(msg, &s);
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
            .with_state(store_state);

        println!("EDM Native Host HTTP Bridge listening on http://127.0.0.1:8998/api");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:8998").await?;
        axum::serve(listener, app).await?;
        return Ok(());
    }

    // Default: Native Messaging Host over length-prefixed stdin/stdout
    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Ok(Some(msg)) = read_message(&mut reader) {
        let reply = handle_message(msg, &store);
        write_reply(&mut writer, &reply)?;
    }

    Ok(())
}
