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
  <a href="https://github.com/Suvesh108/EDM/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078d4?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/rust-1.85+-orange?style=flat-square&logo=rust" alt="Rust" />
</p>

---

## ⚡ Features

- 🚀 **Multi-Connection Turbo Engine**: Dedicated HTTP/1.1 TCP sockets with dynamic work-stealing, sub-range probing, pipelined disk writer, and adaptive segment balancing to maximize your bandwidth.
- 📦 **In-Process Built-in Feature Packs (No External Programs)**:
  - **YouTube & Video**: Pure Rust in-process YouTube & Vimeo stream extractors with direct format resolution (zero yt-dlp binary dependency).
  - **BitTorrent**: Native in-process BitTorrent engine via `librqbit` (DHT, PEX, magnet URI resolution, chunked peer streaming, and seed tracking).
  - **HLS / M3U8 & Native Remuxing**: Stream parser, multi-segment downloader, pure Rust AES-128-CBC PKCS7 decryption, and native transmuxing into MP4/MKV without external FFmpeg.
  - **GitHub Pack**: Direct GitHub Release artifact routing and raw repository archive downloads.
  - **HuggingFace Pack**: Model shard stream routing with parallel checkpoint acquisition.
  - **FTP & ED2K**: FTP/FTPS active/passive retrieval and eDonkey2000 MD4 link hashing.
  - **Process Isolation**: Remaining external tool launches run with Windows Job Objects (`KILL_ON_JOB_CLOSE`) and `CREATE_NO_WINDOW` (zero console window popups).
- 🔄 **In-App Over-the-Air (OTA) Updates**:
  - Live GitHub Releases API checking against semantic versioning.
  - One-click background OTA download with real-time byte progress bar.
  - Automatic detached installer launch and graceful application restart.
- 🧩 **Seamless Browser Extension (MV3)**:
  - Intercepts browser downloads seamlessly with `onDeterminingFilename`, forwarding cookies, referrer, and user-agent.
  - **Auto Token Discovery**: Automatically detects and connects to the desktop app token with zero manual copy-pasting.
  - **Fail-Open Architecture**: If EDM is closed or unreachable, downloads resume in the browser automatically so you never miss a file.
  - **Single-Click Bypass**: Hold `Shift` or `Alt` when clicking any link to bypass EDM and download directly in the browser.
- 🔒 **Local WebSocket Pairing (`127.0.0.1:14370`)**:
  - Secure bidirectional IPC over local loopback with 64-character cryptographically generated authentication tokens.
  - Strict loopback `Host` header enforcement defending against DNS rebinding.
  - Origin verification strictly pinned to the verified extension ID.
  - Single-instance enforcement via `tauri-plugin-single-instance`.
- ⚙️ **Windows Autostart & System Tray**:
  - Optional Windows autostart on boot with silent `--autostart` tray launch.
  - Full system tray controls (Open, Pause All, Resume All, Settings, Quit).
- 🛡️ **Defensive Security & Safety**:
  - Client sends only task IDs; the app resolves filesystem paths internally.
  - Direct execution protection: Potentially hazardous executables (`.exe`, `.bat`, `.cmd`, `.ps1`, `.scr`, `.vbs`) are never executed directly; EDM reveals them safely in Windows Explorer.
- 💾 **Crash-Safe Persistence & Real Telemetry**:
  - Dedicated background writer thread with batched positional writes and periodic flush.
  - Monotonic atomic delta counters for genuine throughput without synthetic spikes or jitter.
  - Resume any interrupted or paused download with byte-level precision using SQLite WAL checkpoints.
- 🎨 **Linear/Stripe-Grade Interface**:
  - Frameless Windows desktop app with customized titlebar, subtle lighting, and system tray integration.
  - Fluid spring motion and tactile feedback.
  - Real-time download stream visualizer and speed meter.

---

## 📥 Quick Download

Get the latest binaries from the [**Releases Page**](https://github.com/Suvesh108/EDM/releases/latest):

| File | Description |
| :--- | :--- |
| **[`EDM_0.0.3_x64-setup.exe`](https://github.com/Suvesh108/EDM/releases/download/v0.0.3/EDM_0.0.3_x64-setup.exe)** | Official Standalone Windows Installer setup program (64-bit, v0.0.3). |
| **[`edm-extension.tar.gz`](https://github.com/Suvesh108/EDM/releases/download/v0.0.3/edm-extension.tar.gz)** | Chromium browser extension for Chrome, Edge, Brave, and Opera. |

---

## 🚀 Getting Started

### 1. Launch the Desktop App
Install and run **EDM**. On first launch, EDM generates a secure pairing token, registers system tray controls, and starts the local server on `127.0.0.1:14370`.

### 2. Install the Browser Extension
1. Download and extract `edm-extension.tar.gz` (or use `extension/dist/chromium`).
2. Open your Chromium browser (Chrome, Edge, Brave, etc.) and navigate to `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the extracted extension folder.

### 3. Pairing
The extension will automatically connect to EDM on startup. If auto-connection is disabled:
1. In the EDM desktop app, copy your pairing token from Settings.
2. In the browser extension popup, open **Settings**, paste your token, and save.

---

## 🏗️ Building from Source

### Prerequisites
- **Rust**: Stable toolchain via [rustup.rs](https://rustup.rs).
- **Node.js**: `v22+` LTS and `npm`.
- **PowerShell** (on Windows).

### One-Command Production Build
Run the unified release build script:
```powershell
.\scripts\build-release.ps1
```
This script automatically:
1. Builds the desktop frontend with Vite.
2. Builds and packages the browser extension.
3. Compiles `edm-nmh`.
4. Copies and bundles `WebView2Loader.dll`.
5. Compiles and packages the NSIS installer into `target/release/bundle/nsis/EDM_0.0.3_x64-setup.exe`.
6. Verifies that all assets are offline-bundled and free of any dev URLs.

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

Copyright (C) 2026 Suvesh.

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License (GPL-3.0)** as published by the Free Software Foundation, version 3 of the License.

See the [LICENSE](LICENSE) file for the full license text.
