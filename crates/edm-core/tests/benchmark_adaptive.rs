use axum::{
    body::Body,
    extract::{Path as AxumPath, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use edm_core::adaptive::{AdaptiveConfig, AdaptiveDownloadTask, AdaptiveEngine};
use edm_core::{DownloadTask, Engine};
use edm_store::Store;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;
use uuid::Uuid;

async fn spawn_bench_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let app = Router::new().route("/bench/{size}", get(handle_bench_file).head(handle_bench_head));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

async fn handle_bench_head(AxumPath(size_str): AxumPath<String>) -> Response {
    let size: u64 = size_str.parse().unwrap_or(1024);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap(),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::ETAG, HeaderValue::from_static("\"bench-etag\""));
    (StatusCode::OK, headers).into_response()
}

async fn handle_bench_file(
    AxumPath(size_str): AxumPath<String>,
    headers_in: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let total_size: u64 = size_str.parse().unwrap_or(1024);
    let delay_per_chunk_ms = params
        .get("chunk_delay_ms")
        .and_then(|d| d.parse::<u64>().ok())
        .unwrap_or(15);

    let range_header = headers_in.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (start, end, is_partial) = if let Some(range_str) = range_header {
        if let Some(bytes_part) = range_str.strip_prefix("bytes=") {
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

    // Stream paced chunks to simulate real CDN per-connection rate limiting
    let chunk_size: usize = 256 * 1024; // 256 KiB
    let stream = futures_util::stream::unfold(
        (0usize, content_len as usize, delay_per_chunk_ms),
        move |(sent, total, delay)| async move {
            if sent >= total {
                None
            } else {
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let this_chunk = chunk_size.min(total - sent);
                let chunk = vec![0xAAu8; this_chunk];
                Some((
                    Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(chunk)),
                    (sent + this_chunk, total, delay),
                ))
            }
        },
    );

    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::ETAG, HeaderValue::from_static("\"bench-etag\""));

    if is_partial {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total_size)).unwrap(),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&content_len.to_string()).unwrap(),
        );
        (StatusCode::PARTIAL_CONTENT, headers, Body::from_stream(stream)).into_response()
    } else {
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&total_size.to_string()).unwrap(),
        );
        (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
    }
}

#[tokio::test]
async fn benchmark_baseline_vs_adaptive() {
    let (addr, _server) = spawn_bench_server().await;
    let file_size: u64 = 8 * 1024 * 1024; // 8 MiB
    let url = format!("http://{}/bench/{}?chunk_delay_ms=10", addr, file_size);

    println!("\n==========================================================================");
    println!("      EDM DOWNLOAD ENGINE PERFORMANCE BENCHMARK (8 MiB CDN Simulation)      ");
    println!("==========================================================================");

    // 1. Run Baseline Engine (Single connection, static planner)
    let dir1 = tempdir().expect("tempdir1");
    let store1 = Store::open_in_memory().expect("store1");
    let baseline_engine = Engine::new(store1);

    let task1 = DownloadTask {
        id: Uuid::new_v4(),
        url: url.clone(),
        filename: "baseline_16mb.dat".into(),
        save_dir: dir1.path().to_path_buf(),
        connections: 1,
        cancelled: Arc::new(AtomicBool::new(false)),
    };

    let t0 = Instant::now();
    let baseline_res = baseline_engine.download(task1, None).await.expect("baseline download");
    let baseline_time = t0.elapsed();
    let baseline_throughput_mbps =
        (file_size as f64 * 8.0) / (baseline_time.as_secs_f64() * 1_000_000.0);

    assert!(baseline_res.exists());
    assert_eq!(std::fs::metadata(&baseline_res).unwrap().len(), file_size);

    // 2. Run Adaptive Acceleration Engine (Dynamic work stealing + adaptive controller)
    let dir2 = tempdir().expect("tempdir2");
    let store2 = Store::open_in_memory().expect("store2");
    let adaptive_engine = AdaptiveEngine::new(store2);

    let config = AdaptiveConfig {
        initial_connections: 4,
        min_connections: 1,
        max_connections: 8,
        min_chunk_size: 1024 * 1024,
        sample_interval: Duration::from_millis(50),
        cooldown_duration: Duration::from_millis(100),
        ..Default::default()
    };

    let task2 = AdaptiveDownloadTask {
        id: Uuid::new_v4(),
        url: url.clone(),
        filename: "adaptive_16mb.dat".into(),
        save_dir: dir2.path().to_path_buf(),
        config,
        limiter: None,
        cancelled: Arc::new(AtomicBool::new(false)),
    };

    let t1 = Instant::now();
    let adaptive_res = adaptive_engine.download(task2, None).await.expect("adaptive download");
    let adaptive_time = t1.elapsed();
    let adaptive_throughput_mbps =
        (file_size as f64 * 8.0) / (adaptive_time.as_secs_f64() * 1_000_000.0);

    assert!(adaptive_res.exists());
    assert_eq!(std::fs::metadata(&adaptive_res).unwrap().len(), file_size);

    let speedup = baseline_time.as_secs_f64() / adaptive_time.as_secs_f64();

    println!("\nBenchmark Results Summary:");
    println!("| Engine Variant           | Connections | Duration (s) | Throughput (Mbps) | Speedup Ratio |");
    println!("|:-------------------------|:-----------:|:------------:|:-----------------:|:-------------:|");
    println!(
        "| Baseline (Static 1-Conn) | 1           | {:>10.2}s  | {:>15.2}   | 1.00x (Base)  |",
        baseline_time.as_secs_f64(),
        baseline_throughput_mbps
    );
    println!(
        "| Adaptive Engine (Auto)   | 4-8 Dynamic | {:>10.2}s  | {:>15.2}   | {:>11.2}x   |",
        adaptive_time.as_secs_f64(),
        adaptive_throughput_mbps,
        speedup
    );
    println!("==========================================================================\n");

    assert!(
        speedup >= 1.5,
        "Adaptive engine must achieve >= 1.5x speedup over static single-stream under latency (achieved {:.2}x)",
        speedup
    );
}
