use axum::{
    body::Body,
    extract::{Path as AxumPath, Query},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use edm_core::adaptive::{
    AccelerationMode, AdaptiveConfig, AdaptiveController, AdaptiveDecision, AdaptiveDownloadTask,
    AdaptiveEngine,
};
use edm_core::limiter::TokenBucketLimiter;
use edm_store::Store;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use uuid::Uuid;

// Spawn an in-process mock HTTP test server on an ephemeral port
async fn spawn_mock_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let app = Router::new().route("/file/{size}", get(handle_file).head(handle_head));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

async fn handle_head(
    AxumPath(size_str): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if params.contains_key("head405") {
        return (StatusCode::METHOD_NOT_ALLOWED, "HEAD rejected").into_response();
    }
    let size: u64 = size_str.parse().unwrap_or(1024);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap(),
    );
    if !params.contains_key("norange") {
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    headers.insert(header::ETAG, HeaderValue::from_static("\"mock-etag\""));
    (StatusCode::OK, headers).into_response()
}

async fn handle_file(
    AxumPath(size_str): AxumPath<String>,
    headers_in: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let total_size: u64 = size_str.parse().unwrap_or(1024);
    let seed: u64 = params
        .get("seed")
        .and_then(|s| s.parse().ok())
        .unwrap_or(42);

    if params.get("status").map(|s| s.as_str()) == Some("429") {
        let mut headers = HeaderMap::new();
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        return (StatusCode::TOO_MANY_REQUESTS, headers, "Rate limited").into_response();
    }

    let range_header = headers_in.get(header::RANGE).and_then(|v| v.to_str().ok());
    let norange = params.contains_key("norange");
    let (start, end, is_partial) = if let Some(range_str) = range_header {
        if norange {
            (0, total_size - 1, false)
        } else if let Some(bytes_part) = range_str.strip_prefix("bytes=") {
            let parts: Vec<&str> = bytes_part.split('-').collect();
            let start = parts[0].parse::<u64>().unwrap_or(0);
            let end = if parts.len() > 1 && !parts[1].is_empty() {
                parts[1].parse::<u64>().unwrap_or(total_size - 1)
            } else {
                total_size - 1
            };
            (start, end.min(total_size - 1), true)
        } else {
            (0, total_size - 1, false)
        }
    } else {
        (0, total_size - 1, false)
    };

    let content_len = end - start + 1;
    let mut payload = Vec::with_capacity(content_len as usize);
    for i in start..=end {
        let byte = ((i.wrapping_mul(seed).wrapping_add(seed)) % 256) as u8;
        payload.push(byte);
    }

    let mut full_hasher = Sha256::new();
    for i in 0..total_size {
        let byte = ((i.wrapping_mul(seed).wrapping_add(seed)) % 256) as u8;
        full_hasher.update([byte]);
    }
    let expected_sha256 = hex::encode(full_hasher.finalize());

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-expected-sha256"),
        HeaderValue::from_str(&expected_sha256).unwrap(),
    );
    headers.insert(header::ETAG, HeaderValue::from_static("\"mock-etag\""));
    if !norange {
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }

    if is_partial {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total_size)).unwrap(),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&content_len.to_string()).unwrap(),
        );
        (StatusCode::PARTIAL_CONTENT, headers, Body::from(payload)).into_response()
    } else {
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&total_size.to_string()).unwrap(),
        );
        (StatusCode::OK, headers, Body::from(payload)).into_response()
    }
}

fn compute_file_sha256(path: &std::path::Path) -> String {
    let data = std::fs::read(path).expect("read file");
    let mut hasher = Sha256::new();
    hasher.update(&data);
    hex::encode(hasher.finalize())
}

#[tokio::test]
async fn test_adaptive_download_full_integrity() {
    let (addr, _server) = spawn_mock_server().await;
    let file_size: u64 = 4 * 1024 * 1024; // 4 MiB
    let url = format!("http://{}/file/{}?seed=1337", addr, file_size);

    let dir = tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let engine = AdaptiveEngine::new(store);

    let config = AdaptiveConfig {
        initial_connections: 2,
        min_connections: 1,
        max_connections: 4,
        min_chunk_size: 512 * 1024, // 512 KiB
        sample_interval: Duration::from_millis(100),
        cooldown_duration: Duration::from_millis(200),
        ..Default::default()
    };

    let task = AdaptiveDownloadTask {
        id: Uuid::new_v4(),
        url: url.clone(),
        filename: "integrity_test.dat".into(),
        save_dir: dir.path().to_path_buf(),
        config,
        limiter: None,
        cancelled: Arc::new(AtomicBool::new(false)),
        cookies: None,
        referer: None,
        user_agent: None,
    };

    let completed_path = engine.download(task, None).await.expect("download failed");
    assert!(completed_path.exists());
    assert_eq!(std::fs::metadata(&completed_path).unwrap().len(), file_size);

    // Compute expected sha256
    let mut full_hasher = Sha256::new();
    for i in 0..file_size {
        let byte = ((i.wrapping_mul(1337).wrapping_add(1337)) % 256) as u8;
        full_hasher.update([byte]);
    }
    let expected = hex::encode(full_hasher.finalize());
    let actual = compute_file_sha256(&completed_path);
    assert_eq!(
        actual, expected,
        "Checksum verification passed with exact match"
    );
}

#[tokio::test]
async fn test_single_stream_fallback_norange() {
    let (addr, _server) = spawn_mock_server().await;
    let file_size: u64 = 2 * 1024 * 1024; // 2 MiB
    let url = format!("http://{}/file/{}?norange=1&seed=99", addr, file_size);

    let dir = tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let engine = AdaptiveEngine::new(store);

    let task = AdaptiveDownloadTask {
        id: Uuid::new_v4(),
        url,
        filename: "norange_fallback.dat".into(),
        save_dir: dir.path().to_path_buf(),
        config: AdaptiveConfig::default(),
        limiter: None,
        cancelled: Arc::new(AtomicBool::new(false)),
        cookies: None,
        referer: None,
        user_agent: None,
    };

    let completed_path = engine
        .download(task, None)
        .await
        .expect("fallback download failed");
    assert!(completed_path.exists());
    assert_eq!(std::fs::metadata(&completed_path).unwrap().len(), file_size);

    // Verify SHA256 integrity
    let mut full_hasher = Sha256::new();
    for i in 0..file_size {
        let byte = ((i.wrapping_mul(99).wrapping_add(99)) % 256) as u8;
        full_hasher.update([byte]);
    }
    let expected = hex::encode(full_hasher.finalize());
    let actual = compute_file_sha256(&completed_path);
    assert_eq!(
        actual, expected,
        "Single-stream fallback correctly reconstructed file"
    );
}

#[test]
fn test_adaptive_controller_decisions() {
    let config = AdaptiveConfig {
        initial_connections: 2,
        min_connections: 1,
        max_connections: 8,
        cooldown_duration: Duration::from_millis(50),
        throughput_gain_threshold: 0.08,
        throughput_drop_threshold: -0.05,
        ..Default::default()
    };

    let mut controller = AdaptiveController::new(config, true);
    assert_eq!(controller.current_connections(), 2);
    assert_eq!(controller.mode(), AccelerationMode::Auto);

    // Sample 1: Baseline sample (1 MB in 1 sec = 8 Mbps)
    std::thread::sleep(Duration::from_millis(60));
    let dec1 = controller.evaluate_sample(1_000_000, Duration::from_secs(1), 0, false, None);
    match dec1 {
        AdaptiveDecision::ScaleUp { from, to, .. } => {
            assert_eq!(from, 2);
            assert_eq!(to, 3);
        }
        _ => panic!("Expected ScaleUp probe"),
    }

    // Sample 2: Meaningful gain (+50% throughput = 12 Mbps)
    std::thread::sleep(Duration::from_millis(60));
    let dec2 = controller.evaluate_sample(1_500_000, Duration::from_secs(1), 0, false, None);
    match dec2 {
        AdaptiveDecision::ScaleUp { from, to, .. } => {
            assert_eq!(from, 3);
            assert_eq!(to, 4);
        }
        _ => panic!("Expected ScaleUp on gain"),
    }

    // Sample 3: Degradation (-40% throughput drop -> back off)
    std::thread::sleep(Duration::from_millis(60));
    let dec3 = controller.evaluate_sample(900_000, Duration::from_secs(1), 0, false, None);
    match dec3 {
        AdaptiveDecision::ScaleDown { from, to, .. } => {
            assert_eq!(from, 4);
            assert_eq!(to, 3);
        }
        _ => panic!("Expected ScaleDown on degradation"),
    }

    // Sample 4: HTTP 429 rate limit
    let dec4 = controller.evaluate_sample(
        100_000,
        Duration::from_secs(1),
        0,
        true,
        Some(Duration::from_secs(5)),
    );
    match dec4 {
        AdaptiveDecision::LimitRate { retry_after, .. } => {
            assert_eq!(retry_after, Some(Duration::from_secs(5)));
            assert_eq!(controller.mode(), AccelerationMode::Limited);
        }
        _ => panic!("Expected LimitRate on 429"),
    }
}

#[tokio::test]
async fn test_cancellation_and_persistence() {
    let (addr, _server) = spawn_mock_server().await;
    let file_size: u64 = 10 * 1024 * 1024; // 10 MiB
    let url = format!("http://{}/file/{}?seed=77", addr, file_size);

    let dir = tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let engine = AdaptiveEngine::new(store.clone());

    let cancelled = Arc::new(AtomicBool::new(true));
    let id = Uuid::new_v4();

    let task = AdaptiveDownloadTask {
        id,
        url,
        filename: "cancelled_test.dat".into(),
        save_dir: dir.path().to_path_buf(),
        config: AdaptiveConfig::default(),
        limiter: None,
        cancelled: cancelled.clone(),
        cookies: None,
        referer: None,
        user_agent: None,
    };

    let res = engine.download(task, None).await;
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("cancelled"));

    // Verify task is recorded in SQLite as paused
    let state = store
        .get_download_state(id)
        .expect("get_download_state")
        .expect("record exists");
    assert_eq!(state.to_lowercase(), "paused");
}

#[tokio::test]
async fn test_bandwidth_limiter() {
    let (addr, _server) = spawn_mock_server().await;
    let file_size: u64 = 1024 * 1024; // 1 MiB
    let url = format!("http://{}/file/{}?seed=55", addr, file_size);

    let dir = tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let engine = AdaptiveEngine::new(store);

    // Limit to 500 KB/s
    let limiter = TokenBucketLimiter::new(500 * 1024);

    let task = AdaptiveDownloadTask {
        id: Uuid::new_v4(),
        url,
        filename: "limited_test.dat".into(),
        save_dir: dir.path().to_path_buf(),
        config: AdaptiveConfig {
            initial_connections: 1,
            max_connections: 1,
            ..Default::default()
        },
        limiter: Some(limiter),
        cancelled: Arc::new(AtomicBool::new(false)),
        cookies: None,
        referer: None,
        user_agent: None,
    };

    let t0 = std::time::Instant::now();
    let completed_path = engine.download(task, None).await.expect("download failed");
    let elapsed = t0.elapsed();

    assert!(completed_path.exists());
    // 1 MiB with 500 KB initial bucket burst + 500 KB/s rate takes ~1.0-1.2s
    assert!(
        elapsed >= Duration::from_millis(900),
        "Download took {:?}, expected >= 0.9s due to limiter",
        elapsed
    );
}
