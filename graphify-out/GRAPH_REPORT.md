# Graph Report - EDM  (2026-10-25)

## Corpus Check
- 69 files · ~205,926 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 2, .css 2, .icns 1)

## Summary
- 713 nodes · 1209 edges · 52 communities (45 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9a368f9e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- 7. UI/UX design system
- 1. Paste-ready prompts (short on purpose; the detail lives in this file)
- PopupController
- DownloadState
- worker.rs
- edm-nmh/src/main.rs
- 12. Phases, tasks and "Done when" checklists
- TokenBucketLimiter
- ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL)
- writer.rs
- chaos_integration.rs
- tauri.conf.json
- compilerOptions
- desktop/package.json
- ADR 0006: NTFS Sparse File Allocation for Pre-Allocated Segments
- build.js
- extension/package.json
- 🚀 Quickstart & Commands
- AccelerationMode
- adaptive/engine.rs
- WorkScheduler
- edm-core/src/lib.rs
- default.json
- edm-ipc
- Phase 1 Plan — Download Engine (Headless)
- AdaptiveWorker
- 5. Architecture
- background.ts
- content.ts
- edm-testsrv
- src-tauri/src/main.rs
- EDM — Edge Download Manager
- desktop/package.json
- DownloadState
- ADR 0004: Local Named Pipe IPC Architecture
- ADR 0005: Fail-Open Browser Extension Interception
- Phase 0 Report — Scaffold and Decisions
- ADR 0001: Core Language and Runtime (Rust + Tokio)
- ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment
- ADR 0007: Adaptive Download Acceleration Engine
- 14. Appendices
- EDM Dependency Licenses
- 3. Technology decisions (with reasons)
- 9. Testing and verification
- WorkerEvent
- edm-ipc/src/lib.rs
- ExtensionMessage
- AppReply
- SegmentState

## God Nodes (most connected - your core abstractions)
1. `Store` - 26 edges
2. `PopupController` - 24 edges
3. `ExtensionMessage` - 22 edges
4. `DownloadState` - 21 edges
5. `FileWriter` - 18 edges
6. `AdaptiveWorker` - 17 edges
7. `TokenBucketLimiter` - 17 edges
8. `EDM — Edge Download Manager` - 17 edges
9. `compilerOptions` - 16 edges
10. `StoreError` - 16 edges

## Surprising Connections (you probably didn't know these)
- `ActiveTaskHandle` --references--> `AdaptiveTelemetry`  [EXTRACTED]
  apps/desktop/src-tauri/src/main.rs → crates/edm-core/src/adaptive/types.rs
- `AppState` --references--> `AdaptiveEngine`  [EXTRACTED]
  apps/desktop/src-tauri/src/main.rs → crates/edm-core/src/adaptive/engine.rs
- `AppState` --references--> `Store`  [EXTRACTED]
  apps/desktop/src-tauri/src/main.rs → crates/edm-store/src/lib.rs
- `edm-desktop-app` --depends_on--> `edm-core`  [EXTRACTED]
  apps/desktop/src-tauri/Cargo.toml → crates/edm-core/Cargo.toml
- `edm-desktop-app` --depends_on--> `edm-ipc`  [EXTRACTED]
  apps/desktop/src-tauri/Cargo.toml → crates/edm-ipc/Cargo.toml

## Import Cycles
- None detected.

## Communities (52 total, 7 thin omitted)

### Community 0 - "7. UI/UX design system"
Cohesion: 0.18
Nodes (11): 7.10 Brand and icon direction, 7.1 Design principles, 7.2 Color tokens, 7.3 Typography, 7.4 Spacing, shape, depth, motion, 7.5 Layout wireframes, 7.6 Screens to build, 7.7 Component inventory (+3 more)

### Community 1 - "1. Paste-ready prompts (short on purpose; the detail lives in this file)"
Cohesion: 0.17
Nodes (12): 1.0 Kickoff (paste first), 1.10 Review prompt (use after each phase), 1.1 Phase 0 — Scaffold and decisions, 1.2 Phase 1 — Download engine (headless, no UI), 1.3 Phase 2 — Queue, scheduler, limits, file handling, 1.4 Phase 3 — Desktop app and design system, 1.5 Phase 4 — Browser integration, 1.6 Phase 5 — Video/media grabber (+4 more)

### Community 2 - "PopupController"
Cohesion: 0.16
Nodes (9): DownloadItem, escapeHtml(), formatBytes(), formatEta(), formatSpeed(), PopupController, sanitizeUrl(), SniffedImage (+1 more)

### Community 3 - "DownloadState"
Cohesion: 0.11
Nodes (8): Engine, DownloadRecord, SegmentRecord, Store, StoreError, NotFound, Sqlite, test_store_creation_and_migration()

### Community 5 - "edm-nmh/src/main.rs"
Cohesion: 0.15
Nodes (7): get_db_path(), handle_message(), main(), open_store(), read_message(), write_reply(), Json

### Community 6 - "12. Phases, tasks and "Done when" checklists"
Cohesion: 0.22
Nodes (9): 12. Phases, tasks and "Done when" checklists, Phase 0 — Scaffold and decisions, Phase 1 — Download engine (headless), Phase 2 — Queue, scheduler core, limits, file handling, Phase 3 — Desktop app and design system, Phase 4 — Browser integration, Phase 5 — Video/media grabber, Phase 6 — Polish and release (+1 more)

### Community 7 - "TokenBucketLimiter"
Cohesion: 0.22
Nodes (3): BucketState, test_token_bucket_limit(), TokenBucketLimiter

### Community 8 - "ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL)"
Cohesion: 0.33
Nodes (5): ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL), Context, Decision, Invariant, Status

### Community 9 - "writer.rs"
Cohesion: 0.24
Nodes (4): FileWriter, WriterError, AlreadyExists, Io

### Community 10 - "chaos_integration.rs"
Cohesion: 0.05
Nodes (21): Cli, Commands, Download, Probe, AdaptiveDownloadTask, AdaptiveEngine, benchmark_baseline_vs_adaptive(), handle_bench_file() (+13 more)

### Community 11 - "tauri.conf.json"
Cohesion: 0.11
Nodes (17): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+9 more)

### Community 12 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+9 more)

### Community 13 - "desktop/package.json"
Cohesion: 0.13
Nodes (30): App(), DownloadItem, formatBytes(), formatEta(), formatSpeed(), generateSpeedSvgPath(), WorkerInfo, languageOptions (+22 more)

### Community 14 - "ADR 0006: NTFS Sparse File Allocation for Pre-Allocated Segments"
Cohesion: 0.17
Nodes (10): ADR 0006: NTFS Sparse File Allocation for Pre-Allocated Segments, Consequences, Context, Decision, Status, Decisions Made, "Done When" Checklist, Phase 1 Report — Download Engine (Headless) (+2 more)

### Community 15 - "build.js"
Cohesion: 0.18
Nodes (6): distChromium, distFirefox, { execSync }, fs, path, tempDir

### Community 16 - "extension/package.json"
Cohesion: 0.20
Nodes (9): description, devDependencies, typescript, typescript, name, private, scripts, build (+1 more)

### Community 17 - "🚀 Quickstart & Commands"
Cohesion: 0.20
Nodes (10): 1. Build and Test Workspace, 2. Run the Chaos Test Server, 3. Headless Download via CLI, 4. Build Desktop UI, 5. Build Browser Extension, 📂 Architecture Decision Records (ADRs), EDM — Edge Download Manager, 📄 License (+2 more)

### Community 18 - "AccelerationMode"
Cohesion: 0.09
Nodes (22): AdaptiveController, AccelerationMode, Auto, FallbackSingleStream, Limited, Optimizing, Stable, AdaptiveConfig (+14 more)

### Community 20 - "WorkScheduler"
Cohesion: 0.17
Nodes (7): WorkScheduler, AdaptiveWorkerEvent, Done, Failed, Progress, RateLimited, Stalled

### Community 21 - "edm-core/src/lib.rs"
Cohesion: 0.07
Nodes (16): MediaGrabber, StreamVariant, test_drm_detection(), test_hls_master_parse(), Planner, .DEFAULT_MIN_SEGMENT_SIZE, SegmentPlan, test_basic_planner() (+8 more)

### Community 22 - "default.json"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 23 - "edm-ipc"
Cohesion: 0.80
Nodes (6): edm-cli, edm-core, edm-desktop-app, edm-ipc, edm-nmh, edm-store

### Community 24 - "Phase 1 Plan — Download Engine (Headless)"
Cohesion: 0.40
Nodes (4): Objective, Phase 1 Plan — Download Engine (Headless), Risks & Mitigations, Steps to Execute

### Community 26 - "5. Architecture"
Cohesion: 0.14
Nodes (14): 5.10 UI ↔ engine API (Tauri commands and events), 5.11 Browser integration protocol (extension ⇄ host ⇄ app), 5.12 Media grabber design (Phase 5), 5.13 Security checklist for the whole app, 5.1 Big picture, 5.2 Components, 5.3 Repository layout, 5.4 Engine internals (+6 more)

### Community 28 - "background.ts"
Cohesion: 0.33
Nodes (6): cachedStatus, ConnectionState, notifiedCompletedIds, notifiedFailedIds, probeConnection(), sendHostMessage()

### Community 29 - "content.ts"
Cohesion: 0.40
Nodes (5): SniffedImage, SniffedResource, sniffImages(), sniffResources(), add()

### Community 31 - "src-tauri/src/main.rs"
Cohesion: 0.27
Nodes (10): ActiveTaskHandle, AppState, get_download_telemetry(), get_settings(), get_stats(), pause_download(), probe_url(), save_settings() (+2 more)

### Community 32 - "EDM — Edge Download Manager"
Cohesion: 0.18
Nodes (10): 0. How to use this file (read first, 2 minutes), 10. Packaging and release, 11. Operating rules for the agent (apply to every phase), 13. "Verify before use" list (the agent must check current documentation or test), 2. Project brief, 4. How a download manager really works (plain language), 6. Feature list and priority, 8. Browser extension design (+2 more)

### Community 33 - "desktop/package.json"
Cohesion: 0.05
Nodes (38): dependencies, clsx, lucide-react, motion, react, react-dom, tailwind-merge, @tauri-apps/api (+30 more)

### Community 35 - "DownloadState"
Cohesion: 0.14
Nodes (12): DownloadState, Cancelled, Completed, Created, Downloading, Failed, LinkExpired, NeedsAttention (+4 more)

### Community 36 - "ADR 0004: Local Named Pipe IPC Architecture"
Cohesion: 0.33
Nodes (5): ADR 0004: Local Named Pipe IPC Architecture, Consequences, Context, Decision, Status

### Community 37 - "ADR 0005: Fail-Open Browser Extension Interception"
Cohesion: 0.33
Nodes (5): ADR 0005: Fail-Open Browser Extension Interception, Consequences, Context, Decision, Status

### Community 38 - "Phase 0 Report — Scaffold and Decisions"
Cohesion: 0.33
Nodes (6): Decisions Made, "Done When" Checklist, Phase 0 Report — Scaffold and Decisions, Summary, What the Next Phase (Phase 1) Needs, What Was Built

### Community 39 - "ADR 0001: Core Language and Runtime (Rust + Tokio)"
Cohesion: 0.40
Nodes (5): ADR 0001: Core Language and Runtime (Rust + Tokio), Consequences, Context, Decision, Status

### Community 40 - "ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment"
Cohesion: 0.40
Nodes (5): ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment, Consequences, Context, Decision, Status

### Community 41 - "ADR 0007: Adaptive Download Acceleration Engine"
Cohesion: 0.40
Nodes (4): ADR 0007: Adaptive Download Acceleration Engine, Context, Decision, Status

### Community 42 - "14. Appendices"
Cohesion: 0.40
Nodes (5): 14. Appendices, A. First-time setup on Windows (for you, Suvesh), B. Glossary, C. Naming and branding notes, D. Reference architecture

### Community 43 - "EDM Dependency Licenses"
Cohesion: 0.40
Nodes (4): Bundled Tools & Sidecars, EDM Dependency Licenses, Frontend UI Dependencies, Rust Workspace Dependencies

### Community 45 - "3. Technology decisions (with reasons)"
Cohesion: 0.50
Nodes (4): 3.1 Core language: **Rust**, 3.2 Why Rust and not Go (honest comparison), 3.3 Things to remember about Tauri, 3. Technology decisions (with reasons)

### Community 46 - "9. Testing and verification"
Cohesion: 0.50
Nodes (4): 9.1 The local test server (`edm-testsrv`), 9.2 Test types, 9.3 Benchmarks (`docs/benchmarks.md`), 9. Testing and verification

### Community 47 - "WorkerEvent"
Cohesion: 0.29
Nodes (4): WorkerEvent, Done, Failed, Progress

### Community 50 - "edm-ipc/src/lib.rs"
Cohesion: 0.27
Nodes (5): Cookie, DEFAULT_PIPE_NAME, DownloadOverview, MediaVariant, PROTOCOL_VERSION

### Community 51 - "ExtensionMessage"
Cohesion: 0.12
Nodes (16): ExtensionMessage, AddDownload, AddMany, CancelDownload, GetDownload, GetStatus, Hello, ListDownloads (+8 more)

### Community 53 - "AppReply"
Cohesion: 0.20
Nodes (10): AppReply, Accepted, Declined, DownloadDetail, DownloadList, Error, Pong, Settings (+2 more)

### Community 54 - "SegmentState"
Cohesion: 0.40
Nodes (5): SegmentState, Done, Downloading, Failed, Pending

## Knowledge Gaps
- **82 isolated node(s):** `clsx`, `motion`, `tailwind-merge`, `zustand`, `@types/node` (+77 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 346 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DownloadState` connect `DownloadState` to `DownloadState`, `edm-ipc/src/lib.rs`, `adaptive/engine.rs`, `edm-nmh/src/main.rs`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **What connects `clsx`, `motion`, `tailwind-merge` to the rest of the system?**
  _82 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `DownloadState` be split into smaller, more focused modules?**
  _Cohesion score 0.10634920634920635 - nodes in this community are weakly interconnected._
- **Why does `Store` connect `DownloadState` to `chaos_integration.rs`, `adaptive/engine.rs`, `edm-nmh/src/main.rs`, `src-tauri/src/main.rs`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Should `chaos_integration.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.0502283105022831 - nodes in this community are weakly interconnected._
- **Why does `ExtensionMessage` connect `ExtensionMessage` to `edm-ipc/src/lib.rs`, `edm-nmh/src/main.rs`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Should `tauri.conf.json` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._