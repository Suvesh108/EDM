# EDM Version 0.0.3 Integration & True State Report

**Generated**: 2026-10-28  
**Release Target**: Windows MSVC / x86_64  
**Licensing Invariant**: GPL-3.0-only compatible  

---

## 1. Requirement & Component Matrix

| Subsystem / Requirement | Status | Evidence (File & Line / Command) | Verification Notes |
| :--- | :---: | :--- | :--- |
| **Extension Link** | **IMPLEMENTED** | `ws_server.rs:20`, `ws_server.rs:706` | WebSocket on `127.0.0.1:14370`. Strict token handshake, Origin whitelist, Host enforcement. Task manipulation & `open_file` restricted strictly to completed tasks. |
| **Native Messaging & Local HTTP** | **IMPLEMENTED** | `main.rs:801-870`, `crates/edm-nmh/src/main.rs` | Port 8998 loopback server hardened with origin/host guards and request deduplication. Chrome/Edge/Brave manifests configured. |
| **Lifecycle & Single Instance** | **IMPLEMENTED** | `main.rs:1466-1486` | Single instance via `tauri-plugin-single-instance`. Second launch brings window forward; `--autostart` suppresses window focus to run quietly in tray. Real quit cleans up within 3s. |
| **Windowless Processes & Job Object** | **IMPLEMENTED** | `crates/edm-core/src/packs/process.rs:15` | External programs use `CREATE_NO_WINDOW` (`0x08000000`) and are bound to Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. |
| **Autostart** | **IMPLEMENTED** | `src-tauri/Cargo.toml:45`, `main.rs:1483` | `tauri-plugin-autostart` configured. Boots silently to tray on `--autostart`. Per-user HKCU registry Run key. |
| **In-Process Feature Packs** | **IMPLEMENTED** | `crates/edm-core/src/packs/` | HTTP, GitHub, Hugging Face, FTP, M3U8, BitTorrent, Extractors are 100% in-process Rust code. No external `.exe` console popups. |
| **BitTorrent Engine** | **IMPLEMENTED** | `crates/edm-core/src/packs/bittorrent.rs` | Powered by embedded `librqbit v9.0.1` (Apache-2.0, GPL-3 compatible). Wire protocol, DHT, PEX, magnet URIs, and live swarm telemetry active. |
| **Native HLS & Decryption** | **IMPLEMENTED** | `crates/edm-core/src/packs/remux.rs` | Native AES-128-CBC decryption via pure-Rust `aes` + `cbc`. Native ISO BMFF / TS remuxing without calling external FFmpeg. |
| **Native Video Extractors** | **IMPLEMENTED** | `crates/edm-core/src/packs/extractors/` | Native YouTube InnerTube Android API & Vimeo extractor in Rust. Unsupported sites return honest error message. |
| **Real Telemetry & Metrics** | **IMPLEMENTED** | `crates/edm-core/src/adaptive/scheduler.rs:206` | Atomic per-worker speed counters and real byte deltas. Eliminated fake 122.1 KB/s upload and synthetic jitter formulas. |
| **Smooth UI & Status Layout** | **IMPLEMENTED** | `apps/desktop/src/components/SpeedChartInteractive.tsx` | Fixed-height charts, tabular numerals (`tabular-nums`), and non-drifting layout containers. |
| **Pipelined Disk Writer** | **IMPLEMENTED** | `crates/edm-core/src/adaptive/pipeline_writer.rs` | Workers push chunks to bounded channels; dedicated OS thread handles positional batch writes. Periodic timed flush prevents blocking downloads. |
| **Clean Build & Test Suite** | **IMPLEMENTED** | `cargo test --workspace` | All 32 workspace unit/integration tests passing. `cargo clippy -D warnings` passing with zero warnings. |

---

## 2. Reconciled Overlaps

1. **Process Management**:
   - Consolidated all external process executions under [`crates/edm-core/src/packs/process.rs`](file:///crates/edm-core/src/packs/process.rs) with `spawn_hidden` and Windows Job Object cleanup.
2. **Autostart vs Single Instance**:
   - Reconciled `--autostart` in `main.rs`: background launches stay quietly in tray with hidden main window, while secondary user launches unminimize and focus the primary instance.
3. **Telemetry & Speed Smoothing**:
   - Removed dual-smoothing layers. Fixed telemetry reporting to use genuine rolling byte counters per worker sampled at 4 Hz. Removed all hardcoded synthetic upload baselines.
4. **M3U8 & Remuxing**:
   - Replaced external FFmpeg transmuxing with in-process `NativeRemuxer`.

---

## 3. Automated Test Results
- **`cargo test --workspace`**:
  - `edm-core`: 14 passed (including `test_native_hls_aes128_decryption`, `test_http_chunk_ranges`, `test_bittorrent_magnet_and_bencode`).
  - `benchmark_adaptive`: 1 passed.
  - `benchmark_allocation`: 1 passed.
  - `chaos_integration`: 6 passed (`test_single_stream_rolling_throughput_speed_calculation`, `test_adaptive_download_full_integrity`, etc.).
  - `edm-desktop-app`: 8 passed (WebSocket security, token endpoint, path traversal rejection, file open authorization).
  - `edm-ipc`: 1 passed.
  - `edm-store`: 1 passed (forward schema migration & store initialization).
- **`cargo clippy --workspace --all-targets -- -D warnings`**:
  - 0 warnings across all targets.
- **Frontend Build (`npm run build`)**:
  - `tsc -b && vite build`: Succeeded in 7.08s with zero TypeScript diagnostics.

---

## 4. Manual Verification Checklist (For User)
- [ ] **Windows Reboot / Autostart**: Enable "Start EDM when Windows starts" in settings, reboot, and confirm EDM starts quietly in the system tray without opening a window or showing console popups.
- [ ] **Tray & Single Instance**: Launch EDM while already running in tray; verify that the main window surfaces and gains focus.
- [ ] **YouTube Download Telemetry**: Download a video and verify that worker speeds fluctuate individually based on real TCP throughput, without fixed `152.6 KB/s` duplicates.
- [ ] **BitTorrent Swarm**: Download a magnet link or `.torrent` file and verify that real peer counts and piece progress populate the telemetry table.

---

## 5. Final Release Verdict
**GO**: All architectural requirements, security hardening, windowless Job Object protections, in-process feature packs, and real telemetry pipelines are fully unified, compiling, and verified.
