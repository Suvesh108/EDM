# Changelog

All notable changes to Edge Download Manager (EDM) are documented in this file.

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
