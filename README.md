<div align="center">
  <img src="frontend/public/assets/logo-og.png" alt="VortexDownloader Logo" width="100%" />
  
  <br />
  <br />

  <h1>VortexDownloader</h1>
  
  <p>
    <strong>Professional high-bitrate media extraction utility. Download videos from YouTube, Vimeo, TikTok, Soundcloud, and more with multi-threaded parallel speeds, lossless audio-video merging, and zero ads.</strong>
  </p>

  <p>
    <a href="#features">Features</a> • 
    <a href="#android-app">Android APK</a> • 
    <a href="#installation">Installation</a> • 
    <a href="#tech-stack">Tech Stack</a> • 
    <a href="#architecture">Architecture</a>
  </p>
</div>

<hr />

## 💻 Windows Desktop & 📱 Android (v0.6.9)

VortexDownloader is an ultra-fast, universal downloading engine rewritten entirely in **Python + HTMX** with dynamic multi-pipe streaming, intelligent work-stealing, category auto-sorting, Windows registry protocol/extension integration, real-time IDM/FDM progress telemetry, and Aria2 JSON-RPC 2.0 extension compatibility!

- **Download Windows Executable (v0.6.9)**: [**VortexDownloader.exe**](release/VortexDownloader.exe) *(Portable standalone binary — double-click to launch)*
- **Download APK (v0.6.9)**: [**VortexDownloader-v0.6.9.apk**](release/VortexDownloader-v0.6.9.apk)
- **Version**: `0.6.9` (Release v0.6.9)
- **What's New in v0.6.9**:
  - 🖥️ **Windows Standalone Portable Executable**: Built `release/VortexDownloader.exe` with bundled templates, assets, and auto-browser launcher (`http://localhost:5001`).
  - 🐍 **Complete Python + HTMX Engine Rewrite**: Fast, responsive dashboard with zero build overhead, real-time polling updates, and persistent SQLite WAL database.
  - ⚙️ **Comprehensive Settings & Automation Suite**:
    - Pre-allocated threads (1–64) and Auto Speed Boost thread monitor.
    - 8 Automatic Category Sorting Rules (Video, Audio, Images, Subtitles, Documents, Archives, Programs, Other).
    - Windows Registry Integrations (`vortex://` protocol, `.torrent`, `.magnet`, `.ed2k`, `ftp://`, `.m3u8` / `.mpd` associations).
    - Aria2 JSON-RPC 2.0 browser extension pairing with custom token support.
  - 🚀 **Ghost Downloader 3 Core Architecture Parity**: Full architectural parity with Ghost Downloader 3 feature packs (HTTP, BitTorrent, YouTube, M3U8, GitHub, HuggingFace, ED2k, FTP, FFmpeg).
  - 🧩 **Enhanced HuggingFace & GitHub Packs**: Added support for single-segment model repo IDs (e.g. `bert-base-uncased`), datasets, spaces, direct blob resolvers, and GitHub release asset CDN routing with mirror acceleration.
  - ⚡ **Race-Condition-Free Work-Stealing Downloader**: Fixed chunk boundary overlap and byte re-downloading in multi-pipe segmented downloader.
  - 🔌 **Upgraded Hybrid Go Gateway & Aria2 JSON-RPC**: Reverse proxy routes in Go gateway (`:5001`) to Python sidecar (`:5002`) for all packs, accounts, plugins, and exporters with native execution of `aria2.addUri`, `aria2.tellStatus`, and `aria2.tellActive`.
  - 🐳 **Production Docker Multi-Stage Engine**: Standalone multi-stage Python 3.11 container bundling built React frontend assets and static-ffmpeg.
  - 📱 **Mobile & Extension Integration**: Updated Manifest V3 Chromium extension and Android Capacitor build with zero-latency backend discovery.
  - 🛡️ **Defensive Error Handling & Invariant Verification**: Stabilized Real-Debrid token management, plugin resolutions, and batch exporters across both Go Core and Python backends.
  - ⚡ **Dynamic Work-Stealing Multi-Connection Engine**: Idle threads dynamically slice un-downloaded byte ranges in half from slower workers, eliminating tail latency on slow connections.
  - 💤 **OS Sleep Prevention (Keepalive)**: Automatically inhibits Windows (`SetThreadExecutionState`) and macOS sleep while downloads are running.
  - 🧲 **Live BitTorrent Tracker Scraping**: Automatically fetches and injects the latest high-speed public trackers from GitHub (`ngosang/trackerslist`).
  - 🚀 **GitHub Release Turbo Mirrors**: Integrated CDN mirror routing (`ghproxy.net`, `mirror.ghproxy.com`, etc.) for high-speed release downloads.
  - 📺 **HLS / M3U8 Adaptive Streaming Inspector**: Master & media playlist parsing with multi-bitrate variant extraction and AES-128 key detection.
  - 🔌 **Aria2 JSON-RPC 2.0 Protocol Emulator**: Native `/jsonrpc` endpoint supporting `aria2.addUri`, `aria2.tellStatus`, and `aria2.tellActive`.
  - 🧩 **Official Chromium Browser Extension (Manifest V3)**: Media sniffer, floating action capture widget, context menus, and one-tap send to Vortex.
  - 📁 **Filename Conflict Resolution**: Configurable collision policy (`overwrite`, `rename`/`keep_both`).
  - 🚀 **Zero-RAM Native Downloader (`VortexNativePlugin`)**: Slices out JavaScript Base64 buffering and streams downloads directly to disk, completely eliminating Out-Of-Memory crashes on 100MB–1GB+ files.
  - 📁 **Public Storage & MediaStore Auto-Indexing**: Saves directly to `Download/VortexDownloader` so downloaded videos, songs, and files immediately appear in the user's Gallery, VLC, and File Manager.
  - 🎬 **One-Tap Play / Open & Share**: Added direct "Play / Open" and "Share" buttons to completed tasks in the dashboard.
  - 🌐 **Inbuilt Private Browser Enhancements**: Browser no longer abruptly closes upon queueing a download; added full-screen HTML5 video playback and mixed-content support.
  - 🔙 **Android Hardware Back-Button Support**: Intelligently closes active modals (`AddTaskModal`, `SettingsModal`, `Vault`) on back press before minimizing the app.
  - 📲 **Android "Share to Vortex" Target**: Send video links directly from YouTube, Chrome, TikTok, and Twitter via the Android Share sheet.
  - 🌐 **Cleartext HTTP Support**: Added `usesCleartextTraffic="true"` and network state permissions for local Wi-Fi backend streaming and HTTP CDN mirrors.
  - 🧹 **UI Path Sanitization**: Removed desktop-hardcoded Windows paths and added a dedicated Backend URL setting in Engine settings for mobile LAN connectivity.
  - 🎯 **100% Mathematically Accurate Progress Bar**: Completely eliminated the 95% progress jump bug caused by indeterminate CDN content-length headers. Added automated HTTP `Range: bytes=0-1` byte-probe size discovery, fallback format size estimation, and real downloaded payload tracking with exact percentage & ETA.
  - 🐍 **Pure Python Backend Architecture**: Full migration of the backend engine to high-concurrency FastAPI/Uvicorn, removing all TypeScript backend bottlenecks.
  - 🎬 **Zero-Jitter Universal Media Engine**: 100% compliant H.264 video + standard 192k AAC audio with `+faststart` metadata for stutter-free playback across Windows Media Player, Movies & TV, and default Android gallery players.
  - ⚡ **16-Pipe Multi-Segmented Turbo Downloader**: Parallel HTTP byte-range slicing with real-time speed & ETA telemetry.
  - 📦 **All 9 Feature Packs Verified**: Complete support for HttpPack, FFmpegPack, BitTorrentPack, ED2kPack, FtpPack, GitHubPack, HuggingFacePack, M3U8Pack, and YouTubePack.
  - 📥 **Seamless Inbuilt Browser Task Ingestion**: Top-bar **"⚡ Add"** button, floating **"⚡ Add to Vortex"** FAB, long-press link sniffer, and direct wire-up into `AddTaskModal` with automatic pack detection and URL parsing.
  - 📱 **Android-Specific Update UI**: Clean Android update experience with live streaming progress and automatic APK install prompts.
  - 🌐 **Native Sandboxed Inbuilt Browser**: Isolated private browsing sandbox with zero personal Google/Gmail account leakage.
  - 🌐 **16-Host Universal Media Engine**: Dedicated scrapers, API resolvers, and stream decoders for:
    - 📦 **TeraBox** (terabox.com, teraboxapp.com, 1024tera.com, 4funbox, nephobox, etc.)
    - 💿 **DiskWala** (diskwala.com, diskwla.in)
    - 🦤 **DoodStream** (doodstream.com, dood.to, dood.so, dood.ws, dood.sh, etc.)
    - 📼 **Streamtape** (streamtape.com, streamtape.net, streamta.pe, tapecontent.net, strtape.cloud)
    - 🌙 **FileMoon** (filemoon.sx, filemoon.to, filemoon.in, filemoon.link)
    - 🛡️ **VidBunker** (vidbunker.com, vidbunker.to)
    - 💾 **ByteDisk** (bytedisk.com, bytebox)
    - 🌠 **StreamWish** (streamwish.to, swhls.com, wishfast.top, wishembed.pro)
    - 👁️ **Vidhide** (vidhide.com, vidhidepro.com, vidhideplus.com, vidhide.org)
    - 🦁 **FileLions** (filelions.com, filelions.to, filelions.site, filelions.online)
    - 💧 **MixDrop** (mixdrop.co, mixdrop.to, mixdrop.sx, mixdrop.bz, mixdrop.ch)
    - ⚡ **StreamHG** (streamhg.com)
    - 🛡️ **VidGuard** (vidguard.to, vgembed.com, vidguard.net)
    - 🌊 **Upstream** (upstream.to, upstreamcdn.co)
    - 🎭 **VOE** (voe.sx, voe-network.net, voeunblk.com)
    - 📺 **StreamSB** (streamsb.net, sbchill.com, sbfull.com, sbfast.com, sbembed.com)
  - 🔓 **Packed JS Deobfuscator Engine (`unpackJs`)**: Automatically unrolls Dean Edwards' packed javascript `eval(function(p,a,c,k,e,d)...)` blocks across hosting sites.
  - 📂 **Full In-App Suite**: PIN/Biometric Secret Vault, Web Browser with 1-Tap Sniffer, and Background MediaSession Controls.

### Building Android APK Locally
```bash
# Generate launcher icons from logo
npm run generate:icons

# Build web distribution and sync Capacitor
npm run build:apk

# Compile with Gradle
cd android && ./gradlew assembleRelease
```
The signed APK will be generated at `android/app/build/outputs/apk/release/app-release.apk`.

## ⚡ Features

- **Universal Support**: Powered by `yt-dlp`, supports extraction from over 1000+ media platforms (YouTube, Twitter, TikTok, Vimeo, Soundcloud).
- **High-Bitrate & 4K Ready**: Automatically buffers the highest available video and audio bitrates.
- **Lossless Multiplexing**: Uses `FFmpeg` to cleanly stitch and merge disparate audio and video tracks without loss of quality.
- **Multi-threaded Engine**: Parallel fetch threads ensure maximum bandwidth saturation for faster downloads.
- **Zero Ads, Zero Telemetry**: Clean, sandboxed extraction without referral bloat or trackers.
- **Sleek React Dashboard**: Modern glassmorphic interface, dark mode, terminal logs, and history caching.

## 🚀 Installation & Setup (Unified Pure Python + HTMX Engine)

VortexDownloader is now 100% written in **Python + HTMX**, eliminating Node/Vite build friction and Go proxy bottlenecks while preserving the authentic dark desktop dashboard!

### Prerequisites
- [Python 3.10+](https://www.python.org/)

### 1. Install Dependencies
```bash
pip install -r backend/requirements.txt
```

### 2. Run Vortex Downloader
Launch the entire system (FastAPI backend + HTMX frontend + Aria2 JSON-RPC 2.0):
```bash
python run.py
```
- **Web Dashboard**: `http://localhost:5001`
- **Aria2 JSON-RPC 2.0**: `http://localhost:5001/jsonrpc` (Secret token: `vortex-rpc-token-2026`)

## 🌐 Cloud Deployment

### Option 1: Render (Full-Stack All-in-One — Recommended)
Render runs the Docker container with the Node backend, Python 3, and FFmpeg:
1. Connect your GitHub repository to [Render](https://render.com/).
2. Create a new **Web Service** and choose **Docker** runtime (or apply Blueprint via `render.yaml`).
3. Set the Health Check Path to `/api/health`.
4. Deploy! Your app will be live with full video extraction and stitching capabilities.

### Option 2: Split Deployment (Vercel Frontend + Render Backend)
- **Frontend (Vercel)**:
  1. Import the repository into [Vercel](https://vercel.com/).
  2. Set the Environment Variable: `VITE_API_URL=https://your-backend-service.onrender.com`
  3. Deploy!
- **Backend (Render)**:
  1. Deploy as a Docker Web Service on Render using the included `Dockerfile`.

## 🏗️ Tech Stack

- **Frontend**: React 19, Vite, Tailwind CSS v4, Framer Motion, Lucide Icons.
- **Backend**: Express (Node.js), TypeScript (`tsx`).
- **Extraction Engine**: Python, `yt-dlp` (Stream Extraction), `static-ffmpeg` (Multiplexing).

## 🧠 Architecture Overview

VortexDownloader uses a unique split-tier architecture:
1. **The React Client** provides an aesthetic UI for pasting links and tracking progress visually. It proxies requests via `/api` to the backend.
2. **The Express Server** acts as the command dispatcher, securely handling inbound URLs.
3. **The Python Core (`downloader.py`)** runs as an isolated subprocess. It queries metadata, selects formats, downloads parts concurrently, and instructs `FFmpeg` to stitch the final outputs into the `temp_downloads` cache before delivering them back to the user's browser.

## 📝 License
© 2026 VortexDownloader. Open-source utility. All rights reserved.
