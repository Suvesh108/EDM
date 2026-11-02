# Changelog

All notable changes to Edge Download Manager (EDM) are documented in this file.

## [v0.0.7] - 2026-11-02

### 🛠️ Hotfixes & Refinements (from v0.0.6 testing)

#### 1. Setup Wizard Persistence & Relaunch Prevention
- **Root Cause**: The Skip button in `SetupWizard.tsx` closed the modal without persisting completion to SQLite storage, causing the wizard to reappear on every application launch.
- **Fix**: Persist `setup_completed` (with backwards compatibility for `wizard_completed`) to the backend SQLite database on both Finish AND Skip. Relaunches and updates never re-show the wizard.
- **Settings Re-entry**: Settings page now includes a dedicated "Run setup again" action to re-run onboarding on demand.

#### 2. Setup Page Redesign (Minimal Silver on Pure Black)
- **Aesthetic**: Redesigned setup wizard with a pure black (`#000000`) canvas, silver typography (`#E4E6EA`, `#B8BCC4`, `#7C818A`, `#1B1C20`), and single-column centered layout constrained to 480 px.
- **3D Tactile Accents**: Primary action styled as a raised silver key with inner highlight, layered depth shadow, and pressed states; browser items rendered as subtly raised plates.
- **Streamlined 3-Screen Flow**: Screen 1: EDM wordmark + concise description (<= 12 words) + Continue & Skip; Screen 2: Detected browsers with one-click Connect / Reinstall; Screen 3: Live native host integration test result and Done.
- **Anti-Marketing Polish**: Stripped unverified feature marketing claims and relocated settings/preferences into the app Settings view.

#### 3. Zero-Error Extension WebSocket State Machine
- **Root Cause**: The background service worker executed unconditional WebSocket connection attempts on startup and retried every 3 seconds while EDM was asleep or closed, triggering browser console connection errors.
- **Fix**: Implemented a non-intrusive status check via the Native Messaging Host (`status`). WebSocket connection is initiated only when EDM is confirmed to be running.
- **Sleep Invariant**: When EDM is asleep or closed, the extension stays completely dormant without background retry intervals.
- **Exponential Backoff**: After unexpected disconnections, the helper is queried once; only if EDM is confirmed running does it reconnect using exponential backoff capped at 60 seconds. Normal sleep states are logged via `console.debug`.

#### 4. Relocated Queue Scheduler & Rules into Settings
- **Clean Chassis**: Removed the standalone Queues navbar button and floating window to maintain visual hierarchy.
- **Queues & Schedule in Settings**: Integrated multi-queue concurrency limits, off-peak schedules, bandwidth throttles, and automated power actions directly into Settings &rarr; "Queues & Schedule".
- **Label Sanitization**: Removed all "(Win32)" designations from action and power options.

#### 5. Native YouTube Watch Page Pill Button & Site Controls
- **Owner Row Placement**: Injected a native-styled action pill button directly into the video owner metadata row immediately after the Subscribe button on `youtube.com/watch` pages.
- **Theme Awareness**: Dynamically adapts colors, borders, and hover states to YouTube's native dark and light themes (36 px height, 18 px pill radius, Roboto typography).
- **SPA & Dynamic DOM Support**: Intercepts YouTube SPA transitions via `yt-navigate-finish`, `spfdone`, and debounced MutationObserver. YouTube Shorts are skipped unless explicitly enabled.
- **Floating Button Cleanup**: Removed the bottom-right floating button overlay on YouTube.
- **Granular Controls**: Added settings for Master Toggle, YouTube Toggle, Other Sites Toggle, and a persistent Hidden Sites domain list with "Hide on this site".

#### 6. Media Sniffer & Link Grabber Reliability; Diagnostics Relocation
- **Top-Level Synchronous Sniffer**: Registered synchronous `webRequest.onResponseStarted` in the service worker to capture video/audio streams, HLS playlists (`.m3u8`), and DASH manifests (`.mpd`) into per-tab `chrome.storage.session`.
- **Extractor Video Probing**: When browsing YouTube or supported media hosts, queries the desktop application's native extraction pipeline to enumerate available video/audio streams and quality formats.
- **Scripting Fallback for Link Grabber**: Added `chrome.scripting.executeScript` fallback to reliably extract links, media, and images even on pages loaded prior to extension installation.
- **Popup Navigation Streamlining**: Reduced popup navigation to 4 focused tabs: **Tasks**, **Media**, **Grab Links**, and **Settings**. Relocated Host Diagnostics into Settings &rarr; Diagnostics with one-click navigation from the header connection pill.

---

## [v0.0.6] - 2026-11-01

### 🚀 Major Features & Additions

#### 1. Expired-Link Recovery ("Refresh Download Address")
- **Mid-Stream Expiry Detection**: Automatically transitions tasks to `LinkExpired` upon HTTP 401, 403, or 410 mid-download, preserving existing partial files without corrupting progress.
- **Safe Overlap Verification**: Probes fresh replacement URLs and verifies both file length and a 1 MiB SHA-256 chunk overlap against existing downloaded bytes before resuming.
- **DPAPI Credential Protection**: Persisted session cookies are encrypted with Windows Data Protection API (`CryptProtectData`) and automatically purged upon task completion.
- **Extension & Manual Refresh**: Trigger refresh directly from browser popup notifications or via the dedicated in-app modal.

#### 2. Queue Scheduler & "When Done" Power Actions
- **Multi-Queue Management**: Configure concurrency limits and speed caps independently per queue.
- **Time-Window Scheduling**: Specify active operational hours (`schedule_start`, `schedule_stop`) and active days of the week, with automatic cross-midnight scheduling support.
- **Win32 Post-Task Actions**: Automated "When Done" triggers for Open Folder, Sleep (`SetSuspendState`), Hibernate, or Shutdown (`InitiateSystemShutdownExW`).
- **60-Second Abort Countdown**: All system power transitions trigger a prominent, cancelable 60-second countdown overlay in the desktop UI and browser extension.

#### 3. Floating Video Downloader & Media Panel
- **Closed Shadow DOM Button**: Zero CSS bleed or page script collision using `mode: 'closed'` custom element overlay on detected `<video>` and streaming elements.
- **Stream Format Probing**: Parses HLS master playlists (`.m3u8`) and direct streams to surface resolution, bitrate, audio channels, and estimated file size.
- **Zero-DRM Invariant**: Strict compliance refusing encrypted EME/Widevine/FairPlay streams with clear user-facing notifications.

#### 4. Batch Download Pattern Expander & Link Grabber
- **Pattern Expansion**: Parses numeric ranges with leading zeros (`[001-100]`), alpha ranges (`[a-z]`), and set expansion (`{1080p,720p}`).
- **Safety Limits & Virtualized Preview**: 200-item batch confirmation warning and a hard 1,000-item expansion cap to prevent memory exhaustion.
- **Duplicate Pre-Flight**: Checks existing database tasks by URL, filename, and file size before enqueuing batch items.

#### 5. First-Run Setup Wizard & App-Managed Extension Updates
- **Step-by-Step Onboarding**: First-run wizard detects Chrome, Edge, Brave, and Firefox installations from the Windows Registry.
- **App-Managed Updates**: Shipped extensions are integrity-checked against an installer SHA-256 manifest and auto-reloaded via `chrome.runtime.reload()` when idle.

#### 6. Diagnostics Suite & Universal Wake Reliability
- **Host & App Diagnostic View**: End-to-end verification for Native Messaging registration, host execution, port readiness, and cold-start timings.
- **One-Click Repair**: Re-registers HKCU native messaging manifests with verified absolute exe paths without requiring administrative privileges.
- **Adaptive Cold-Start Timing**: Extended 20s connection budget prevents premature browser download cancellation during cold app boots.

#### 7. Download Safety & History Ledger
- **Masqueraded Double-Extension Detection**: Flags high-risk executable masking patterns (e.g., `.pdf.exe`, `.jpg.scr`).
- **NTFS Mark-of-the-Web**: Attaches `Zone.Identifier=3` ADS metadata to downloaded payloads matching Windows Defender and SmartScreen security standards.
- **Download History View**: Independent SQLite ledger with search, filtering, and RFC 4180 CSV export.

---

### 🧪 Quality & Verification
- All 45 Rust workspace tests passing (`edm-core`, `edm-store`, `edm-ipc`, `edm-desktop-app`, `chaos_integration`).
- Rust Clippy clean with zero warnings (`-D warnings`).
- Desktop UI (`edm-desktop`) and Browser Extension (`edm-extension`) production builds pass with zero errors.
