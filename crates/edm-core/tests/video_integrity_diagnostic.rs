use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use edm_core::adaptive::{AdaptiveConfig, AdaptiveDownloadTask, AdaptiveEngine};
use edm_core::verify::{compare_files, VerificationReport};
use edm_store::Store;
use futures_util::stream;
use sha2::{Digest, Sha256};
use std::convert::Infallible;
use std::fs::File;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use uuid::Uuid;

pub const TEST_FILE_SIZE: u64 = 64 * 1024 * 1024; // 64 MiB
pub const SEED: u64 = 0x9E3779B97F4A7C15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerBehavior {
    Normal,
    IgnoreRange,
    RandomLatency,
    DropConnection,
    ChangeETag,
    ThrottleSomeWorkers,
}

#[derive(Clone)]
pub struct MockServerState {
    pub file_bytes: Arc<Vec<u8>>,
    pub behavior: ServerBehavior,
    pub request_count: Arc<AtomicUsize>,
    pub etag_generation: Arc<AtomicUsize>,
}

pub fn generate_deterministic_buffer(size: u64, seed: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(size as usize);
    let mut s = seed;
    // Fast xorshift64* pseudo-random sequence
    for _ in 0..size {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        let val = s.wrapping_mul(0x2545F4914F6CDD1D);
        buf.push((val & 0xFF) as u8);
    }
    buf
}

async fn handle_head(State(state): State<MockServerState>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&state.file_bytes.len().to_string()).unwrap(),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let etag = if state.behavior == ServerBehavior::ChangeETag
        && state.etag_generation.load(Ordering::Relaxed) >= 2
    {
        "\"etag-v2-changed\""
    } else {
        "\"etag-v1-initial\""
    };
    headers.insert(header::ETAG, HeaderValue::from_static(etag));
    (StatusCode::OK, headers).into_response()
}

async fn handle_file(
    State(state): State<MockServerState>,
    headers_in: HeaderMap,
) -> Response {
    let req_idx = state.request_count.fetch_add(1, Ordering::SeqCst);
    let total_len = state.file_bytes.len() as u64;

    if state.behavior == ServerBehavior::ChangeETag && req_idx >= 3 {
        state.etag_generation.store(3, Ordering::SeqCst);
    }

    let etag = if state.behavior == ServerBehavior::ChangeETag
        && state.etag_generation.load(Ordering::Relaxed) >= 3
    {
        "\"etag-v2-changed\""
    } else {
        "\"etag-v1-initial\""
    };

    let range_opt = headers_in.get(header::RANGE).and_then(|v| v.to_str().ok());

    // Behavior (a): Ignore Range and return 200 OK with full body
    if state.behavior == ServerBehavior::IgnoreRange || range_opt.is_none() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&total_len.to_string()).unwrap(),
        );
        headers.insert(header::ETAG, HeaderValue::from_static(etag));
        return (
            StatusCode::OK,
            headers,
            Body::from(state.file_bytes.as_ref().clone()),
        )
            .into_response();
    }

    let range_str = range_opt.unwrap();
    let (start, end) = if let Some(stripped) = range_str.strip_prefix("bytes=") {
        let parts: Vec<&str> = stripped.split('-').collect();
        let s = parts[0].parse::<u64>().unwrap_or(0);
        let e = if parts.len() > 1 && !parts[1].is_empty() {
            parts[1].parse::<u64>().unwrap_or(total_len - 1)
        } else {
            total_len - 1
        };
        (s, e.min(total_len - 1))
    } else {
        (0, total_len - 1)
    };

    let slice_len = (end - start + 1) as usize;
    let slice_data = &state.file_bytes[(start as usize)..=(end as usize)];

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::CONTENT_RANGE,
        HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total_len)).unwrap(),
    );
    resp_headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&slice_len.to_string()).unwrap(),
    );
    resp_headers.insert(header::ETAG, HeaderValue::from_static(etag));
    resp_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));

    // Check behavior-specific body streams
    match state.behavior {
        ServerBehavior::DropConnection => {
            // (c) Randomly drops connections mid-body (short Content-Length delivery)
            if req_idx % 2 == 1 && slice_len > 128 * 1024 {
                let half = slice_len / 2;
                let chunk = Bytes::copy_from_slice(&slice_data[..half]);
                let stream = stream::iter(vec![
                    Ok::<_, Infallible>(chunk),
                ]);
                (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from_stream(stream)).into_response()
            } else {
                let body_bytes = Bytes::copy_from_slice(slice_data);
                (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from(body_bytes)).into_response()
            }
        }
        ServerBehavior::RandomLatency => {
            // (b) Random latency per request
            let delay_ms = 10 + ((req_idx as u64 * 31) % 60);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let body_bytes = Bytes::copy_from_slice(slice_data);
            (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from(body_bytes)).into_response()
        }
        ServerBehavior::ThrottleSomeWorkers => {
            // (e) Throttles some connections hard so work stealing triggers
            let is_throttled = req_idx == 0 || start < 4 * 1024 * 1024;
            if is_throttled {
                let chunk_size = 64 * 1024;
                let chunks: Vec<Bytes> = slice_data
                    .chunks(chunk_size)
                    .map(|c| Bytes::copy_from_slice(c))
                    .collect();
                let stream = futures_util::stream::unfold((chunks, 0), |(chunks, idx)| async move {
                    if idx >= chunks.len() {
                        None
                    } else {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        let c = chunks[idx].clone();
                        Some((Ok::<_, Infallible>(c), (chunks, idx + 1)))
                    }
                });
                (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from_stream(stream)).into_response()
            } else {
                let body_bytes = Bytes::copy_from_slice(slice_data);
                (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from(body_bytes)).into_response()
            }
        }
        _ => {
            let body_bytes = Bytes::copy_from_slice(slice_data);
            (StatusCode::PARTIAL_CONTENT, resp_headers, Body::from(body_bytes)).into_response()
        }
    }
}

pub async fn spawn_diagnostic_server(
    file_bytes: Arc<Vec<u8>>,
    behavior: ServerBehavior,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let state = MockServerState {
        file_bytes,
        behavior,
        request_count: Arc::new(AtomicUsize::new(0)),
        etag_generation: Arc::new(AtomicUsize::new(0)),
    };

    let app = Router::new()
        .route("/file.mp4", get(handle_file).head(handle_head))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

pub async fn run_diagnostic_matrix_test(
    connections: u32,
    behavior: ServerBehavior,
    golden_path: &Path,
    file_bytes: Arc<Vec<u8>>,
) -> VerificationReport {
    let (addr, server_handle) = spawn_diagnostic_server(file_bytes.clone(), behavior).await;
    let url = format!("http://{}/file.mp4", addr);

    let temp_dir = TempDir::new().unwrap();
    let store = Store::open_in_memory().unwrap();
    let engine = AdaptiveEngine::new(store);

    let config = AdaptiveConfig {
        initial_connections: connections,
        min_connections: 1,
        max_connections: connections,
        min_chunk_size: 1024 * 1024, // 1 MiB
        sample_interval: Duration::from_millis(50),
        cooldown_duration: Duration::from_millis(100),
        stall_timeout: Duration::from_secs(3),
        max_worker_retries: 5,
        ..Default::default()
    };

    let filename = format!("test_conn_{}_{:?}.mp4", connections, behavior);
    let task = AdaptiveDownloadTask {
        id: Uuid::new_v4(),
        url,
        filename: filename.clone(),
        save_dir: temp_dir.path().to_path_buf(),
        config,
        limiter: None,
        cancelled: Arc::new(AtomicBool::new(false)),
        cookies: None,
        referer: None,
        user_agent: None,
    };

    let res = engine.download(task, None).await;
    let downloaded_path = match res {
        Ok(p) => p,
        Err(e) => {
            println!("Download error for {:?} with {} conns: {}", behavior, connections, e);
            temp_dir.path().join(filename)
        }
    };

    let report = compare_files(golden_path, &downloaded_path, Some(1024 * 1024), &[])
        .expect("compare_files failed");

    server_handle.abort();
    report
}

#[tokio::test]
async fn test_phase1_diagnostic_matrix() {
    let golden_dir = TempDir::new().unwrap();
    let golden_path = golden_dir.path().join("golden_64mb.mp4");

    println!("Generating 64 MiB ground-truth deterministic buffer...");
    let file_bytes = Arc::new(generate_deterministic_buffer(TEST_FILE_SIZE, SEED));
    {
        let mut f = File::create(&golden_path).unwrap();
        f.write_all(&file_bytes).unwrap();
        f.flush().unwrap();
    }
    let mut hasher = Sha256::new();
    hasher.update(&*file_bytes);
    let golden_sha = hex::encode(hasher.finalize());
    println!("Ground Truth SHA-256: {}", golden_sha);

    let test_conns = [1, 2, 4, 8, 16, 32];
    let behaviors = [
        ServerBehavior::Normal,
        ServerBehavior::IgnoreRange,
        ServerBehavior::RandomLatency,
        ServerBehavior::DropConnection,
        ServerBehavior::ChangeETag,
        ServerBehavior::ThrottleSomeWorkers,
    ];

    let mut failure_count = 0;
    let mut total_tests = 0;

    println!("\n================ PHASE 1 DIAGNOSTIC MATRIX RUN ================");
    for &behavior in &behaviors {
        for &conns in &test_conns {
            total_tests += 1;
            print!("Testing Behavior: {:<20} | Connections: {:>2} ... ", format!("{:?}", behavior), conns);
            std::io::stdout().flush().unwrap();

            let report = run_diagnostic_matrix_test(conns, behavior, &golden_path, file_bytes.clone()).await;
            if report.is_identical {
                println!("PASS (SHA-256 Match)");
            } else {
                failure_count += 1;
                println!("FAIL (CORRUPTED!)");
                println!(
                    "   -> Expected SHA: {}\n   -> Actual SHA:   {}\n   -> Diff bytes:   {} (ranges: {})",
                    report.file_a_sha256, report.file_b_sha256, report.total_diff_bytes, report.total_diff_ranges
                );
                if !report.diff_ranges.is_empty() {
                    for (i, r) in report.diff_ranges.iter().take(3).enumerate() {
                        println!(
                            "      Range {}: 0x{:X}..0x{:X} (len {}) | {}",
                            i + 1, r.start, r.start + r.len - 1, r.len, r.boundary_note
                        );
                    }
                }
            }
        }
    }
    println!("===============================================================");
    println!("Diagnostic Matrix Completed: {} / {} passed, {} failed.", total_tests - failure_count, total_tests, failure_count);
}
