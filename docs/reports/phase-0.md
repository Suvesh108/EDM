# Phase 0 Report — Scaffold and Decisions

## Summary
Phase 0 successfully establishes the complete multi-crate Cargo workspace, the React 19 + TypeScript + Tailwind CSS v4 desktop application with Tauri 2, the Manifest V3 browser extension for Chromium and Firefox, initial ADRs, and the CI workflow.

---

## What Was Built
1. **Cargo Workspace (`Cargo.toml`)**:
   - `crates/edm-core`: Core parallel download engine (Probe, Planner, Worker, Writer).
   - `crates/edm-store`: SQLite storage layer with WAL mode and schema migrations.
   - `crates/edm-ipc`: Shared protocol definitions for native messaging, named pipe, and state transitions.
   - `crates/edm-nmh`: Stdin/stdout native messaging host binary.
   - `crates/edm-cli`: Headless CLI for download and probe operations.
   - `crates/edm-testsrv`: Chaos test server for deterministic seeded files and network simulation.
   - `apps/desktop/src-tauri`: Desktop shell bridging frontend to the Rust core.
2. **Desktop UI (`apps/desktop`)**:
   - React 19 + TypeScript + Vite.
   - Tailwind CSS v4 design tokens for Midnight Edge dark (`#090C12`) & Daylight light (`#F4F7FB`) modes.
   - Anti-slop 1px alpha borders, inner specular highlights, and tabular numeric typography.
   - 120-cell segmented file map visualizer and inspector drawer.
3. **Browser Extension (`extension/`)**:
   - Manifest V3 architecture with background service worker and Alt+Click bypass.
   - Dual-build script generating `extension/dist/chromium` and `extension/dist/firefox`.
4. **CI & Documentation**:
   - GitHub Actions workflow (`.github/workflows/ci.yml`).
   - 5 Architecture Decision Records in `docs/decisions/`.
   - Dependency licenses recorded in `docs/licenses.md`.

---

## "Done When" Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `cargo build --workspace` and `cargo test --workspace` pass | **PASS** | `cargo test --workspace` passed 4 test suites (unit tests + proptest property tests across dynamic segment sizes). |
| 2 | `npm run build` for the UI passes; dev window shows themed placeholder | **PASS** | Vite built production assets in 1.91s (`dist/index.html`, `dist/assets/`). |
| 3 | Extension builds to `extension/dist/chromium` and `extension/dist/firefox` | **PASS** | Verified output directories with manifests and bundled scripts. |
| 4 | CI workflow file exists and is valid | **PASS** | Validated `.github/workflows/ci.yml` with Rust and Node pipelines. |
| 5 | At least 5 ADRs exist; README setup works from scratch | **PASS** | ADRs 0001–0005 written in `docs/decisions/`; README updated with complete steps. |

---

## Decisions Made
- [ADR 0001: Core Language and Runtime (Rust + Tokio)](../decisions/0001-language-and-runtime.md)
- [ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment](../decisions/0002-http1-per-segment.md)
- [ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL)](../decisions/0003-sqlite-wal-store.md)
- [ADR 0004: Local Named Pipe IPC Architecture](../decisions/0004-named-pipe-ipc.md)
- [ADR 0005: Fail-Open Browser Extension Interception](../decisions/0005-fail-open-extension.md)

---

## What the Next Phase (Phase 1) Needs
- Implementation of dynamic work-stealing algorithm in `edm-core` when connections become idle.
- Chaos integration test suite running against `edm-testsrv` simulating rate-limiting (429), flaky connections, and hard crash recovery.
- NTFS sparse vs plain pre-allocation benchmark recorded in `docs/decisions/0006-file-allocation.md`.
