# EDM — Edge Download Manager
## Master Build Spec + Paste-Ready Prompts for Antigravity

**Version:** 1.0  **Owner:** Suvesh  **Primary target:** Windows 10/11 (x64) first, macOS/Linux later
**Core stack:** Rust engine + Tauri 2 desktop shell + React/TypeScript UI + Manifest V3 browser extension

---

## 0. How to use this file (read first, 2 minutes)

1. Make a new empty folder called `edm/`. Save this file as `edm/docs/EDM_SPEC.md`.
2. Open the `edm/` folder in Antigravity.
3. Paste the prompts from **Section 1** one at a time, in order. Never paste two phases together.
4. After each phase the agent writes a short report in `docs/reports/`. Open the phase's **"Done when"** checklist in Section 12. If every item passes, commit and move to the next prompt.
5. If something fails, use the **Fix prompt** (1.9). If you want a second opinion, use the **Review prompt** (1.10).

You do not need to understand Rust to run this. Sections 3 to 5 explain every decision in plain language so you can follow what the agent is building and why.

---

## 1. Paste-ready prompts (short on purpose; the detail lives in this file)

### 1.0 Kickoff (paste first)
```
Read docs/EDM_SPEC.md completely. Do not write code yet.
Reply with: (1) a 10-line summary of EDM in your own words, (2) the 5 riskiest parts of this build, (3) any ambiguity or contradiction you found in the spec.
Then wait for my next instruction.
```

### 1.1 Phase 0 — Scaffold and decisions
```
Do Phase 0 from docs/EDM_SPEC.md (Section 12). Only Phase 0.
Follow the Operating Rules in Section 11.
When done, write docs/reports/phase-0.md and stop.
```

### 1.2 Phase 1 — Download engine (headless, no UI)
```
Do Phase 1 from docs/EDM_SPEC.md (Section 12). Only Phase 1.
Engine design is in Section 5. Test server design is in Section 9.
Do not touch the UI or the extension. Write docs/reports/phase-1.md when done and stop.
```

### 1.3 Phase 2 — Queue, scheduler, limits, file handling
```
Do Phase 2 from docs/EDM_SPEC.md (Section 12). Only Phase 2.
Write docs/reports/phase-2.md when done and stop.
```

### 1.4 Phase 3 — Desktop app and design system
```
Do Phase 3 from docs/EDM_SPEC.md (Section 12). Only Phase 3.
The design system in Section 7 is mandatory: use the exact color tokens, fonts, spacing and screens.
Write docs/reports/phase-3.md with screenshots of every screen in dark and light mode, then stop.
```

### 1.5 Phase 4 — Browser integration
```
Do Phase 4 from docs/EDM_SPEC.md (Section 12). Only Phase 4.
Protocol is in Section 5.11, extension design in Section 8.
Write docs/reports/phase-4.md when done and stop.
```

### 1.6 Phase 5 — Video/media grabber
```
Do Phase 5 from docs/EDM_SPEC.md (Section 12). Only Phase 5.
DRM-protected streams must be refused, as described in Section 5.12.
Write docs/reports/phase-5.md when done and stop.
```

### 1.7 Phase 6 — Polish, installer, release
```
Do Phase 6 from docs/EDM_SPEC.md (Section 12). Only Phase 6.
Write docs/reports/phase-6.md when done and stop.
```

### 1.8 Phase 7 — Optional extras (only when I ask)
```
Do Phase 7 item <ITEM NAME> from docs/EDM_SPEC.md (Section 12). Only that item.
```

### 1.9 Fix prompt (use when a "Done when" item fails)
```
Phase <N>, "Done when" item <X> fails: <what you saw>.
First write a failing automated test that reproduces it. Then fix it. Then re-run the entire Phase <N> checklist and report results.
Do not start another phase.
```

### 1.10 Review prompt (use after each phase)
```
Act as a strict code reviewer for Phase <N> of EDM.
Compare the code to docs/EDM_SPEC.md. List: every deviation from the spec, every missing test, every security risk, every place a download could be lost or corrupted.
Do not fix anything. Just list findings by severity.
```

---

## 2. Project brief

**What EDM is.** A free, fast, private download manager. It takes over downloads from your browser, splits big files into pieces that download in parallel, resumes after any interruption, queues and schedules, and can grab streaming video that is not DRM-protected. It has a modern, calm, dark-first interface.

**Behavioral references** (use them to understand what users expect, never copy their code):
- **Modern download managers**: browser takeover, segmented downloads, the small "download info" popup, video grabbing.
- **Queue and category management**: clean queues and automatic directory routing.
- **Resilient transfers**: resumable task files, adaptive thread count, batch tasks, hash verification, clipboard monitoring.
- **Engine behavior**: high-throughput multi-stream TCP chunking and benchmark baseline.

> **License rule for the agent:** Do NOT copy or translate code from any of these projects. GPL code cannot be mixed into an app you want to license freely. Use them only as behavioral references. Use permissively licensed crates (MIT/Apache-2.0/BSD) and record every dependency's license in `docs/licenses.md`.

**Goals**
- G1. Never lose or corrupt a download. If anything is uncertain, fail safe.
- G2. Resume correctly after crash, power loss, network drop, app restart.
- G3. Take over browser downloads reliably, and fail open: if EDM cannot take it, the browser keeps it.
- G4. Feel instant: the window opens fast, the list stays smooth with thousands of items.
- G5. Zero telemetry, zero accounts, zero ads. Everything works offline.
- G6. A UI that looks like a 2026 product, not a 2005 utility.

**Non-goals (never build these)**
- Bypassing DRM (Widevine, PlayReady, FairPlay), paywalls, licenses or logins.
- Anything meant for piracy or for hiding from a site's terms.
- Crawling or mass scraping features.
- Cloud sync, user accounts, analytics.

**Honest expectation about speed.** Multiple connections help when a server or ISP limits each single connection. They do not help when your total bandwidth or the server is the bottleneck. EDM must measure and adapt, never promise a fixed multiplier.

---

## 3. Technology decisions (with reasons)

### 3.1 Core language: **Rust**

| Layer | Choice | Why (plain language) |
|---|---|---|
| Engine language | **Rust (stable)** | Compiles to one small native program. No runtime or garbage collector pausing downloads. Very precise control over files, threads and memory. The compiler catches whole classes of bugs (crashes, data races) before you ever run it. |
| Async runtime | **tokio** | The standard way to run hundreds of network connections at once in Rust. |
| HTTP client | **reqwest** with **rustls** (TLS) | Mature, supports proxies, cookies, redirects, streaming bodies. Segment workers use HTTP/1.1 so each segment gets its own TCP connection. |
| Database | **SQLite** via **rusqlite** (bundled, WAL mode) | One file, no server, crash-safe, perfect for download history and resume state. |
| Desktop shell | **Tauri 2** | Uses the system's web view (WebView2 on Windows) so the app is small. The Rust engine runs in the same process as the app. Your React skills apply directly to the UI. |
| UI | **React + TypeScript + Vite + Tailwind CSS + Radix UI (shadcn/ui style) + lucide-react icons + Zustand (state) + TanStack Virtual (long lists) + uPlot (speed graph)** | Fast to build, accessible by default, easy for you to read and edit. |
| Browser extension | **Manifest V3, TypeScript** | Required format for Chrome, Edge and other Chromium browsers; Firefox supports it too. |
| Native messaging host | Small Rust binary `edm-nmh` | The only supported bridge between a browser extension and a desktop app. |
| Local IPC | Windows named pipe (Unix socket on macOS/Linux) | Lets the host binary talk to the running app. Restricted to the current user. |
| Logging | `tracing` + rolling log file | Essential for debugging resume bugs. |
| Tests | `cargo test`, `proptest`, custom test server, Vitest, Playwright | See Section 9. |
| Packaging | Tauri bundler (NSIS installer) + Tauri updater | See Section 10. |

### 3.2 Why Rust and not Go (honest comparison)

| | **Rust (chosen)** | **Go (alternative)** |
|---|---|---|
| Speed to first working version | Slower. Compile errors are strict. | Faster. Simple language, concurrency is easy. |
| Final product quality | Excellent: tiny binary, low memory, no GC. | Very good. Gopeed proves Go + Flutter works for this exact kind of app. |
| Pairs with your React skills | Yes, through Tauri. | Via Wails (Go + web UI) or Flutter. |
| Risk when an AI agent writes it | Agent can get stuck in borrow-checker errors. | Fewer such loops. |
| Sharing code between engine, app, native host | One Cargo workspace, shared types. | Also easy. |

**Decision:** Rust. **Mitigation for the agent-loop risk:** write the engine in a simple actor style (tasks that own their data and talk through channels), pass owned values across boundaries, avoid exposing lifetimes in public APIs, and avoid `unsafe` unless a comment explains why. If Phase 1 proves too slow to stabilize, the fallback is Go for the engine behind the same documented API; the UI, extension and protocol would not change.

### 3.3 Things to remember about Tauri
- On Windows, the UI renders in WebView2 (Chromium-based). On macOS it is WebKit and on Linux WebKitGTK, so test the UI on each OS you ship.
- Use Tauri's capability/permission system: the UI may only call the commands listed in Section 5.10.

---

## 4. How a download manager really works (plain language)

1. **Capture.** You click a download link. The browser extension notices, grabs the link plus the browser's cookies, referrer and user-agent, and sends them to EDM. If EDM accepts, the extension cancels the browser's own copy.
2. **Probe.** EDM asks the server: how big is the file, can I ask for pieces (`Accept-Ranges`), what is it called (`Content-Disposition`), has it changed (`ETag`, `Last-Modified`), and where does the link finally redirect?
3. **Split.** If the server supports pieces, EDM divides the file into byte ranges ("segments").
4. **Download in parallel.** Each segment uses its own connection and asks the server only for its range (`Range: bytes=start-end`). A correct server answers `206 Partial Content`.
5. **Write in place.** Each piece is written directly to the right position in one pre-sized file, so nothing has to be merged at the end.
6. **Remember progress.** EDM saves how far each segment got. If the app crashes or the network dies, it resumes from those positions.
7. **Rebalance.** When a segment finishes early, EDM splits the biggest remaining segment and gives half to the idle connection. This is what keeps all connections busy to the end.
8. **Finish.** EDM checks the size (and optional checksum), renames the temporary file to its final name, marks it as downloaded from the internet (so Windows SmartScreen can protect you), and notifies you.

**Why resume sometimes fails in other apps:** the server file changed, the link expired, or the app trusted bad progress data. EDM avoids this with validators (`If-Range` + `ETag`/`Last-Modified`), flushing data to disk before saving progress, and a "link expired, refresh from browser" flow.

**How this spec was researched (and its limits).** No existing download manager binary was decompiled or taken apart for this spec. The behavior described here comes from public release notes, open-source project documentation, public extension examples, and standard HTTP behavior. Anything the agent cannot confirm by reading current documentation must be confirmed with an automated test against the local test server (Section 9) before it is relied on.

---

## 5. Architecture

### 5.1 Big picture

```
 ┌───────────────────────── BROWSER ─────────────────────────┐
 │  EDM Extension (MV3)                                      │
 │  • sees downloads  • reads cookies/referrer/UA            │
 │  • detects media   • context menu "Download with EDM"     │
 └───────────────┬───────────────────────────────────────────┘
                 │ Native Messaging (stdin/stdout, JSON)
          ┌──────▼───────┐
          │   edm-nmh    │  tiny host program, started by the browser
          └──────┬───────┘
                 │ local named pipe (current user only)
 ┌───────────────▼──────────────── EDM APP (one process) ────────────────┐
 │  Tauri shell ── tray, windows, notifications, autostart, deep links   │
 │       │ commands/events                                               │
 │  React UI  ◄────────────────────────────────────────────────┐         │
 │                                                              │         │
 │  edm-core ENGINE                                             │         │
 │   Probe → Planner → Scheduler → Workers ─► Writer ─► Disk    │         │
 │                         │          │          │              │         │
 │                      Limiter     Retry     Checkpointer      │         │
 │                         └──── Event bus (throttled) ─────────┘         │
 │  edm-store (SQLite): downloads, segments, queues, settings, logs       │
 └────────────────────────────────────────────────────────────────────────┘
                 │ HTTP/HTTPS (one TCP connection per segment)
              Internet / CDN servers
```

### 5.2 Components

| Component | Responsibility | Must NOT do |
|---|---|---|
| `edm-core` | All download logic. A library with no UI code. | Never import Tauri or any UI code. |
| `edm-store` | SQLite access, migrations, one writer task. | No business logic. |
| `edm-ipc` | Shared message types (serde) and the pipe client/server. | No download logic. |
| `edm-nmh` | Reads/writes native messaging frames, forwards to the app, starts the app if it is not running. | Never keeps secrets on disk. |
| `edm-cli` | Headless command line for the engine (add, list, pause, resume). Used for testing before the UI exists. | Not shipped to users in v1 (optional). |
| `edm-testsrv` | Local HTTP test server that misbehaves on purpose (Section 9). | Dev-only. |
| `apps/desktop` | Tauri app + React UI. Thin layer over `edm-core`. | No download logic in the UI. |
| `extension/` | MV3 extension in TypeScript. | No download logic. It only captures and hands off. |

### 5.3 Repository layout

```
edm/
├─ Cargo.toml                  (workspace)
├─ crates/
│  ├─ edm-core/                engine
│  ├─ edm-store/               SQLite layer
│  ├─ edm-ipc/                 shared types + pipe
│  ├─ edm-nmh/                 native messaging host binary
│  ├─ edm-cli/                 headless CLI
│  └─ edm-testsrv/             misbehaving test server
├─ apps/
│  └─ desktop/
│     ├─ src-tauri/            Rust side of the app
│     └─ src/                  React UI
├─ extension/                  MV3 extension (chromium + firefox builds)
├─ docs/
│  ├─ EDM_SPEC.md              this file
│  ├─ decisions/               one short ADR per decision (what, why, alternatives)
│  ├─ protocol.md              native messaging + IPC message reference
│  ├─ design-tokens.md         exported from Section 7
│  ├─ licenses.md              every dependency + license
│  └─ reports/                 phase-N.md reports
└─ scripts/                    dev, build, package helpers
```

### 5.4 Engine internals

| Part | Job |
|---|---|
| **Probe** | Sends a `HEAD`; if rejected (405/403/odd status) falls back to `GET` with `Range: bytes=0-0`. Learns total size, range support, `ETag`, `Last-Modified`, filename, content type, final URL after redirects. Sends `Accept-Encoding: identity` so byte ranges match the real file (compressed transfer breaks ranges). |
| **Planner** | Decides segment count and byte ranges (5.5). Falls back to a single non-resumable stream when ranges are unsupported or size is unknown. |
| **Scheduler** | Enforces max concurrent downloads, per-host connection caps, priorities, queue rules, start-at times. |
| **Worker** (one per segment) | Opens a connection, requests its range, reads in chunks (~256 KiB), hands chunks to the Writer, updates its position. Handles stalls and reconnects. |
| **Writer** | One task per download. Writes chunks at exact file offsets using positioned writes. Buffers and flushes in batches. |
| **Checkpointer** | Every ~2 seconds: flush file data to disk, THEN save every segment's position to SQLite. (Order matters: saved progress must never be ahead of data actually on disk.) |
| **Limiter** | Token-bucket speed limiter: one global, optional one per download. |
| **Retry** | Exponential backoff with jitter; honors `Retry-After` on 429/503. |
| **Event bus** | Collects changes and emits a batched update to the UI about 4 times per second. Never emit per network chunk. |

### 5.5 Segmentation algorithm

1. **Eligible?** Needs a known size, `206` support (or `Accept-Ranges: bytes`), and size larger than 2 × minimum segment size. Otherwise use a single stream.
2. **Initial plan:** `N = min(connections_setting, ceil(size / 1 MiB))`. Split into N equal ranges. Default connections: 8.
3. **Dynamic splitting (work stealing):** when a worker finishes and the file is not done, find the segment with the most bytes remaining. If remaining ≥ 2 × minimum segment size, split its *remaining* range in half. The idle worker takes the second half; the original worker's end boundary shrinks (its connection is told to stop at the new end).
4. **Adaptive connections ("Smart mode", optional, default on):** start with 4. Every few seconds measure total throughput. If adding a connection raised throughput by a meaningful margin and no 429/403 errors were seen, add one (up to the cap, max 32). If errors or no gain, back off. Never exceed the per-host cap. This is EDM's answer to "AI acceleration" claims in other apps: simple, measurable, and safe.
5. **Stall handling:** if a connection receives nothing for 30 seconds, drop it and reconnect from its last confirmed byte.
6. **Wrong answer handling:** if the server replies `200` to a ranged request (ignores the range) or sends a different `Content-Range` than asked, mark the server "range-unreliable", cancel segmenting, and fall back to single stream, restarting cleanly.

### 5.6 Disk writing and crash safety

- Download into a temporary file next to the destination: `name.ext.edmpart`. Never write directly to the final name.
- Pre-size the file so every segment can write at its offset. On Windows/NTFS, writing far past the current end can cause slow zero-filling. The agent must **benchmark two options in Phase 1** and record the result in `docs/decisions/`: (a) mark the file sparse before sizing it, (b) plain pre-allocation. Pick the faster one that stays correct.
- Use positioned writes (`seek_write` on Windows, `write_at` on Unix) so segment workers never fight over one shared cursor.
- Checkpoint order: write data → flush data to disk → save segment positions in SQLite. After a crash, EDM may re-download a few seconds of data but can never believe data exists that does not.
- On resume, send `If-Range` with the stored `ETag` (or `Last-Modified` if no `ETag`). If the server answers `200` instead of `206`, the file changed: ask the user whether to restart. Never silently stitch two versions together.
- On finish: verify the byte count, optionally verify the hash, then atomically rename `.edmpart` to the final name. If the final name exists, apply the duplicate policy (rename `(1)`, overwrite after confirmation, or skip).
- On Windows add the **Mark-of-the-Web** (an alternate data stream named `Zone.Identifier` with `ZoneId=3` and the referrer/host URL) to completed files, so SmartScreen and Office Protected View behave as for browser downloads.
- File names: take from `Content-Disposition` (both `filename` and RFC 5987 `filename*`), else URL path (percent-decoded). Remove illegal characters, reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…), trailing dots/spaces, and path separators. Handle long paths. Never allow a name to escape the destination folder.

### 5.7 Download state machine

| State | Meaning | Allowed next states |
|---|---|---|
| `Created` | Request accepted | `Probing` |
| `Probing` | Asking the server for facts | `Queued`, `Failed`, `NeedsAttention` |
| `Queued` | Waiting for a free slot or start time | `Downloading`, `Paused`, `Cancelled` |
| `Downloading` | At least one worker active | `Paused`, `Verifying`, `Failed`, `LinkExpired`, `Cancelled` |
| `Paused` | User paused; progress saved | `Queued`, `Cancelled` |
| `LinkExpired` | Server returned 401/403/410 mid-download | `Queued` (after link refreshed), `Cancelled` |
| `NeedsAttention` | Server file changed, disk full, path invalid, auth required | `Queued`, `Cancelled` |
| `Verifying` | Checking size/hash | `Completed`, `Failed` |
| `Completed` | Done, final file in place | (terminal; can be removed) |
| `Failed` | Retries exhausted | `Queued` (manual retry), `Cancelled` |
| `Cancelled` | User cancelled | (terminal; can be removed) |

Every transition must be written to SQLite and shown to the UI. Illegal transitions must be impossible in code (use a Rust enum and a single transition function).

### 5.8 Data model (SQLite)

**downloads**: `id` (uuid), `url`, `final_url`, `filename`, `save_dir`, `category`, `state`, `size_total` (nullable), `size_done`, `resumable`, `etag`, `last_modified`, `content_type`, `referer`, `user_agent`, `headers_json`, `connections`, `speed_limit`, `queue_id`, `priority`, `source` (`manual|browser|clipboard|cli|media`), `created_at`, `started_at`, `completed_at`, `error_code`, `error_msg`, `checksum_algo`, `checksum_expected`, `checksum_actual`.

**segments**: `download_id`, `idx`, `start`, `end`, `pos` (next byte to fetch), `state`, `retries`. Primary key (`download_id`, `idx`).

**queues**: `id`, `name`, `max_concurrent`, `schedule_json`, `post_action`.

**settings**: `key`, `value_json`.

**event_log**: `download_id`, `ts`, `level`, `message` (capped, oldest rows pruned).

**Secrets rule:** cookies and auth headers are sensitive. Keep them in memory while a download is active. If a paused download must survive an app restart, store them encrypted with the Windows DPAPI (current-user scope) and delete them when the download completes or is removed. Never write cookies to logs.

### 5.9 Default configuration

| Setting | Default | Range |
|---|---|---|
| Connections per download | 8 | 1–32 |
| Minimum segment size | 1 MiB | 256 KiB–16 MiB |
| Max simultaneous downloads | 3 | 1–10 |
| Max connections per host (all downloads) | 16 | 2–64 |
| Read chunk size | 256 KiB | fixed |
| Writer flush | every 4 MiB or 500 ms | fixed |
| Checkpoint interval | 2 s | 1–10 s |
| Connect timeout | 15 s | 5–60 s |
| Idle (stall) timeout | 30 s | 10–120 s |
| Retries per segment | 8 | 0–20 |
| Backoff | 1 s × 2ⁿ + jitter, cap 60 s | fixed |
| UI update rate | 4 Hz | fixed |
| Smart mode (adaptive connections) | On | on/off |
| Browser takeover minimum size | 1 MB, or any file type in the list below | 0–∞ |
| Clipboard monitor | **Off** (privacy) | on/off |
| Telemetry | **None** | n/a |

Default take-over file types: `7z zip rar tar gz bz2 xz iso exe msi dmg pkg deb rpm apk appimage mp4 mkv avi mov webm flv mp3 flac wav aac m4a pdf epub docx xlsx pptx`.

Default categories → folders (inside the user's Downloads folder): Video, Music, Documents, Compressed, Programs, Other.

### 5.10 UI ↔ engine API (Tauri commands and events)

**Commands the UI may call** (and nothing else):
`probe_url`, `add_downloads`, `list_downloads(filter, sort, page)`, `get_download(id)`, `pause(ids)`, `resume(ids)`, `cancel(ids)`, `retry(ids)`, `remove(ids, delete_file)`, `open_file(id)`, `open_folder(id)`, `refresh_link(id, new_url)`, `set_task_options(id, options)`, `queues_*` (list/create/update/delete), `get_settings`, `set_settings`, `get_stats`, `repair_browser_integration`, `export_history`, `import_urls_from_text`.

**Events the UI listens to:**
`downloads_changed` (batched patches, ~4 Hz), `download_added`, `download_removed`, `queue_changed`, `settings_changed`, `browser_connection_changed`, `toast` (user-facing messages), `capture_request` (a browser handoff needs the popup).

Rules: the list view receives patches, never full reloads; the UI keeps a local store keyed by download id; very large lists are virtualized.

### 5.11 Browser integration protocol (extension ⇄ host ⇄ app)

**Transport:** Chrome/Edge native messaging. Each message is a 4-byte length (native byte order) followed by UTF-8 JSON. Messages from the host to the browser are limited to 1 MB; messages to the host can be much larger. `edm-nmh` forwards messages to the app over a per-user named pipe and returns the reply. If the app is not running, `edm-nmh` launches it and retries for up to ~10 seconds.

**Message types (extension → app)**

| Type | Purpose | Key fields |
|---|---|---|
| `hello` | Handshake | `protocol`, `extensionVersion`, `browser` |
| `add_download` | Hand off one download | `url`, `finalUrl`, `referrer`, `userAgent`, `cookies[]`, `filename`, `mime`, `size`, `tabUrl`, `source` |
| `add_many` | Hand off several links | `items[]` of the above (without cookies repeated per item if same origin) |
| `media_detected` | Report a streamable video | `pageUrl`, `title`, `variants[]` (quality, URL, type) |
| `ping` | Keep-alive/status | – |

**Replies (app → extension)**

| Type | Meaning |
|---|---|
| `accepted` | EDM took the download. Extension may cancel and erase the browser's copy. |
| `declined` | EDM will not take it (rule, size, user setting). Browser continues. |
| `error` | Something failed. Browser continues. |
| `settings` | Current take-over rules (extension types list, minimum size, domains excluded). |

Example (illustrative, not final):
```json
{ "type": "add_download", "protocol": 1,
  "url": "https://example.com/file.zip", "referrer": "https://example.com/get",
  "userAgent": "Mozilla/5.0 …", "cookies": [{"name":"sid","value":"…","domain":"example.com"}],
  "filename": "file.zip", "mime": "application/zip", "size": 73400320, "source": "browser" }
```

**Golden rule:** the extension cancels the browser's own download **only after receiving `accepted`**. If anything is slow or fails, the browser download continues untouched.

**Security rules**
- Native host manifest lists exactly one allowed extension ID per browser. Use a pinned extension key during development so the ID is stable.
- The named pipe is accessible only to the current Windows user.
- Do not run a localhost HTTP server by default. Any website could try to talk to it. If a localhost API is ever added (for remote control), it must be off by default, bound to `127.0.0.1`, protected by a random token, and must check the `Origin` header.
- Validate every field from the extension as untrusted input (URL scheme must be `http`, `https` or later `ftp`; no `file:`, no `javascript:`).

### 5.12 Media grabber design (Phase 5)

- Extension observes network requests (observe-only, no blocking) for `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.mp3` etc., plus `<video>` sources found by a content script.
- When media is found, the extension shows a small floating "Download with EDM" button on the video, and a list in the extension popup.
- **Plain files** (direct MP4/WebM/MP3) → normal segmented download.
- **HLS (`.m3u8`)**: parse master playlist → offer qualities → download segments in parallel → join them (bundled FFmpeg as a separate sidecar program, license reviewed and recorded) → output MP4/MKV.
- **DASH (`.mpd`)**: same idea; video and audio tracks are downloaded separately and muxed.
- Encrypted-but-open streams (AES-128 key delivered in the playlist) may be supported.
- **DRM must be refused.** If a manifest signals Widevine, PlayReady or FairPlay (or a license-server URL), EDM shows: "This video is DRM-protected, EDM can't download it." Do not build any workaround.

### 5.13 Security checklist for the whole app
- TLS verification ON by default (a per-download "ignore certificate errors" toggle may exist but with a red warning).
- Sanitize file names and paths (5.6). Block writes outside the chosen folder.
- Warn before running or opening executable types straight from EDM ("Open" on `.exe/.msi/.bat/.ps1/.scr` shows a confirmation).
- Content-Security-Policy in the UI locked down; no remote scripts or fonts; ship fonts locally.
- Tauri commands validated with strict types; no shell execution from the UI.
- Updater uses signed update manifests only.
- Logs never contain cookies, tokens or full query strings of signed URLs (redact).
- Minimal extension permissions, each justified in `docs/protocol.md` (needed for store review).

---

## 6. Feature list and priority

| # | Feature | Priority | Phase |
|---|---|---|---|
| 1 | Segmented HTTP/HTTPS downloads with dynamic splitting | Must | 1 |
| 2 | Pause, resume, resume after crash/restart | Must | 1 |
| 3 | Retry with backoff, stall recovery, link-expired flow | Must | 1 |
| 4 | Crash-safe progress (flush-then-checkpoint) | Must | 1 |
| 5 | Correct file naming, duplicates, Windows path safety | Must | 2 |
| 6 | Queues, max concurrent, priorities | Must | 2 |
| 7 | Global and per-download speed limit | Must | 2 |
| 8 | Categories with default folders | Must | 2 |
| 9 | Checksum verify (MD5, SHA-1, SHA-256) | Should | 2 |
| 10 | Mark-of-the-Web on completed files | Must | 2 |
| 11 | Desktop UI: list, add dialog, inspector, settings, tray, dark/light | Must | 3 |
| 12 | Browser takeover (Chrome, Edge, Brave, Firefox) | Must | 4 |
| 13 | Cookies/referrer/user-agent handoff for logged-in downloads | Must | 4 |
| 14 | Right-click "Download with EDM", batch "download all links" | Should | 4/6 |
| 15 | Small capture popup with Start / Later / Cancel | Must | 4 |
| 16 | Video/media detection and floating button | Should | 5 |
| 17 | HLS/DASH download + mux (no DRM) | Should | 5 |
| 18 | Scheduler (start/stop times, post-action: sleep/shutdown/open folder) | Should | 6 |
| 19 | Proxy (HTTP, HTTPS, SOCKS5) + per-download auth | Should | 6 |
| 20 | Clipboard URL monitor (opt-in) | Should | 6 |
| 21 | Smart mode (adaptive connections) | Should | 1/6 |
| 22 | Speed graph, per-download file map | Should | 3 |
| 23 | Auto-update with signed updates | Must (before release) | 6 |
| 24 | Import/export download list, portable mode | Later | 7 |
| 25 | BitTorrent / magnet (use a vetted Rust torrent library) | Later | 7 |
| 26 | FTP / SFTP | Later | 7 |
| 27 | aria2-compatible remote control | Later | 7 |
| 28 | macOS and Linux builds | Later | 7 |

---

## 7. UI/UX design system

### 7.1 Design principles
1. **Calm and fast.** Dark-first, low visual noise, high information density where it matters (the list), generous space where it does not (dialogs).
2. **Numbers are the hero.** Speed, size, ETA use a monospaced, tabular font so digits never jitter.
3. **One accent.** Electric cyan means "active/primary". Everything else is neutral or a clear status color.
4. **Never trap the user.** Every dialog has an obvious escape; destructive actions confirm or offer undo.
5. **Progress should feel alive.** Smooth progress fills, a file map showing which parts are done, a live speed graph.
6. **Keyboard-complete.** Every action reachable without a mouse.

### 7.2 Color tokens

**Dark theme — "Midnight Edge" (default)**

| Token | Hex | Use |
|---|---|---|
| `--bg-app` | `#090C12` | Window background |
| `--bg-sidebar` | `#0D1118` | Sidebar |
| `--bg-surface` | `#121722` | Cards, rows, panels |
| `--bg-elevated` | `#181F2D` | Dialogs, popovers, menus |
| `--bg-hover` | `#1F2839` | Hover state |
| `--bg-selected` | `#16283A` | Selected row (cyan-tinted) |
| `--border-subtle` | `#1F2736` | Dividers |
| `--border-strong` | `#2D3A52` | Inputs, focused cards |
| `--text-primary` | `#E9EEF7` | Main text |
| `--text-secondary` | `#A2AEC5` | Secondary text |
| `--text-muted` | `#7A87A3` | Captions, placeholders |
| `--accent` | `#22D3EE` | Primary actions, progress |
| `--accent-hover` | `#4DDDF2` | Hover on primary |
| `--accent-pressed` | `#0FB8D4` | Pressed |
| `--accent-on` | `#03141A` | Text on accent |
| `--accent-2` | `#6366F1` | Gradient end, charts |
| `--gradient-edge` | `linear-gradient(90deg, #22D3EE, #6366F1)` | Progress fill, logo, hero accents |
| `--success` | `#34D399` | Completed |
| `--warning` | `#FBBF24` | Paused, needs attention |
| `--danger` | `#F87171` | Failed, destructive |
| `--info` | `#60A5FA` | Informational |
| `--scheduled` | `#A78BFA` | Scheduled |
| `--queued` | `#94A3B8` | Queued |
| `--focus-ring` | `#22D3EE` | 2 px ring, 2 px offset |
| `--selection` | `rgba(34,211,238,0.18)` | Text selection |

**Light theme — "Daylight"**

| Token | Hex | Use |
|---|---|---|
| `--bg-app` | `#F4F7FB` | Window background |
| `--bg-sidebar` | `#EBF0F7` | Sidebar |
| `--bg-surface` | `#FFFFFF` | Cards, rows |
| `--bg-elevated` | `#FFFFFF` | Dialogs (with shadow) |
| `--bg-hover` | `#EEF3FA` | Hover |
| `--bg-selected` | `#E0F4FA` | Selected row |
| `--border-subtle` | `#E2E8F2` | Dividers |
| `--border-strong` | `#C9D3E3` | Inputs |
| `--text-primary` | `#0E1524` | Main text |
| `--text-secondary` | `#475670` | Secondary |
| `--text-muted` | `#75829B` | Captions (large or non-essential text only) |
| `--accent` | `#0891B2` | Progress fills, icons |
| `--accent-strong` | `#0E7490` | Buttons, links (text-safe) |
| `--accent-on` | `#FFFFFF` | Text on strong accent |
| `--accent-2` | `#4F46E5` | Gradient end |
| `--success` / `--warning` / `--danger` / `--info` / `--scheduled` / `--queued` | `#059669` / `#B45309` / `#DC2626` / `#2563EB` / `#7C3AED` / `#64748B` | Status colors |

**Contrast rule:** body text must reach at least 4.5:1 and UI component boundaries at least 3:1 in both themes. Hex values above were chosen to meet this, but the agent must verify every text/background pair with a contrast checker and record the results in `docs/design-tokens.md`, fixing any that fall short.

**Theme behavior:** Follow system theme by default; manual override in Settings → Appearance. Implement every color as a CSS variable on `:root`, swapped by a `data-theme` attribute. No hard-coded colors in components.

### 7.3 Typography
- **UI font:** Inter (variable). **Numbers/URLs/hashes:** JetBrains Mono. Both are open-licensed; bundle locally (the app must work offline).
- Use `font-variant-numeric: tabular-nums` anywhere numbers change.

| Style | Size / line-height | Weight | Use |
|---|---|---|---|
| Caption | 12 / 16 | 400–500 | Meta text, chips |
| Body-sm | 13 / 18 | 400 | Rows, secondary |
| Body | 14 / 20 | 400–500 | Default |
| Subtitle | 16 / 24 | 600 | Section headers |
| Title | 20 / 28 | 600 | Dialog titles |
| Headline | 24 / 32 | 600 | Onboarding |
| Display | 32 / 40 | 700 | Empty-state hero |

### 7.4 Spacing, shape, depth, motion
- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32, 40, 48.
- **Radius:** sm 6, md 10, lg 14, xl 20, pill 999.
- **Depth, dark:** surfaces separated by 1 px borders plus a faint top highlight; shadows only on popovers (`0 12px 32px rgba(0,0,0,.5)`).
- **Depth, light:** soft shadows: sm `0 1px 2px rgba(16,24,40,.06)`, md `0 4px 12px rgba(16,24,40,.08)`, lg `0 12px 32px rgba(16,24,40,.12)`.
- **Motion:** hover 120 ms, panels 200 ms, dialogs 320 ms; easing `cubic-bezier(.2,.8,.2,1)`. Progress fills animate with `transform` (never width) and a 250 ms linear transition to match the 4 Hz updates. Honor `prefers-reduced-motion` by disabling all non-essential animation.
- **Window:** minimum 960 × 600, default 1200 × 760. Sidebar 240 px (collapsed 64). Top bar 56. Status bar 32. Inspector panel 380. Row height 72 comfortable / 48 compact.

### 7.5 Layout wireframes

**Main window**
```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [◈ EDM]   Search downloads…  Ctrl+K            [ + Add URL ]  [Pause all] [⚡ Limit] │
├──────────────┬─────────────────────────────────────────────────────────────────┤
│ All       42 │  Downloading · 3                                  ↓ 18.4 MB/s    │
│ Active     3 │ ┌─────────────────────────────────────────────────────────────┐ │
│ Queued     5 │ │ [ISO]  ubuntu-24.04-desktop-amd64.iso                  62%  │ │
│ Completed 30 │ │        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  (file map, 120 cells)  │ │
│ Failed     1 │ │        3.9 GB of 6.2 GB · 12.1 MB/s · 3 min left · 8 conn    │ │
│              │ │                                      [⏸] [📁] [⋯]           │ │
│ CATEGORIES   │ └─────────────────────────────────────────────────────────────┘ │
│  Video       │ ┌─────────────────────────────────────────────────────────────┐ │
│  Music       │ │ [MP4]  lecture-05.mp4                                  31%  │ │
│  Documents   │ │ …                                                           │ │
│  Compressed  │ └─────────────────────────────────────────────────────────────┘ │
│  Programs    │  Queued · 5      (collapsible group)                            │
│  Other       │  Completed · 30  (collapsible group)                            │
│ QUEUES       │                                                                 │
│  Main        │                                                                 │
│  Night       │                                                                 │
│ ──────────── │                                                                 │
│ Settings     │                                                                 │
│ ☾ Theme      │                                                                 │
├──────────────┴─────────────────────────────────────────────────────────────────┤
│ ● Browser connected (Chrome, Edge)      ↓ 18.4 MB/s     3 active      212 GB free │
└────────────────────────────────────────────────────────────────────────────────┘
```
(Icons in the final UI are lucide icons, not emoji.)

**Add download dialog (modal, 560 px wide)**
```
┌ Add download ───────────────────────────────────────────── ✕ ┐
│ URL(s)                                                         │
│ [ https://…  (paste one or many links, one per line)         ] │
│ ✓ ubuntu-24.04.iso · 6.2 GB · resumable · 8 connections ok     │  ← live probe result
│ Save to   [ D:\Downloads\EDM\Programs        ] [Browse]        │
│ Category  [ Programs ▾ ]      Queue [ Main ▾ ]                 │
│ Connections  ●━━━━━━━○ 8      Speed limit [ none ▾ ]           │
│ ▸ Advanced  (headers, cookies, referrer, user-agent, auth,     │
│              checksum, rename)                                 │
│                          [ Cancel ]  [ Download later ] [ Start ]│
└────────────────────────────────────────────────────────────────┘
```

**Capture popup (small always-on-top window near the bottom-right; appears when the browser hands off a file)**
```
┌ EDM · New download ───────────────────── ✕ ┐
│ [ZIP] project-assets.zip     148 MB        │
│ from cdn.example.com                       │
│ Save to  [ D:\Downloads\EDM\Compressed ▾ ] │
│ [ ] Always do this for .zip                │
│     [ Cancel ]  [ Later ]  [ ▶ Start ]     │
└────────────────────────────────────────────┘
```
Auto-starts after a configurable countdown (default off). A setting allows "Skip popup and start immediately".

**Inspector (slides in from the right, 380 px, when a row is selected or double-clicked)**
- Header: file icon, name, status chip.
- **File map:** 120 cells = 120 equal slices of the file. Cell colors: done = accent, in-progress = accent with shimmer, pending = `--bg-hover`, failed = `--danger`.
- **Live speed graph** (last 60 s, uPlot).
- **Details:** URL (mono, copy button), final URL, save path, size, resumable yes/no, connections, ETag/Last-Modified, started/finished, checksum field with Verify.
- **Connections table:** one line per active connection with speed and range.
- **Log:** last 200 events for this download (filterable).
- Actions: Pause/Resume, Open file, Open folder, Copy link, Refresh link, Remove, Delete with file.

### 7.6 Screens to build
1. **Main window** (above). Grouped list: Downloading, Queued, Completed (collapsible). Multi-select with Shift/Ctrl. Right-click context menu. Drag a link or file onto the window to add.
2. **Add download dialog** (above).
3. **Capture popup** (above).
4. **Inspector panel** (above).
5. **Queues & Scheduler:** list of queues; each has max concurrent, a weekly schedule grid (hour blocks), and post-action (None, Open folder, Sleep, Hibernate, Shutdown, Run program).
6. **Settings** (sidebar sections): General (startup, tray, language, default folder), Downloads (connections, segment size, smart mode, retries, duplicates, categories → folders), Browser integration (status, repair/reinstall, file-type list, size threshold, excluded sites, popup behavior), Network (proxy, global limit, per-host limit, TLS), Notifications, Appearance (theme, density, accent intensity), Advanced (log level, open logs folder, reset), About (version, licenses, update check).
7. **Onboarding (first run, 3 steps):** (1) pick download folder, (2) install browser extension with detected browsers shown, (3) pick theme. A "Skip" is always visible.
8. **Tray menu and mini window:** tray icon shows a progress ring while downloading. Menu: Open EDM, Add URL, Pause all/Resume all, Speed limit on/off, Quit. Left-click opens a small window with the 5 most recent active downloads.
9. **Extension popup (in the browser):** connection status, "take over downloads" toggle, detected media list, link to settings.
10. **Logs and diagnostics viewer** (under Settings → Advanced): searchable log, "copy diagnostics" button that excludes secrets.

### 7.7 Component inventory
Button (primary, secondary, ghost, danger), IconButton, Input, URL textarea, Select, Slider, Switch, Checkbox, Radio, Tabs, Dialog, Popover, Tooltip, Toast, ContextMenu, StatusChip, ProgressBar, **FileMap**, **SpeedGraph**, **ConnectionsTable**, SidebarItem, **DownloadRow**, GroupHeader, EmptyState, Skeleton, Kbd, CommandPalette (Ctrl+K), SettingsSection, ScheduleGrid. Build them once in `apps/desktop/src/components/ui/` with Storybook-style demo page at `/dev/components` (dev builds only).

**DownloadRow anatomy:** file-type icon tile (rounded `md`, tinted by category) · name (Body 500, ellipsis in the middle for long names) · progress bar 6 px high with gradient fill · meta line (Body-sm, secondary): size done / total · speed (mono) · ETA · connections · status chip · hover actions (pause/resume, open, folder, more). Selected row uses `--bg-selected` with a 2 px left accent edge.

### 7.8 States and microcopy
- **Status chip colors:** Downloading = accent, Queued = queued, Paused = warning, Scheduled = scheduled, Completed = success, Failed = danger, Needs attention = warning with icon, Link expired = warning with refresh icon. Always icon + text, never color alone.
- **Empty list:** "Nothing here yet. Paste a link with Ctrl+V or drag one onto this window."
- **Link expired:** "This link expired. Open the page again in your browser and EDM will pick up the fresh link." (button: Refresh link)
- **File changed on server:** "The file on the server changed since you started. Restart the download?" (buttons: Restart, Keep paused)
- **Disk full:** "Not enough space on D:. Free some space, or choose another folder." (buttons: Choose folder, Retry)
- **Server doesn't support resume:** "This server can't resume. If you pause, EDM will start over." (shown once as an info chip)
- **DRM media:** "This video is DRM-protected, EDM can't download it."
- **Loading:** skeleton rows, never a blank screen.
- **Destructive:** "Remove from list" is default; "Delete file too" is a separate, clearly worded action with a confirmation and Undo toast for 8 seconds.

### 7.9 Accessibility and shortcuts
- Target WCAG 2.2 AA. Visible focus ring everywhere. Full keyboard navigation. Screen-reader labels on icon buttons.
- Progress bars use `role="progressbar"`; announce updates at most once per second; toasts use a polite live region.
- Respect `prefers-reduced-motion` and Windows high-contrast (`forced-colors`). UI scales cleanly from 100% to 200%.

| Shortcut | Action |
|---|---|
| Ctrl+N or Ctrl+V (list focused) | Add URL(s) |
| Ctrl+K | Command palette |
| Space | Pause/resume selected |
| Enter | Open file (completed) / open inspector |
| Ctrl+Shift+O | Open folder |
| Delete / Shift+Delete | Remove / remove and delete file |
| Ctrl+A | Select all |
| Ctrl+F | Focus search |
| Ctrl+, | Settings |
| F2 | Rename |
| Esc | Close dialog / inspector |

### 7.10 Brand and icon direction
- Logo mark: three stacked horizontal bars of decreasing length forming an abstract "E", with a small downward notch/arrow at the lower right, filled with `--gradient-edge`. Rounded corners. Works at 16 px.
- App icon: dark rounded square (`#0D1118`) with the mark centered, subtle inner glow.
- Tray icon: monochrome mark; during downloads a thin progress ring appears around it.
- Wordmark: "EDM" in Inter 700 with slightly wide tracking; tagline "Edge Download Manager".

---

## 8. Browser extension design

**Targets:** Chrome, Edge, Brave, Opera, Vivaldi (Chromium, Manifest V3) and Firefox (separate manifest/build). Build with TypeScript, one codebase, two manifests produced by a build script.

**Permissions (each must be justified in `docs/protocol.md`):** `downloads`, `nativeMessaging`, `cookies`, `contextMenus`, `storage`, `webRequest` (observe only, for media detection), and host access. Prefer requesting broad host access at runtime as an optional permission to ease store review.

**Parts**
- **Background service worker:** listens for downloads and context-menu clicks, talks to the native host, keeps a short-lived bypass list.
- **Content script:** detects `<video>`/`<audio>` sources and floating-button placement; detects **Alt+click** on a link to mean "let the browser download this one" and tells the worker to bypass for ~5 seconds.
- **Popup:** status (connected/disconnected), master on/off, detected media, shortcut to open EDM.
- **Options page:** file-type list, size threshold, excluded domains. These settings are owned by the app (fetched via the `settings` message) so there is one source of truth.

**Capture flow (Chromium)**
1. Listen for `chrome.downloads.onCreated`. (Some public extensions use `onDeterminingFilename`; the agent must test both and keep the one that gives the best filename and the fewest side effects.)
2. Skip when: bypass list matches, URL is `blob:`/`data:`/`file:`, file type or size rules do not match, EDM is paused/disabled.
3. Gather: `chrome.cookies.getAll` for the URL, referrer, user-agent, MIME, size if known.
4. Send `add_download` to the host; wait up to 3 seconds for a reply.
5. On `accepted`: `chrome.downloads.cancel(id)` then `chrome.downloads.erase({id})`.
6. On anything else: do nothing; the browser continues. **Fail open.**
7. Badge: green dot = connected, grey = EDM not running (will auto-start on next download), red = broken integration (offers "Repair").

**Known limitations to document in the app's help page (be honest):**
- `blob:` and `data:` downloads cannot be fetched by another program; the browser keeps them.
- Downloads started by a POST form cannot be replayed safely; the browser keeps them.
- One-time or very short-lived signed links may be consumed by the browser's first request; EDM then shows "Link expired, open the page again".
- Sites that require in-page JavaScript challenges (some bot protections) may reject EDM's request even with cookies.

**Host registration (Windows, no admin needed):** The app writes a native-host manifest JSON to its data folder and creates a registry entry under the current user for each browser: Chrome, Edge, and Firefox each have their own per-user `NativeMessagingHosts` key whose default value is the path to the manifest. The manifest names the host binary and lists the allowed extension ID (Chromium) or allowed extension ID string (Firefox). The Settings → Browser integration page has a **Repair** button that rewrites all of this. The agent must confirm the exact key paths and manifest fields from each browser's current documentation (Section 13).

---

## 9. Testing and verification

> Principle: every claim about download behavior must be proven by an automated test against a server we control. If a behavior is not tested, it is not trusted.

### 9.1 The local test server (`edm-testsrv`)
A small HTTP server (built in Phase 1) that serves deterministic files and can misbehave on purpose. Content is generated from a seed, so the expected SHA-256 is known without storing big files; the server also returns it in an `X-Test-Sha256` header.

| Endpoint / switch | Behavior it simulates |
|---|---|
| `/file/{size}?seed=N` | Deterministic file of any size, full `Range` support, stable `ETag`, fixed `Last-Modified` |
| `norange=1` | No range support (`Accept-Ranges: none`) |
| `wrongrange=1` | Ignores `Range` and returns `200` with the whole file |
| `head405=1` | Rejects `HEAD` requests |
| `slow=<KB/s>` | Throttles **per connection** (this is what proves multi-connection benefit) |
| `flaky=<probability>` | Drops the connection at a random byte |
| `etag_change_at=<percent>` | File "changes" (new ETag) partway |
| `status=429&retry_after=5` | Rate limiting with `Retry-After` |
| `expire_after=<bytes>` | Returns `403` after N bytes served (expired link) |
| `redirects=<n>` | Chain of N redirects before the file |
| `chunked=1` | No `Content-Length` (unknown size) |
| `gzip=1` | Adds `Content-Encoding: gzip` (engine must still be correct) |
| `cd=plain / quoted / rfc5987 / evil / reserved` | `Content-Disposition` variants including `../../evil.exe` and `CON.txt` |
| `auth=cookie / basic` | Requires a cookie or basic auth |
| `delay=<ms>` | Adds latency |
| `/hls/…`, `/dash/…` | Generated streams for Phase 5 (including a DRM-signaled one that must be refused) |

### 9.2 Test types
- **Unit tests:** filename parsing/sanitizing (at least 40 cases), planner/splitter math, state machine transitions, limiter accuracy, protocol parsing.
- **Property tests (`proptest`):** for any file size, connection count and sequence of splits, segments never overlap, never leave gaps, and their union is exactly `[0, size)`.
- **Integration tests:** engine against `edm-testsrv` for every row in 9.1.
- **Crash tests:** hard-kill the process at random times during downloads, restart, resume, compare SHA-256. Run at least 50 iterations in CI nightly.
- **UI tests:** Vitest for components, Playwright for flows, `axe-core` for accessibility.
- **Extension tests:** Playwright with the extension loaded; verify handoff, fail-open, Alt+click bypass.
- **Fuzzing:** the native messaging frame parser and the `Content-Disposition` parser.
- **Manual smoke list** (not in CI): a large public file from a fast mirror, a login-protected download, a site with redirects, a video page.

### 9.3 Benchmarks (`docs/benchmarks.md`)
Measure on the test server with `slow=` set so the per-connection limit matters. Compare: 1 connection, 8 connections, and (if installed) `aria2c` with 8 connections. Record throughput, completion time, CPU %, peak memory. **Targets to measure, not promises:** engine at or near parity with aria2 on the same server; idle app memory (including the web view) and 5-active-download memory recorded and trended release over release.

---

## 10. Packaging and release

- **Installer:** Tauri bundler, NSIS, per-user install (no admin required). The installer/app registers the native messaging host for the current user; uninstall removes every registry key and file it created.
- **WebView2:** required on Windows. Windows 10/11 usually include it; the installer must handle the case where it is missing (verify the Tauri option for this).
- **Updates:** Tauri updater with signed update manifests. The private signing key is never committed; it lives in CI secrets. Document key backup.
- **Code signing:** unsigned installers trigger SmartScreen warnings. Before a public release, obtain a code-signing certificate (research options and costs at that time) and document the process. SmartScreen reputation builds over time.
- **Versioning:** semantic versioning; `CHANGELOG.md` updated each phase.
- **Distribution:** GitHub Releases for the app. Extensions go through the Chrome Web Store, Edge Add-ons and Firefox AMO; prepare the privacy statement ("EDM collects no data"), a single-purpose description, per-permission justifications and screenshots.
- **Portable mode (later):** zip build that stores settings next to the exe.

---

## 11. Operating rules for the agent (apply to every phase)

1. **Plan first.** Before coding a phase, write `docs/reports/phase-N-plan.md`: steps, risks, test list. Then build.
2. **Do only the phase requested.** No extra features. Anything useful but out of scope goes into `docs/ideas.md`.
3. **Test first for engine logic.** Every bug fix begins with a failing automated test.
4. **Branch and commit discipline.** One branch per phase (`phase-N`). Small commits, one logical change each, clear messages.
5. **Never claim a check passed without running it.** Before finishing, run `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, and the UI lint/test/build commands. Paste a short result summary into the report.
6. **Safe Rust.** No `unsafe` without a comment explaining why. No `unwrap()`/`expect()` in code that can fail at runtime (tests excepted). Do not block inside async tasks; move blocking disk work to `spawn_blocking`.
7. **Original code only.** Never copy from other download managers. Keep `docs/licenses.md` current.
8. **Explain decisions in plain language.** One short ADR in `docs/decisions/` for every non-obvious choice: context, decision, alternatives, consequences. The owner is not a systems expert.
9. **Secrets.** Cookies, tokens and signed URLs are never logged or committed.
10. **Touch only safe paths.** Tests use temp directories. Never delete or overwrite files outside the configured download folder or the app data folder.
11. **Ambiguity.** Choose the safest option, record it in an ADR, continue. Ask the owner only when truly blocked.
12. **Honest reporting.** The phase report must list what is incomplete, flaky or unverified. Mark unverified claims as "unverified". A short honest report beats a confident wrong one.
13. **Platform code** lives behind `cfg` modules so macOS/Linux can be added later.
14. **Update** `CHANGELOG.md` and relevant docs at the end of each phase.

**Phase report template (`docs/reports/phase-N.md`):** Summary · What was built · "Done when" checklist with PASS/FAIL and evidence (command output or screenshot) · Metrics · Known issues · Decisions made (links to ADRs) · What the next phase needs.

---

## 12. Phases, tasks and "Done when" checklists

### Phase 0 — Scaffold and decisions
**Tasks**
- Create the Cargo workspace and all crates listed in 5.3 (empty but compiling), the Tauri 2 app with React + Vite + TypeScript + Tailwind, and the extension skeleton that builds a Chromium and a Firefox bundle.
- Set up `tracing` logging, error types, and a shared `edm-ipc` types crate.
- CI (GitHub Actions): format, clippy, tests, UI lint/build on Windows.
- Docs skeleton: ADRs for language choice, HTTP/1.1-per-segment, SQLite, Tauri, extension approach; `licenses.md`; `README.md` with exact setup steps for a fresh Windows machine.

**Done when**
1. `cargo build --workspace` and `cargo test --workspace` pass.
2. `npm run build` for the UI passes; the Tauri dev window opens and shows a themed placeholder.
3. The extension builds to `extension/dist/chromium` and `extension/dist/firefox`.
4. CI workflow file exists and is valid.
5. At least 5 ADRs exist; README setup works from scratch.

### Phase 1 — Download engine (headless)
**Tasks**
- Build `edm-testsrv` (9.1) first.
- `edm-core`: Probe, Planner, Workers, Writer, Checkpointer, Retry, state machine, SQLite store, resume with `If-Range`, dynamic splitting, single-stream fallback, stall detection, link-expired handling, basic filename resolution.
- Benchmark sparse vs plain pre-allocation on NTFS and record the decision.
- `edm-cli`: add, list, pause, resume, cancel, refresh-link.

**Done when**
1. A 1 GiB seeded file downloads with 8 segments and the SHA-256 matches.
2. Hard-kill at ~40%, restart, resume: SHA-256 matches and extra re-downloaded data is below the checkpoint interval's worth plus one buffer.
3. `flaky` mode completes correctly.
4. `norange` and `wrongrange` fall back to single stream and complete; pausing warns that it restarts.
5. `etag_change_at` ends in `NeedsAttention` with no corrupted output.
6. `429` with `Retry-After` is honored (test asserts the wait).
7. `expire_after` → `LinkExpired`; after `refresh_link` it continues from the same position.
8. A 5-hop redirect chain resolves and the final URL is recorded.
9. `chunked` (unknown size) and `gzip` servers produce correct files.
10. Property tests prove no gaps or overlaps in the planner/splitter.
11. Files are written as `.edmpart` and renamed atomically on success.
12. `docs/benchmarks.md` exists with measured numbers; `clippy` is clean; no undocumented `unsafe`.

### Phase 2 — Queue, scheduler core, limits, file handling
**Tasks:** queues (max concurrent, priorities), per-host cap, token-bucket limits (global and per download), categories and folders, filename sanitizing/duplicates/long paths, checksum verification, Mark-of-the-Web, disk-space pre-check and low-space handling, batched event bus (4 Hz), settings store, history.

**Done when**
1. With 10 downloads added and max concurrent 3, never more than 3 run.
2. Priority changes reorder the queue.
3. Speed limit accuracy is within ±10% over a 30 s measurement, global and per download.
4. At least 40 filename test cases pass, including Unicode, RFC 5987, reserved names, trailing dots and `..\` traversal.
5. Completed files carry a `Zone.Identifier` stream (verified with a Windows command in the report).
6. Simulated disk-full results in `NeedsAttention`, not corruption.
7. Duplicate policy works (rename, overwrite with confirm, skip).
8. Checksum mismatch → `Failed` with a clear message; file is kept and flagged, not deleted.
9. UI-facing events are batched (no more than about 5 updates per second per task).

### Phase 3 — Desktop app and design system
**Tasks:** implement tokens (7.2–7.4) as CSS variables with dark/light switching; build the component inventory (7.7); screens 1, 2, 4, 5 (queues without schedule grid), 6, 7, 8, 10 from 7.6; tray, single-instance, autostart, notifications, drag-and-drop, context menu, command palette, shortcuts (7.9); English strings in a catalog for later translation.

**Done when**
1. All listed screens exist in both themes; screenshots are in the report.
2. No hard-coded colors in components (a grep/lint check enforces it).
3. `axe-core` shows no critical or serious violations on the main screens.
4. Keyboard-only run-through works: add, pause, resume, remove, open settings.
5. A list with 10,000 fake rows scrolls smoothly; frame-time measurement included.
6. The UI only calls the commands in 5.10.
7. Cold start time-to-first-paint and idle memory are measured and reported.
8. The file map and speed graph update smoothly at 4 Hz with no layout jank.

### Phase 4 — Browser integration
**Tasks:** `edm-ipc` pipe server in the app; `edm-nmh`; extension capture flow (8); capture popup window; cookie/referrer/UA handoff; context menu; Alt+click bypass; settings sync; registration + Repair button; Firefox build; tests.

**Done when**
1. In Chrome and Edge (unpacked extension): clicking a `.zip` link opens the capture popup, and the browser's download is cancelled and erased only after `accepted`.
2. With EDM closed, the first download starts EDM and is still captured.
3. With the host manifest removed, the browser downloads normally (fail open).
4. A cookie-protected test endpoint downloads correctly through the handoff.
5. Alt+click bypass works; `blob:` and POST downloads stay in the browser.
6. Firefox build captures too, or the limitation is documented with evidence.
7. Fuzz tests for the frame parser pass; the pipe's per-user access restriction is verified and documented.
8. The extension's permission list matches `docs/protocol.md`.

### Phase 5 — Video/media grabber
**Tasks:** media detection, floating button, quality picker, HLS (master/media playlists, byte-range, fMP4, AES-128 with key in playlist), DASH basics, FFmpeg sidecar for muxing, DRM detection and refusal, progress aggregation.

**Done when**
1. A local multi-quality HLS stream downloads and plays correctly.
2. An AES-128 HLS stream downloads and plays.
3. A DASH stream with separate audio/video muxes in sync.
4. DRM-signaled manifests (Widevine/PlayReady/FairPlay markers) are refused with the exact message in 7.8.
5. The floating button appears on a local test page and sends the right variant to EDM.
6. FFmpeg's license and the way it is bundled are documented.

### Phase 6 — Polish and release
**Tasks:** scheduler grid and post-actions; proxy and per-download auth; clipboard monitor (opt-in); Smart mode; "download all links on page"; installer, updater, signing docs; uninstall cleanup; privacy statement and help pages; performance and security passes; license audit; store listing materials.

**Done when**
1. A fresh Windows VM: install → onboarding → install extension → capture → update to a newer build works.
2. Uninstall removes all registry keys, host manifests and shortcuts.
3. Scheduler start/stop and each post-action are tested.
4. Proxy works against a local test proxy; clipboard monitor is off by default.
5. The security checklist in 5.13 is fully ticked with evidence.
6. `docs/licenses.md` is complete; privacy statement says EDM collects no data.

### Phase 7 — Optional extras (only on request)
BitTorrent/magnet (use a vetted Rust library after license review), FTP/SFTP, aria2-compatible remote control, import/export lists, portable mode, macOS and Linux builds, store submissions.

---

## 13. "Verify before use" list (the agent must check current documentation or test)

These are places where browser/platform behavior changes over time. Do not rely on memory; confirm and record the answer in an ADR.

1. Whether an open `connectNative` port keeps a Manifest V3 service worker alive in current Chrome/Edge; if not, use per-event `sendNativeMessage`.
2. `chrome.downloads.onCreated` versus `onDeterminingFilename` behavior for filename, cancel timing and side effects.
3. Exact native messaging manifest fields and per-user registry key locations for Chrome, Edge and Firefox.
4. Firefox Manifest V3 differences (background scripts vs service worker, `browser.*` namespace, host manifest fields).
5. Tauri 2 plugin APIs and capability configuration for: single-instance, autostart, deep-link, notification, updater, tray.
6. NSIS per-user installer options and WebView2 handling in the Tauri bundler.
7. Windows Mark-of-the-Web (`Zone.Identifier`) stream format.
8. NTFS sparse vs plain pre-allocation performance (benchmark).
9. `reqwest` settings to force HTTP/1.1 per segment and to disable automatic decompression for ranged requests.
10. FFmpeg build license (LGPL vs GPL) before bundling.
11. License and maturity of any torrent library before Phase 7.
12. Extension store policies on permissions and single purpose.

---

## 14. Appendices

### A. First-time setup on Windows (for you, Suvesh)
1. Install **Rust** with `rustup` (stable toolchain).
2. Install **Node.js LTS**.
3. Install **Visual Studio Build Tools** (C++ workload) and confirm **WebView2** is present (Windows 11 has it).
4. Install **Git**. Optional: **FFmpeg** (for Phase 5 tests), **aria2** (for benchmarks).
5. Handy commands once the repo exists: `cargo build --workspace` (build everything), `cargo test --workspace` (run tests), `cargo run -p edm-cli -- --help` (try the engine), and the app's dev command documented in `README.md`.

### B. Glossary
- **Segment:** one byte range of a file downloaded on its own connection.
- **Range request / 206:** asking a server for part of a file; `206 Partial Content` is the correct reply.
- **ETag / Last-Modified / If-Range:** ways to prove the file has not changed between resume attempts.
- **Native messaging:** the browser feature that lets an extension talk to a desktop program.
- **Sidecar:** a helper program shipped with the app (FFmpeg here).
- **WAL:** SQLite's write-ahead log mode; faster and safer for frequent small writes.
- **Token bucket:** a simple algorithm that limits speed by handing out "permission to send bytes" at a fixed rate.
- **Mark-of-the-Web:** the Windows flag that says "this file came from the internet" so security features can warn about it.
- **MV3 / service worker:** the current browser extension format, where the background code can be stopped and restarted by the browser.
- **HLS / DASH:** two common ways websites stream video as many small pieces plus a playlist.
- **DRM:** copy protection for video; EDM will not circumvent it.
- **Mux:** combine separate video and audio tracks into one file.

### C. Naming and branding notes
- "EDM" is also a popular music genre, so web searches will be crowded. Keep **EDM** as the short product name and **Edge Download Manager** as the expansion, and consider a distinctive store/listing title such as "EDM — Download Manager".
- "Edge" is also Microsoft's browser name. Do not use Microsoft Edge's logo, wave motif or colors, and do not imply any affiliation. Check trademark and store-name conflicts before a public launch.

### D. Reference architecture
Engine behavior, segmented downloading, and benchmark baselines, plus public examples of browser-to-native-download-manager extensions that use native messaging.

*End of spec.*
