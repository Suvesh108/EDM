<p align="center">
  <img src="./assets/logo.png" alt="EDM Logo" width="128" height="128" />
</p>

# EDM — Edge Download Manager

A modern, fast, private download manager built from scratch with Rust, Tauri 2, React 19, and Manifest V3.

- **Zero telemetry, zero ads, zero accounts.**
- **Segmented downloads with dynamic work stealing** (HTTP/1.1 dedicated TCP sockets).
- **Crash-safe persistence**: Positioned `.edmpart` disk writes flushed before SQLite WAL checkpoints.
- **Fail-open browser extension**: Cancels browser download only after explicit handoff confirmation.
- **Linear/Stripe-grade aesthetic**: Midnight Edge dark & Daylight light themes with tabular numbers and 120-cell segmented file map.

---

## 🛠️ Prerequisites for Windows 10/11
1. **Rust**: Install via [rustup.rs](https://rustup.rs) (stable toolchain).
2. **Node.js**: Install Node.js LTS (v22+).
3. **WebView2 Runtime**: Included by default in Windows 10/11.
4. **C++ Build Tools**: Visual Studio Build Tools (C++ workload).

---

## 🚀 Quickstart & Commands

### 1. Build and Test Workspace
```powershell
# Check formatting and clippy
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings

# Run all unit and property tests
cargo test --workspace
```

### 2. Run the Chaos Test Server
```powershell
# Launches local test server on http://127.0.0.1:8899
cargo run -p edm-testsrv -- --port 8899
```

### 3. Headless Download via CLI
```powershell
# Probe an endpoint
cargo run -p edm-cli -- probe http://127.0.0.1:8899/file/10485760

# Download with 8 connections
cargo run -p edm-cli -- download http://127.0.0.1:8899/file/10485760 --connections 8
```

### 4. Build Desktop UI
```powershell
cd apps/desktop
npm install
npm run build
```

### 5. Build Browser Extension
```powershell
cd extension
node build.js
# Generates unpacked extensions at extension/dist/chromium and extension/dist/firefox
```

---

## 📂 Architecture Decision Records (ADRs)
- [ADR 0001: Core Language and Runtime (Rust + Tokio)](docs/decisions/0001-language-and-runtime.md)
- [ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment](docs/decisions/0002-http1-per-segment.md)
- [ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL)](docs/decisions/0003-sqlite-wal-store.md)
- [ADR 0004: Local Named Pipe IPC Architecture](docs/decisions/0004-named-pipe-ipc.md)
- [ADR 0005: Fail-Open Browser Extension Interception](docs/decisions/0005-fail-open-extension.md)

---

## 📄 License
Permissively licensed under MIT OR Apache-2.0. See [docs/licenses.md](docs/licenses.md).
