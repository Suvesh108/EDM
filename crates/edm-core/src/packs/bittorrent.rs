//! BitTorrent & Magnet Feature Pack (Native Rust Implementation)
//! Features: Magnet links, torrents, peers, trackers, bencode parser, peer wire protocol

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagnetInfo {
    pub info_hash_hex: String,
    pub display_name: Option<String>,
    pub trackers: Vec<String>,
    pub exact_topic: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BencodeValue {
    Integer(i64),
    ByteString(Vec<u8>),
    List(Vec<BencodeValue>),
    Dict(BTreeMap<Vec<u8>, BencodeValue>),
}

pub struct BitTorrentPack;

impl BitTorrentPack {
    /// Download a torrent or magnet URI in-process using librqbit
    pub async fn download_in_process(
        task: crate::adaptive::AdaptiveDownloadTask,
        telemetry_cb: Option<crate::adaptive::TelemetryCallback>,
    ) -> Result<std::path::PathBuf, String> {
        use crate::adaptive::{AccelerationMode, AdaptiveTelemetry, WorkerStatus, WorkerTelemetry};
        use chrono::Utc;
        use librqbit::{AddTorrent, AddTorrentOptions, Session, SessionOptions};
        use std::sync::atomic::Ordering;
        use std::time::Duration;

        let session_opts = SessionOptions {
            ..Default::default()
        };

        let session = Session::new_with_opts(task.save_dir.clone(), session_opts)
            .await
            .map_err(|e| format!("Failed to create BitTorrent session: {}", e))?;

        let add_torrent = if task.url.starts_with("magnet:")
            || task.url.starts_with("http://")
            || task.url.starts_with("https://")
        {
            AddTorrent::from_url(&task.url)
        } else {
            let path = std::path::PathBuf::from(&task.url);
            if path.exists() {
                let data = tokio::fs::read(&path)
                    .await
                    .map_err(|e| format!("Failed to read .torrent file: {}", e))?;
                AddTorrent::from_bytes(data)
            } else {
                AddTorrent::from_url(&task.url)
            }
        };

        let add_opts = AddTorrentOptions {
            paused: false,
            ..Default::default()
        };

        let handle_res = session
            .add_torrent(add_torrent, Some(add_opts))
            .await
            .map_err(|e| format!("Failed to add torrent: {}", e))?;

        let handle = handle_res
            .into_handle()
            .ok_or_else(|| "Torrent already exists or could not create handle".to_string())?;

        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        let mut target_file_path = task.save_dir.join(&task.filename);

        loop {
            ticker.tick().await;

            if task.cancelled.load(Ordering::Relaxed) {
                let _ = session.stop().await;
                return Err("BitTorrent download cancelled by user".to_string());
            }

            let stats = handle.stats();
            let total_bytes = if stats.total_bytes > 0 {
                Some(stats.total_bytes)
            } else {
                None
            };
            let progress_pct = if stats.total_bytes > 0 {
                (stats.progress_bytes as f64 / stats.total_bytes as f64) * 100.0
            } else {
                0.0
            };

            let (live_conns, dl_speed) = if let Some(ref live) = stats.live {
                (
                    live.snapshot.peer_stats.live,
                    live.download_speed.as_bytes(),
                )
            } else {
                (1, 0)
            };

            if let Some(name) = handle.name() {
                target_file_path = task.save_dir.join(name);
            }

            if let Some(ref cb) = telemetry_cb {
                cb(AdaptiveTelemetry {
                    download_id: task.id.to_string(),
                    total_bytes,
                    downloaded_bytes: stats.progress_bytes,
                    progress_pct,
                    instant_throughput_bps: dl_speed * 8,
                    rolling_throughput_bps: dl_speed * 8,
                    active_connections: live_conns.max(1),
                    max_allowed_connections: 64,
                    mode: AccelerationMode::Stable,
                    eta_seconds: if dl_speed > 0 && stats.total_bytes > stats.progress_bytes {
                        Some((stats.total_bytes - stats.progress_bytes) / dl_speed)
                    } else {
                        None
                    },
                    decision_reason: format!("BitTorrent Swarm ({} peers)", live_conns),
                    workers: vec![WorkerTelemetry {
                        idx: 0,
                        start: 0,
                        end: stats.total_bytes,
                        pos: stats.progress_bytes,
                        bytes_downloaded: stats.progress_bytes,
                        speed_bps: dl_speed * 8,
                        status: if stats.finished {
                            WorkerStatus::Completed
                        } else {
                            WorkerStatus::Downloading
                        },
                        retry_count: 0,
                    }],
                    updated_at: Utc::now(),
                });
            }

            if stats.finished || progress_pct >= 100.0 {
                break;
            }
        }

        Ok(target_file_path)
    }
    /// Parse a magnet URI into info hash, display name, and tracker list
    pub fn parse_magnet(uri: &str) -> Result<MagnetInfo, String> {
        let trimmed = uri.trim();
        let query_part = trimmed
            .strip_prefix("magnet:?")
            .ok_or_else(|| "Invalid magnet URI prefix".to_string())?;

        let mut info_hash_hex = None;
        let mut display_name = None;
        let mut trackers = Vec::new();
        let mut exact_topic = String::new();

        for pair in query_part.split('&') {
            if let Some(xt) = pair.strip_prefix("xt=") {
                exact_topic = xt.to_string();
                if let Some(hash) = xt.strip_prefix("urn:btih:") {
                    // Check if 40-char hex or 32-char base32
                    if hash.len() == 40 {
                        info_hash_hex = Some(hash.to_ascii_lowercase());
                    } else if hash.len() == 32 {
                        // Decode base32 to hex if needed
                        info_hash_hex = Some(hash.to_ascii_lowercase());
                    }
                }
            } else if let Some(dn) = pair.strip_prefix("dn=") {
                let decoded = urlencoding::decode(dn).unwrap_or(std::borrow::Cow::Borrowed(dn));
                display_name = Some(decoded.to_string());
            } else if let Some(tr) = pair.strip_prefix("tr=") {
                let decoded = urlencoding::decode(tr).unwrap_or(std::borrow::Cow::Borrowed(tr));
                trackers.push(decoded.to_string());
            }
        }

        let hash = info_hash_hex
            .ok_or_else(|| "Magnet URI missing valid xt=urn:btih parameter".to_string())?;

        Ok(MagnetInfo {
            info_hash_hex: hash,
            display_name,
            trackers,
            exact_topic,
        })
    }

    /// Build a standard 68-byte BitTorrent peer wire handshake buffer
    pub fn build_peer_handshake(info_hash_bytes: &[u8; 20], peer_id_bytes: &[u8; 20]) -> [u8; 68] {
        let mut packet = [0u8; 68];
        packet[0] = 19; // length of protocol string
        packet[1..20].copy_from_slice(b"BitTorrent protocol");
        packet[20..28].copy_from_slice(&[0u8; 8]); // 8 reserved extension bytes
        packet[28..48].copy_from_slice(info_hash_bytes);
        packet[48..68].copy_from_slice(peer_id_bytes);
        packet
    }

    /// Parse Bencoded binary data into a structured BencodeValue
    pub fn decode_bencode(bytes: &[u8]) -> Result<BencodeValue, String> {
        let mut pos = 0;
        Self::parse_bencode_recursive(bytes, &mut pos)
    }

    fn parse_bencode_recursive(bytes: &[u8], pos: &mut usize) -> Result<BencodeValue, String> {
        if *pos >= bytes.len() {
            return Err("Unexpected end of bencoded stream".to_string());
        }

        match bytes[*pos] {
            b'i' => {
                *pos += 1;
                let start = *pos;
                while *pos < bytes.len() && bytes[*pos] != b'e' {
                    *pos += 1;
                }
                if *pos >= bytes.len() {
                    return Err("Unterminated bencode integer".to_string());
                }
                let int_str = std::str::from_utf8(&bytes[start..*pos])
                    .map_err(|e| format!("Invalid integer bytes: {}", e))?;
                *pos += 1; // skip 'e'
                let val = int_str
                    .parse::<i64>()
                    .map_err(|e| format!("Bad integer: {}", e))?;
                Ok(BencodeValue::Integer(val))
            }
            b'l' => {
                *pos += 1;
                let mut list = Vec::new();
                while *pos < bytes.len() && bytes[*pos] != b'e' {
                    list.push(Self::parse_bencode_recursive(bytes, pos)?);
                }
                if *pos >= bytes.len() {
                    return Err("Unterminated bencode list".to_string());
                }
                *pos += 1; // skip 'e'
                Ok(BencodeValue::List(list))
            }
            b'd' => {
                *pos += 1;
                let mut dict = BTreeMap::new();
                while *pos < bytes.len() && bytes[*pos] != b'e' {
                    let key = match Self::parse_bencode_recursive(bytes, pos)? {
                        BencodeValue::ByteString(s) => s,
                        _ => return Err("Bencode dictionary key must be a byte string".to_string()),
                    };
                    let val = Self::parse_bencode_recursive(bytes, pos)?;
                    dict.insert(key, val);
                }
                if *pos >= bytes.len() {
                    return Err("Unterminated bencode dict".to_string());
                }
                *pos += 1; // skip 'e'
                Ok(BencodeValue::Dict(dict))
            }
            b'0'..=b'9' => {
                let start = *pos;
                while *pos < bytes.len() && bytes[*pos] >= b'0' && bytes[*pos] <= b'9' {
                    *pos += 1;
                }
                if *pos >= bytes.len() || bytes[*pos] != b':' {
                    return Err("Expected ':' delimiter in byte string length".to_string());
                }
                let len_str = std::str::from_utf8(&bytes[start..*pos])
                    .map_err(|e| format!("Invalid length: {}", e))?;
                let len = len_str
                    .parse::<usize>()
                    .map_err(|e| format!("Bad length: {}", e))?;
                *pos += 1; // skip ':'

                if *pos + len > bytes.len() {
                    return Err("Byte string length exceeds buffer".to_string());
                }
                let slice = bytes[*pos..*pos + len].to_vec();
                *pos += len;
                Ok(BencodeValue::ByteString(slice))
            }
            other => Err(format!("Unexpected byte in bencode stream: {:#x}", other)),
        }
    }
}
