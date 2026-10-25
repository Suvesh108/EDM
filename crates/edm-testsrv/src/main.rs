use axum::{
    body::Body,
    extract::{Path as AxumPath, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use clap::Parser;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

#[derive(Parser, Debug)]
#[command(author, version, about = "EDM Chaos Test Server")]
struct Args {
    #[arg(short, long, default_value_t = 8899)]
    port: u16,
}

#[tokio::main]
async fn main() {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let args = Args::parse();
    let app = Router::new()
        .route("/file/{size}", get(handle_file).head(handle_head))
        .route("/health", get(|| async { "OK" }));

    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    info!("edm-testsrv listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
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

    headers.insert(
        header::ETAG,
        HeaderValue::from_static("\"test-etag-12345\""),
    );
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

    if let Some(delay) = params.get("delay_ms").and_then(|d| d.parse::<u64>().ok()) {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }

    // Rate limiting simulation: status=429&retry_after=5
    if params.get("status").map(|s| s.as_str()) == Some("429") {
        let retry_after = params
            .get("retry_after")
            .cloned()
            .unwrap_or_else(|| "5".into());
        let mut headers = HeaderMap::new();
        headers.insert(
            header::RETRY_AFTER,
            HeaderValue::from_str(&retry_after).unwrap(),
        );
        return (StatusCode::TOO_MANY_REQUESTS, headers, "Rate limited").into_response();
    }

    // Check Range header
    let range_header = headers_in.get(header::RANGE).and_then(|v| v.to_str().ok());
    let norange = params.contains_key("norange");
    let wrongrange = params.contains_key("wrongrange");

    let (start, end, is_partial) = if let Some(range_str) = range_header {
        if norange || wrongrange {
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

    // Deterministic payload generation
    let mut payload = Vec::with_capacity(content_len as usize);
    for i in start..=end {
        let byte = ((i.wrapping_mul(seed).wrapping_add(seed)) % 256) as u8;
        payload.push(byte);
    }

    // Compute expected sha256 for the whole file
    let mut full_hasher = Sha256::new();
    for i in 0..total_size {
        let byte = ((i.wrapping_mul(seed).wrapping_add(seed)) % 256) as u8;
        full_hasher.update([byte]);
    }
    let full_sha256 = hex::encode(full_hasher.finalize());

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-test-sha256"),
        HeaderValue::from_str(&full_sha256).unwrap(),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_static("\"test-etag-12345\""),
    );

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

use axum::http::header::HeaderName;
