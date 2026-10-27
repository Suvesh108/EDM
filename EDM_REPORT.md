# EDM: Comprehensive Read-Only Project Architecture & Bug Analysis Report

**Date**: 2026-10-27  
**Operating System**: Windows 11 Pro (x86_64-pc-windows-gnu)  
**Security Classification**: Redacted (Secrets & Tokens replaced with `<REDACTED>`)

---

## 1. Overview

- **Project Name**: EDM (Edge Download Manager)
- **Purpose**: A high-performance, segmented download accelerator with browser extension companion integration, NTFS sparse allocation, adaptive AIMD / work-stealing concurrency control, and native protocol parsing (HTTP, BitTorrent, eDonkey2000, HLS, GitHub/HuggingFace releases).
- **Current Status**: Active development / Alpha (v0.0.1). Core engine, IPC, SQLite persistence, and Chrome/Brave extension integration are functioning. Tray icon, graceful termination, single-instance recovery, and background headless persistence have identified architectural bugs documented below.
- **Technology Stack**:
  - **Rust Toolchain**: `rustc 1.99.1 (58cf8f9c3 2026-10-13)`, `cargo 1.99.1 (5f94df478 2026-08-27)`, target `x86_64-pc-windows-gnu`
  - **GUI / Shell Framework**: Tauri v2 (`tauri v2.0.0`, with `@tauri-apps/api v2.0.0`, `@tauri-apps/cli v2.0.0`) backed by Microsoft Edge WebView2 (`msedgewebview2.exe` runtime v155.0.4283.62)
  - **Frontend UI Framework**: React 19 (`react v19.0.0`, `react-dom v19.0.0`), TypeScript 5.7 (`typescript v5.7.3`), Tailwind CSS v4 (`tailwindcss v4.0.9`, `@tailwindcss/vite v4.0.9`), Lucide React (`lucide-react v1.16.0`), Motion (`motion v12.4.7`), Zustand (`zustand v5.0.3`)
  - **Frontend Bundler**: Vite v6 (`vite v6.2.0`)
  - **Key Rust Crates**:
    - `tokio v1.43` (multithreaded async runtime)
    - `reqwest v0.12` (rustls-tls, stream)
    - `rusqlite v0.33` (bundled SQLite3)
    - `axum v0.8` & `tower-http v0.6` (fallback HTTP API server on port 8998)
    - `tokio-tungstenite v0.26` (WebSocket server on port 14370)
    - `uuid v1.11`, `chrono v0.4`, `serde v1.0`, `serde_json v1.0`
    - `clap v4.5` (CLI tool `edm-cli`)
    - `open v5.3` (shell file/folder launch)
  - **Key Extension NPM Packages**:
    - `esbuild v0.25.0`
    - `typescript v5.7.0`

---

## 2. Directory Structure & Module Breakdown

```text
EDM/
├── .agents/                        # Local AI workflows and graphify rules
├── .github/workflows/              # GitHub Actions CI/CD workflows
├── apps/
│   └── desktop/                    # Tauri v2 Desktop Application
│       ├── dist/                   # Compiled production frontend assets
│       ├── public/                 # Static assets (logo.png)
│       ├── src/                    # React 19 source code (App.tsx, components/, services/)
│       └── src-tauri/              # Rust Tauri backend (main.rs, ws_server.rs, tauri.conf.json)
├── assets/                         # Documentation assets and icons
├── crates/
│   ├── edm-cli/                    # Command-line downloader tool
│   ├── edm-core/                   # Adaptive engine, probe, NTFS writer, feature packs
│   ├── edm-ipc/                    # Cross-process IPC protocol, types, serialization
│   ├── edm-nmh/                    # Chromium Native Messaging Host binary
│   ├── edm-store/                  # Persistent SQLite database storage and migrations
│   └── edm-testsrv/                # Chaos testing server simulating flaky/range servers
├── docs/                           # Architectural decisions and reports
└── extension/                      # Manifest V3 browser extension (Chrome, Brave, Edge, Firefox)
    ├── dist/                       # Output builds (chromium, firefox)
    └── src/                        # Extension TypeScript source (background.ts, popup.ts, options.ts)
```

### Main Modules:
- **`apps/desktop/src-tauri/src/main.rs`**: Main application entry point, Tauri v2 builder, Mutex single-instance check, internal Axum HTTP fallback server (:8998), and Native Messaging Host registry auto-registration.
- **`apps/desktop/src-tauri/src/ws_server.rs`**: High-performance WebSocket server on `127.0.0.1:14370`, HTTP `/token` endpoint, Origin validation, continuous 500ms broadcast ticker, and secure file launch routines.
- **`apps/desktop/src/App.tsx`**: Main desktop UI dashboard, stats overview, live speed meters, active/completed task cards, and settings modal.
- **`crates/edm-core/src/adaptive/engine.rs`**: Concurrency controller, probe orchestration, AIMD bandwidth scaling, and NTFS sparse file writer initialization.
- **`crates/edm-core/src/adaptive/worker.rs`**: Async segment HTTP chunk worker, exponential retry backoff, and range streaming.
- **`crates/edm-core/src/adaptive/controller.rs`**: AIMD bandwidth throttling and rolling EMA throughput calculation.
- **`crates/edm-core/src/probe.rs`**: RFC 5987 / Content-Disposition header parsing, byte-range validation, and MIME detection.
- **`crates/edm-core/src/writer.rs`**: NTFS sparse allocation file writer preventing pre-allocation disk thrashing.
- **`crates/edm-core/src/sanitizer.rs`**: Windows filename sanitization (strips `CON`, `PRN`, `AUX`, `NUL`, invalid chars) and collision duplicate renaming.
- **`crates/edm-ipc/src/lib.rs`**: Data models (`ExtensionMessage`, `AppReply`, `DownloadOverview`, `DownloadRecord`).
- **`crates/edm-nmh/src/main.rs`**: Chromium stdio 4-byte length-prefixed Native Messaging Host bridging browser to SQLite/Desktop.
- **`crates/edm-store/src/lib.rs`**: Embedded SQLite database (`store.db`) with WAL mode and state transitions.
- **`extension/src/background.ts`**: Manifest V3 background service worker, `onDeterminingFilename` download interceptor, WebSocket client, and auto-token discovery.
- **`extension/src/popup.ts`**: Dual-tab dashboard (Tasks & Settings) with hot reload and live WebSocket monitoring.

---

## 3. Window & UI Initialization (Critical)

### 1. Main Window Creation
- **File & Line**: Created declaratively via Tauri configuration and managed in [`apps/desktop/src-tauri/src/main.rs#L1445-L1456`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L1445-L1456):
  ```rust
  tauri::Builder::default()
      .setup(|app| {
          use tauri::Manager;
          if let Some(window) = app.get_webview_window("main") {
              if let Ok(icon) =
                  tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
              {
                  let _ = window.set_icon(icon);
              }
          }
          Ok(())
      })
  ```
  The window attributes are defined in [`apps/desktop/src-tauri/tauri.conf.json#L12-L25`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/tauri.conf.json#L12-L25):
  ```json
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "EDM — Edge Download Manager v0.0.1",
        "width": 950,
        "height": 660,
        "minWidth": 950,
        "minHeight": 660,
        "resizable": true,
        "decorations": false,
        "transparent": false
      }
    ]
  }
  ```

### 2. URL and Path Loaded in Debug vs Release
- **Configuration** in [`apps/desktop/src-tauri/tauri.conf.json#L6-L11`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/tauri.conf.json#L6-L11):
  ```json
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  }
  ```
  - **Debug (`cargo tauri dev`)**: Loads `http://localhost:1420` (Vite dev server running on port 1420).
  - **Release (`cargo tauri build` or release binary execution)**: Loads embedded static files from `../dist` (`apps/desktop/dist/index.html`) via Tauri's internal custom protocol `tauri://localhost` or `http://tauri.localhost`.

### 3. Internal Local HTTP Servers
There are **two** internal network servers running inside the application:
1. **Fallback HTTP REST API Server**:
   - **Port**: `127.0.0.1:8998`
   - **Implementation**: [`apps/desktop/src-tauri/src/main.rs#L775-L864`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L775-L864) using Axum.
   - **Startup timing**: Spawned in a background thread inside `spawn_extension_bridge()` at line 1244, **before** `tauri::Builder::run()` creates the window.
2. **WebSocket & HTTP Token Server**:
   - **Port**: `127.0.0.1:14370`
   - **Implementation**: [`apps/desktop/src-tauri/src/ws_server.rs#L278-L380`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/ws_server.rs#L278-L380) using `tokio_tungstenite` and raw `TcpListener`.
   - **Startup timing**: Spawned inside Tokio runtime at line 1249, **before** `tauri::Builder::run()`.

### 4. Does the Release Build Need Node/Vite Running?
**NO.**
- **Proof**: In release mode, `"frontendDist": "../dist"` embeds compiled HTML/JS/CSS assets directly into the binary at compile time via Tauri's resource packaging. When running the compiled release binary `edm-desktop-app.exe`, it serves `index.html` directly from memory/WebView2 local bundle without any Node or Vite process. Verified: `Get-Process node` returned no active server during standalone execution.

---

## 4. App Lifecycle

### 1. Startup Order
1. `set_app_user_model_id()`: Registers Windows Application User Model ID (`com.edm.desktop`).
2. `enforce_single_instance()`: Tests Windows Named Mutex `Global\EDM_SingleInstance_Mutex_14370`. If already running, exits immediately.
3. `register_native_messaging_host()`: Generates `com.edm.nmh.json` and writes registry keys for Chrome, Edge, and Brave.
4. `tokio::runtime::Builder::new_multi_thread()`: Spawns 4 worker threads for the asynchronous runtime.
5. `open_persistent_store()`: Opens SQLite database at `%LOCALAPPDATA%\EDM\store.db`.
6. `ws_server::get_or_create_token()`: Reads or generates 64-char hex token in `%APPDATA%\EDM\config\token.txt`.
7. `spawn_extension_bridge()`: Binds Axum HTTP server to `127.0.0.1:8998`.
8. `ws_server::start_ws_server()`: Binds WebSocket & Token server to `127.0.0.1:14370`.
9. `create_task_rx` and `action_rx` loops: Started inside background Tokio tasks.
10. Background keep-alive thread: Spawns infinite loop sleeping 3600s to retain Tokio runtime.
11. `tauri::Builder::default()`: Configures window icon in `.setup()`, registers IPC invoke handlers, and runs WebView2 event loop.

### 2. Single-Instance Mechanism
Implemented via Win32 Named Mutex in [`apps/desktop/src-tauri/src/main.rs#L1176-L1199`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L1176-L1199):
```rust
#[cfg(windows)]
fn enforce_single_instance() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *mut std::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let mutex_name: Vec<u16> = OsStr::new("Global\\EDM_SingleInstance_Mutex_14370")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, mutex_name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        eprintln!("EDM is already running. Exiting second instance.");
        std::process::exit(0);
    }
    let _ = handle;
}
```

### 3. Window Close Behavior
- Handled via custom titlebar command `app_close`:
  ```rust
  #[tauri::command]
  fn app_close(window: tauri::WebviewWindow) {
      let _ = window.close();
  }
  ```
- **Behavior**: Calling `window.close()` closes the WebView2 window. Because Tauri has no system tray icon configured to keep the app active in the background, closing the window triggers Tauri application exit; however, child Tokio background threads may keep background processes alive if OS handles are held.

### 4. Tray Icon
- **Status**: **NOT FOUND / NOT IMPLEMENTED**.
- There is **no tray icon setup code** in `main.rs`, no `.tray()` builder invocation, and no tray icon capability in `tauri.conf.json`.

### 5. Shutdown Handling
- **Graceful Shutdown**: Unfinished download state is saved periodically to SQLite in WAL mode (`store.update_download_progress`). When cancelled or failed, states are written to SQLite.
- **Crash / End Task**: On abrupt termination (`taskkill /F` or End Task), active chunk streams are terminated immediately. Because disk pre-allocation uses NTFS sparse allocation, written bytes are preserved without corruption. Unfinished tasks remain in SQLite in `downloading` state and transition to `paused` or re-probed on next startup.

### 6. Child Processes & Helper Binaries
- **Helper Executables**:
  - `edm-nmh.exe`: Launched on-demand by Chromium browsers (Chrome/Brave/Edge) as a subprocess via stdio pipes. Terminated automatically by the browser when the extension context unloads.
- **Process Spawning**:
  - `apps/desktop/src-tauri/src/main.rs#L96-L109`: Runs `reg add ...` at startup to configure Native Messaging Host entries without creating a visible console (`CREATE_NO_WINDOW = 0x08000000`).

### 7. Panic Hook and Logging
- **Panic Hook**: **NOT FOUND**. Default standard library panic handler is used (prints to stderr and terminates).
- **Logging**: Configured via `tracing_subscriber` in tests and CLI, but `apps/desktop/src-tauri/src/main.rs` does not initialize a file logger. Log messages are directed to standard output/console only. No disk log file is generated by default.

---

## 4b. Extension-to-App Link

### 1. WebSocket Server Specifications
- **Address & Port**: `ws://127.0.0.1:14370`
- **HTTP Handshake & Token Retrieval**:
  - Endpoint: `GET /token` and `OPTIONS /token` on `127.0.0.1:14370`.
  - Origin Validation: Permitted for `chrome-extension://`, `moz-extension://`, loopback, or absent Origin headers (extensions). Web pages (`https://` / `http://` external) are rejected with `403 Forbidden`.
  - Returns JSON: `{"extension_id":"ginpdimhcdbojbhemgjedghkeolbcmgj","token":"<REDACTED>"}`.
- **Token Storage**:
  - File path: `%APPDATA%\EDM\config\token.txt`.
  - Length: 64 characters (two combined UUIDv4s formatted as 32-char hex).
- **Origin Check during WS Upgrade**:
  - Checked in [`apps/desktop/src-tauri/src/ws_server.rs#L389-L407`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/ws_server.rs#L389-L407). Header `Origin` must match `chrome-extension://<EXTENSION_ID>`.
- **First Frame Handshake Invariant**:
  - Extension must send `{"type":"hello","token":"<REDACTED>"}` within 5 seconds. Server verifies against stored token and replies with `{"type":"ready"}`.
- **Supported WebSocket Message Types**:
  - **Inbound (Extension &rarr; App)**:
    - `hello { token }`
    - `ping`
    - `subscribe`
    - `create_task { req_id, url, cookies, referrer, user_agent, filename }`
    - `task_action { id, action }` (`pause` | `resume` | `cancel` | `remove` | `open_file` | `open_folder`)
  - **Outbound (App &rarr; Extension)**:
    - `ready`
    - `pong`
    - `ack { req_id, ok, id, error }`
    - `snapshot { tasks: [...] }`
- **Snapshot Ticker**: Broadcasts an updated task list snapshot every 500ms to all subscribed WebSocket clients.

### 2. Open File / Open Folder Security Handling
Implemented in [`apps/desktop/src-tauri/src/ws_server.rs#L571-L640`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/ws_server.rs#L571-L640):
- **`secure_open_file(dir, filename, status)`**:
  - Validates that `status == "completed"`. Incomplete files cannot be launched.
  - Resolves canonical path and validates against path traversal (`..` and directory separators).
  - Invokes `open::that(target)`.
- **`secure_open_folder(dir, filename)`**:
  - On Windows, executes `explorer.exe /select,<path>` via `Command::new("explorer")` to highlight the downloaded file in Windows Explorer without executing it.

---

## 5. Download Engine

### 1. Task Creation & Probing
1. Task creation triggered via Tauri invoke `start_download` or WebSocket `create_task`.
2. Sanitizer resolves clean filename and checks duplicate collisions with auto-increment naming (`filename (1).ext`).
3. Client executes HTTP `HEAD` / `GET` range probe (`Probe::probe_url_with_headers`):
   - Probes `Range: bytes=0-0`.
   - Checks `206 Partial Content` vs `200 OK` and `Accept-Ranges: bytes`.
   - Extracts Content-Length / total size, ETag, and Last-Modified.
4. HTTP Client: A shared `reqwest::Client` with connection pooling (`rustls-tls`, TCP keepalive 60s) is reused across workers.

### 2. Application of Cookies, Referrer, and User-Agent
- Gathered by extension via `chrome.cookies.getAll({ url })` and `navigator.userAgent`.
- Delivered to backend and stored in `AdaptiveDownloadTask`.
- Applied in [`crates/edm-core/src/adaptive/worker.rs#L178-L188`](file:///C:/Users/Suvesh/Desktop/projects/EDM/crates/edm-core/src/adaptive/worker.rs#L178-L188) on every request:
  - `Cookie: <cookie_string>`
  - `Referer: <referrer>`
  - `User-Agent: <user_agent>`
- Forwarded recursively during work-stealing splits in [`crates/edm-core/src/adaptive/scheduler.rs#L129-L131`](file:///C:/Users/Suvesh/Desktop/projects/EDM/crates/edm-core/src/adaptive/scheduler.rs#L129-L131).

### 3. Filename Resolution Logic
- **Priority**:
  1. Valid non-generic filename provided by browser extension.
  2. RFC 5987 `filename*=` in `Content-Disposition`.
  3. Standard `filename=` in `Content-Disposition`.
  4. Decoded URL path segments.
  5. Extension inferred from `Content-Type` header.
  6. Safe fallback `download`.
- All candidate filenames are sanitized for Windows (`Sanitizer::sanitize_filename`) and duplicates resolved (`Sanitizer::resolve_duplicate`).

### 4. Progress and Speed Calculation
- Workers emit `AdaptiveWorkerEvent::BytesDownloaded { idx, bytes }`.
- Engine sums `total_downloaded`.
- Controller updates instantaneous speed (`instant_bps = bytes / dt`) and rolling Exponential Moving Average (EMA: `rolling_bps = 0.7 * rolling_bps + 0.3 * instant_bps`).
- Desktop telemetry ticker queries active tasks and updates SQLite and WebSocket clients.

### 5. Pause, Resume, and Cancel
- **Pause**: Sets `cancelled` flag (`AtomicBool`) on task. Active worker connections abort chunk loops. File state written as `Paused` in SQLite with `size_done`.
- **Resume**: Re-reads task from SQLite. `probe.rs` checks if server supports byte ranges. If resumable, splits `(total - size_done)` across connections using existing sparse file on disk.
- **Cancel**: Sets cancelled flag, updates SQLite state to `Cancelled`, and frees worker memory.

### 6. Error & Retry Handling
- **HTTP 403 Forbidden**: Immediately terminates worker with `AdaptiveWorkerEvent::Failed`, displaying explicit authentication failure in UI.
- **HTTP 429 Too Many Requests**: Reads `Retry-After` header and scales down connections via AIMD backoff.
- **Worker Timeouts**: Monitored via `stall_timeout` (default 5000ms). Workers that stop receiving chunks are restarted with exponential jitter backoff up to `max_worker_retries`.
- **Disk Full**: Checked during file creation; fails writer initialization with clear OS error.

---

## 6. Browser Extension

### 1. Manifest (`extension/manifest.chromium.json`)
```json
{
  "manifest_version": 3,
  "name": "EDM — Edge Download Manager",
  "version": "0.0.1",
  "description": "High-performance live download dashboard and acceleration integration for EDM",
  "key": "<REDACTED_PUBLIC_KEY>",
  "permissions": [
    "downloads",
    "cookies",
    "webRequest",
    "contextMenus",
    "storage",
    "notifications",
    "nativeMessaging",
    "tabs",
    "activeTab"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "options_ui": {
    "page": "options.html",
    "open_in_tab": false
  },
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_title": "EDM Live Dashboard",
    "default_icon": { "16": "logo.png", "32": "logo.png", "48": "logo.png", "128": "logo.png" }
  },
  "icons": { "16": "logo.png", "32": "logo.png", "48": "logo.png", "128": "logo.png" }
}
```
- **Extension ID**: `ginpdimhcdbojbhemgjedghkeolbcmgj`

### 2. Download Interception Engine
- **Event**: `chrome.downloads.onDeterminingFilename(item, suggest)`.
- **Interception Flow**:
  1. Returns `true` for asynchronous resolution.
  2. Checks user toggle `edm_interception_enabled` and `bypassNextDownload` (Shift/Alt shortcut). If bypassed, calls `suggest()` with no arguments immediately.
  3. Skips non-http(s) downloads.
  4. Gathers URL, basename filename, MIME, cookies, and User-Agent.
  5. Dispatches `create_task` over WebSocket with 3000ms timeout.
  6. **When EDM is running and accepts (`ack.ok`)**: Invokes `chrome.downloads.cancel(item.id)` then `chrome.downloads.erase({ id: item.id })` and calls `safeSuggest()`. The browser never shows a "Save As" dialog or download shelf item.
  7. **When EDM is NOT running, offline, or times out**: Calls `safeSuggest()` with no parameters. The browser downloads the file normally through Chrome's standard downloader.

### 3. Connection & Keep-Alive Handling
- Maintains persistent WebSocket connection to `ws://127.0.0.1:14370`.
- Sends `{"type":"ping"}` keep-alive every 20 seconds to prevent Manifest V3 Service Worker idle termination.
- Auto-reconnects every 2000ms on disconnection.
- Connects to open popup instances via long-lived `chrome.runtime.Port` named `"popup"`.

### 4. Extension Code
The full background worker script ([`extension/src/background.ts`](file:///C:/Users/Suvesh/Desktop/projects/EDM/extension/src/background.ts)) and popup script ([`extension/src/popup.ts`](file:///C:/Users/Suvesh/Desktop/projects/EDM/extension/src/popup.ts)) are tracked in the repository and compiled with `esbuild` into `extension/background.js` and `extension/popup.js`.

---

## 7. Build and Configuration

### Root `Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = [
    "crates/edm-core",
    "crates/edm-store",
    "crates/edm-ipc",
    "crates/edm-nmh",
    "crates/edm-cli",
    "crates/edm-testsrv",
    "apps/desktop/src-tauri",
]

[workspace.package]
version = "0.0.1"
edition = "2021"
authors = ["Suvesh"]
license = "MIT OR Apache-2.0"

[workspace.dependencies]
tokio = { version = "1.43", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "2.0"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
rusqlite = { version = "0.33", features = ["bundled"] }
uuid = { version = "1.11", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
futures-util = "0.3"
async-trait = "0.1"
sha2 = "0.10"
md-5 = "0.10"
sha1 = "0.10"
hex = "0.4"
url = { version = "2.5", features = ["serde"] }
bytes = "1.9"
proptest = "1.6"
clap = { version = "4.5", features = ["derive"] }
axum = "0.8"
tower-http = { version = "0.6", features = ["trace", "cors"] }
```

### Desktop UI `apps/desktop/package.json`:
```json
{
  "name": "edm-desktop",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "clsx": "^2.1.1",
    "lucide-react": "^1.16.0",
    "motion": "^12.4.7",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^3.0.2",
    "zustand": "^5.0.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.9",
    "@types/node": "^22.13.5",
    "@types/react": "^19.0.10",
    "@types/react-dom": "^19.0.4",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.9",
    "typescript": "^5.7.3",
    "vite": "^6.2.0"
  }
}
```

### Packaging & Installer Setup
- **GitHub Actions CI/CD** ([`.github/workflows/ci.yml`](file:///C:/Users/Suvesh/Desktop/projects/EDM/.github/workflows/ci.yml)):
  - Executes `npx @tauri-apps/cli build` on Windows runners.
  - Generates NSIS installer: `target/release/bundle/nsis/EDM_*_x64-setup.exe`.
  - Packages extension into `edm-extension.tar.gz`.

---

## 8. Real System & Environment Check (Exact Output)

### 1. Toolchain Versions:
- `rustc 1.99.1 (58cf8f9c3 2026-10-13)`
- `cargo 1.99.1 (5f94df478 2026-08-27)`
- `node v24.16.0`

### 2. `cargo build --release`:
```text
Finished `release` profile [optimized] target(s) in 29.89s
warning: linker stderr: .../ld.exe: .rsrc merge failure: multiple non-default manifests
warning: `edm-desktop-app` (bin "edm-desktop-app") generated 1 warning
```
- Status: Exit code 0 (Success). 1 benign MinGW manifest linker warning.

### 3. `cargo clippy --workspace --all-targets`:
```text
Finished `dev` profile [unoptimized + debuginfo] target(s) in 8.91s
```
- Status: Exit code 0. Zero warnings, zero errors.

### 4. `cargo test --workspace`:
```text
test planner::tests::test_basic_planner ... ok
test media::tests::test_drm_detection ... ok
test media::tests::test_hls_master_parse ... ok
test packs::tests::test_hls_m3u8_parser ... ok
test packs::tests::test_github_pack_routing ... ok
test packs::tests::test_http_chunk_ranges ... ok
test packs::tests::test_ftp_url_and_pasv ... ok
test packs::tests::test_huggingface_pack_routing ... ok
test packs::tests::test_ed2k_link_and_md4 ... ok
test sanitizer::tests::test_sanitizer_edge_cases ... ok
test packs::tests::test_bittorrent_magnet_and_bencode ... ok
test planner::tests::test_planner_properties ... ok
test limiter::tests::test_token_bucket_limit ... ok
test benchmark_baseline_vs_adaptive ... ok
test test_ntfs_allocation_benchmark ... ok
test test_cancellation_and_persistence ... ok
test test_adaptive_controller_decisions ... ok
test test_single_stream_fallback_norange ... ok
test test_bandwidth_limiter ... ok
test test_adaptive_download_full_integrity ... ok
test ws_server::tests::test_open_file_refused_for_incomplete_tasks ... ok
test ws_server::tests::test_bad_origin_rejected ... ok
test ws_server::tests::test_bad_token_rejected ... ok
test ws_server::tests::test_snapshot_received_after_subscribe ... ok
test ws_server::tests::test_create_task_ack ... ok
test ws_server::tests::test_unknown_task_id_ignored ... ok
test tests::test_state_transitions ... ok
test tests::test_store_creation_and_migration ... ok
test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### 5. Frontend Check (`npm run build` in `apps/desktop`):
```text
✓ 2361 modules transformed.
dist/index.html                   0.54 kB
dist/assets/index-CwhpF0WW.css   54.49 kB
dist/assets/core-BUhCcD2K.js      2.70 kB
dist/assets/window-BPQH9sz4.js   15.56 kB
dist/assets/index-D39h21zT.js   516.86 kB
✓ built in 3.62s
```
- Status: Exit code 0 (Success). TypeScript check passed.

### 6. Running Process & Port Audit:
- **Active Processes**:
  - `edm-desktop-app.exe` (PID `14428`, `C:\Users\Suvesh\AppData\Local\EDM\edm-desktop-app.exe`)
  - `msedgewebview2.exe` (PIDs `3524`, `5864`, `8512`, `11808`, `13740`, `14208`, `15000`, `15060`, `15688`, `16652`, `20548`, `21352`)
- **Listening Ports owned by PID `14428`**:
  - `127.0.0.1:14370` (Listen) — WebSocket & HTTP Token service
  - `127.0.0.1:8998` (Listen) — Axum HTTP extension bridge

---

## 9. Known Problems, Code Risks & Fragilities

1. **Infinite Tokio Keep-Alive Thread**:
   - [`apps/desktop/src-tauri/src/main.rs#L1436-L1443`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L1436-L1443):
     ```rust
     std::thread::spawn(move || {
         rt.block_on(async {
             loop {
                 tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
             }
         });
     });
     ```
     *Risk*: This thread never terminates on window close. Because Tokio runtime workers and background tasks are permanently kept alive in memory, closing the window leaves `edm-desktop-app.exe` running as a headless zombie process.
2. **Single-Instance Mutex Does Not Focus Existing Window**:
   - [`apps/desktop/src-tauri/src/main.rs#L1176-L1199`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L1176-L1199):
     If a headless zombie process is running and the user launches the application from desktop or start menu, the second instance calls `process::exit(0)` silently without restoring, unhiding, or focusing the existing window. The user sees nothing open.
3. **Hardcoded Fallback Mock Speed**:
   - [`apps/desktop/src-tauri/src/main.rs#L490-L492`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L490-L492), [`#L538-L540`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L538-L540), [`#L608-L610`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L608-L610):
     ```rust
     if current_speed == 0 {
         current_speed = 3_500_000;
     }
     ```
     *Risk*: If an active download legitimately reports 0 B/s (e.g. stalled connection or connecting), the Axum status response fabricates a mock speed of 3.5 MB/s (`3_500_000`).
4. **Hardcoded Fallback Path in Source Code**:
   - [`apps/desktop/src-tauri/src/main.rs#L65`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L65):
     Contains hardcoded development machine path: `C:\Users\Suvesh\Desktop\projects\EDM\target\release\edm-nmh.exe`.
5. **No Structured Panic Hook or File Logger**:
   - Panics on background worker threads are printed to stderr and lost in release mode (`windows_subsystem = "windows"` hides the console).

---

## 10. Root Cause Analysis for Current User Issues

### Issue 1: No Tray Icon Visible
- **Root Cause**:
  In Tauri v2, tray icons require explicit configuration either in `tauri.conf.json` under `app.trayIcon` or programmatically via `tauri::tray::TrayIconBuilder`. Neither exists anywhere in `main.rs` or `tauri.conf.json`. No tray icon is ever registered with the Windows Shell Notification Area.

### Issue 2: Closed or Killed App Keeps Running in Background, Window Won't Open
- **Root Cause**:
  1. [`apps/desktop/src-tauri/src/main.rs#L1437`](file:///C:/Users/Suvesh/Desktop/projects/EDM/apps/desktop/src-tauri/src/main.rs#L1437) spawns an unmonitored background thread that runs `rt.block_on(async { loop { sleep(3600).await; } })`. When the user closes the window (`window.close()`), the process does not exit because background threads and socket listeners (:14370, :8998) remain active.
  2. When the user attempts to reopen the application, `enforce_single_instance()` in `main.rs:1194` discovers the mutex `Global\EDM_SingleInstance_Mutex_14370` held by the background process and calls `std::process::exit(0)` immediately. The new window is destroyed and the existing headless process never creates a new window.

### Issue 3: After End Task and Relaunch, Window Shows "localhost refused to connect"
- **Root Cause**:
  If the application was launched using debug mode (`cargo tauri dev`) or built with `"devUrl": "http://localhost:1420"` instead of pointing to static files, WebView2 attempts to load `http://localhost:1420`. If the Vite dev server is not running on port 1420, WebView2 displays Edge error code `ERR_CONNECTION_REFUSED` ("localhost refused to connect").

### Issue 4: Browser Save-As Dialog Appears While EDM Also Downloads the File
- **Root Cause**:
  Previously, download interception was attached to `chrome.downloads.onCreated`. In Chromium, `onCreated` fires after the browser initiates filename determination and dialog prompt queues; if the browser has "Ask where to save each file before downloading" enabled, Chrome pops the dialog before `cancel` executes.
  *(Note: Migrating to `chrome.downloads.onDeterminingFilename(item, suggest)` with `cancel` + `erase` + `safeSuggest()` suppresses this behavior)*.

### Issue 5: Garbled Filename and 0 B/s on Some Google Links
- **Root Cause**:
  1. **Garbled Filename**: Google Drive / Google Docs export URLs (e.g. `docs.google.com/uc?export=download...`) do not contain the target file name in the URL path. If the filename is extracted solely from the URL path before `Content-Disposition: attachment; filename="document.pdf"` is received from the final redirect, the filename defaults to URL fragments like `uc` or `download`.
  2. **0 B/s Speed Meter Freeze**: In [`crates/edm-core/src/adaptive/controller.rs`](file:///C:/Users/Suvesh/Desktop/projects/EDM/crates/edm-core/src/adaptive/controller.rs), single-stream downloads (servers returning HTTP 200 without `Accept-Ranges`) previously triggered an early return before updating `rolling_throughput_bps`. Because the rolling throughput was never calculated for single streams, the speed calculation remained permanently at `0.0`.
