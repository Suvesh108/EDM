<p align="center">
  <img src="./assets/logo.png" alt="EDM Logo" width="120" height="120" />
</p>

<h1 align="center">EDM — Edge Download Manager</h1>

<p align="center">
  <strong>Hyper-fast, multi-connection, privacy-first download manager for Windows.</strong><br />
  Built from scratch in Rust, Tokio, Tauri 2, React 19, and Chromium Manifest V3.
</p>

<p align="center">
  <a href="https://github.com/Suvesh108/EDM/releases/latest"><img src="https://img.shields.io/github/v/release/Suvesh108/EDM?color=00f2fe&style=flat-square" alt="Release" /></a>
  <a href="https://github.com/Suvesh108/EDM/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Suvesh108/EDM/ci.yml?branch=main&style=flat-square" alt="CI Status" /></a>
  <a href="https://github.com/Suvesh108/EDM/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT%20%7C%20Apache--2.0-blue?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078d4?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/rust-1.85+-orange?style=flat-square&logo=rust" alt="Rust" />
</p>

---

## ✨ Features

- ⚡ **Multi-Connection Turbo Engine**: Dedicated HTTP/1.1 TCP sockets with dynamic work-stealing, sub-range probing, and adaptive segment balancing to maximize your bandwidth.
- 🧩 **Built-in Feature Packs**:
  - **YouTube & Media**: Integrated `yt-dlp` stream extractor for direct video and audio downloads.
  - **BitTorrent**: Native magnet URI resolution and `.torrent` bencode parser with chunked peer streaming.
  - **HLS / M3U8**: Stream parser and segment downloader with automatic sequence ordering.
  - **FFmpeg Engine**: Media transmuxing and segment concatenation pipeline.
  - **GitHub Pack**: Direct GitHub Release artifact routing and raw repository archive downloads.
  - **HuggingFace Pack**: Model shard stream routing with parallel checkpoint acquisition.
  - **FTP & ED2K**: FTP/FTPS active/passive retrieval and eDonkey2000 MD4 link hashing.
- 🔌 **Seamless Browser Extension (MV3)**:
  - Intercepts browser downloads instantly with complete cookie, referrer, and user-agent forwarding.
  - **Fail-Open Architecture**: If EDM is closed or unreachable, downloads resume in the browser within 3 seconds so you never miss a file.
  - **Single-Click Bypass**: Hold `Shift` or `Alt` when clicking any link to bypass EDM and download directly in the browser.
- 🔒 **Local WebSocket Pairing (`127.0.0.1:14370`)**:
  - Secure bidirectional IPC over local loopback with 32+ character cryptographically generated authentication tokens.
  - Origin verification strictly pinned to the verified extension ID.
  - Single-instance enforcement via Windows named mutex.
- 🛡️ **Defensive Security & Safety**:
  - Client sends only task IDs; the app resolves filesystem paths internally.
  - Direct execution protection: Potentially hazardous executables (`.exe`, `.bat`, `.cmd`, `.ps1`, `.scr`, `.vbs`) are never executed directly; EDM reveals them safely in Windows Explorer.
- 💾 **Crash-Safe Persistence**:
  - Positioned `.edmpart` disk pre-allocation flushed before SQLite Write-Ahead Logging (WAL) state checkpoints.
  - Resume any interrupted or paused download at byte precision.
- 🎨 **Linear/Stripe-Grade Interface**:
  - Frameless Windows desktop app with customized titlebar, subtle lighting, and responsive controls.
  - Emil Kowalski-inspired fluid spring motion and tactile feedback.
  - Segmented 120-cell real-time file map displaying active download streams.

---

## 📥 Quick Download

Get the latest binaries from the [**Releases Page**](https://github.com/Suvesh108/EDM/releases/tag/v0.0.1):

| File | Description |
| :--- | :--- |
| **[`EDM-v0.0.1-setup.exe`](https://github.com/Suvesh108/EDM/releases/download/v0.0.1/EDM-v0.0.1-setup.exe)** | Official Standalone Windows Installer setup program. |
| **[`edm-extension.tar.gz`](https://github.com/Suvesh108/EDM/releases/download/v0.0.1/edm-extension.tar.gz)** | Chromium browser extension for Chrome, Edge, Brave, and Opera. |

---

## 🚀 Getting Started

### 1. Launch the Desktop App
Download and run `edm-desktop-app.exe`. On first launch, EDM generates a secure pairing token and starts the local server on `127.0.0.1:14370`.

### 2. Install the Browser Extension
1. Download and extract `edm-extension.tar.gz` (or clone the repository and navigate to `extension/dist/chromium`).
2. Open your Chromium browser (Chrome, Edge, Brave, etc.) and go to `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the extracted extension folder.

### 3. Pair Extension with EDM
1. In the EDM desktop app, go to **Settings** (`⚙️`) in the footer and click **Copy Token**.
2. Click the EDM extension icon in your browser, open **Options** (or right-click the extension icon -> *Options*).
3. Paste the token into the **Authentication Token** field and click **Save & Test Connection**.
4. The status indicator will switch to **Connected**. Your browser is now linked to EDM!

---

## 🏗️ Architecture & Workspace Layout

```
EDM/
├── apps/
│   └── desktop/               # Tauri 2 frontend & desktop host
│       ├── src/               # React 19 UI, Tailwind CSS, motion design
│       └── src-tauri/         # Rust Tauri backend & local WebSocket server
├── crates/
│   ├── edm-core/              # Core download engine, adaptive work-stealing, feature packs
│   ├── edm-store/             # SQLite WAL persistence for task metadata
│   ├── edm-ipc/               # Shared type schemas and state transition logic
│   ├── edm-nmh/               # Native Messaging Host (optional standard I/O bridge)
│   ├── edm-cli/               # CLI download and diagnostic utility
│   └── edm-testsrv/           # Local chaos HTTP/Range test server
└── extension/                 # Manifest V3 browser extension
    ├── src/                   # TypeScript background worker, popup, options, content script
    └── dist/                  # Built unpacked extension artifacts
```

---

## 🛠️ Building from Source

### Prerequisites
- **Rust**: Stable toolchain (`1.85+`) via [rustup.rs](https://rustup.rs).
- **Node.js**: `v22+` LTS and `npm`.
- **Windows C++ Build Tools**: Visual Studio Build Tools (C++ Desktop Development workload).

### Step 1: Clone Repository
```powershell
git clone https://github.com/Suvesh108/EDM.git
cd EDM
```

### Step 2: Build the Extension
```powershell
cd extension
npm install
npm run build
cd ..
```

### Step 3: Build the Desktop UI
```powershell
cd apps/desktop
npm install
npm run build
cd ../..
```

### Step 4: Run Tests & Build Release Binaries
```powershell
# Verify code formatting and linting
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings

# Execute full test suite (27 integration & unit tests)
cargo test --workspace

# Build standalone release executable
cargo build --release -p edm-desktop-app
```
The compiled executable will be located at:
`target/release/edm-desktop-app.exe`

---

## 🧪 Testing with Chaos Server

EDM includes a built-in chaos HTTP server (`edm-testsrv`) to simulate network faults, dropped connections, throttling, and non-range endpoints:

```powershell
# Start the test server on port 8899
cargo run -p edm-testsrv -- --port 8899

# Download a test file with 8 concurrent connections
cargo run -p edm-cli -- download http://127.0.0.1:8899/file/10485760 --connections 8
```

---

## 📄 License

EDM is open-source software dual-licensed under the [MIT License](LICENSE) or [Apache 2.0](LICENSE-APACHE).
