# EDM Agent & Architecture Rules

Every AI agent, developer, and automated pipeline working on EDM must strictly adhere to the following 7 core rules:

---

### Rule 1: Feature Isolation Behind Settings
- Every new feature MUST sit behind a dedicated setting (with a deterministic default defined in its specification).
- The feature can be toggled off at runtime without degrading or breaking existing functionality.
- Toggling a feature off must completely disable its background workers, event listeners, and hooks.

---

### Rule 2: Backward & Forward Compatibility
- **IPC & WebSocket Schema**: All newly added fields in WebSocket, Native Messaging, and named pipe schemas MUST be optional (`#[serde(default)]` in Rust, `?` optional in TypeScript).
- **Protocol Version Negotiation**: The connection handshake negotiates capabilities via `protocol_version`.
- **Cross-Version Operation**: A new app version with an older extension, and an older app with a newer extension, must interoperate without crashes or breaking core download paths.
- **Single Source of Truth**: App and extension version numbers must be synchronized from the workspace source of truth (`Cargo.toml` / `package.json`).

---

### Rule 3: Zero-Idle & Deep Sleep Invariants
- EDM is engineered for ultra-low resource footprint: nothing may spawn unthrottled timers, polling loops, background threads, or leak memory while the application is idle.
- Each feature specification MUST explicitly state whether it blocks deep sleep or listener sleep and provide architectural justification.
- Wake paths (Windows Native Messaging Host `edm-nmh.exe`, `edm://` protocol handler) must remain fully responsive even when EDM is sleeping.

---

### Rule 4: Defensive Privacy & Security
- **Zero Telemetry**: No tracking, phone-home metrics, or unsolicited analytics; zero external network traffic leaves the machine except for user-requested downloads.
- **Credential Storage**: Sensitive data (HTTP basic/digest credentials, auth cookies, bearer tokens) must NEVER be persisted in plaintext. Persisted secrets must use the Windows Data Protection API (DPAPI) or Windows Credential Manager and be immediately wiped on task completion.
- **Local Host Security**: Local servers (WebSocket/HTTP on `127.0.0.1:14370`) must enforce constant-time token comparison, Origin checking, and Host header validation against DNS rebinding.
- **Path Sanitization**: The browser extension is untrusted user-space and MUST NEVER receive arbitrary disk filesystem paths.

---

### Rule 5: Quality, Reliability & Human Error Handling
- **No Unwraps on Critical Paths**: Zero `unwrap()` or `expect()` calls in startup sequences, message handlers, or download hot paths; handle fallbacks with descriptive errors.
- **User-Readable Errors**: Errors shown in the UI must explain the root cause and provide actionable recovery steps (e.g., "Disk space exhausted on D:\" instead of "I/O error 112").
- **Secret Redaction**: Structured logging (`tracing`) must never print plain-text tokens, cookies, or authorization headers.
- **Accessible UI Craft**: User interfaces must follow the existing 3D depth and compact design system with proper labels, keyboard navigation, high contrast, and `prefers-reduced-motion` support.

---

### Rule 6: Rigorous Testing Gates
- Every feature must be backed by unit tests and integration tests against `edm-testsrv` (adding simulated server profiles when needed).
- Full verification script (`scripts/verify-all.ps1`) MUST pass with zero errors and zero warnings before any feature is considered complete.
- **Absolute Invariant**: Never disable, skip, or comment out a test to make the build pass.

---

### Rule 7: Development & Release Process
- Tag git before major refactors or version bumps.
- Commit surgically in small, verifiable units with clear commit messages.
- Maintain `CHANGELOG.md` with every user-facing change.
- Provide a structured final report detailing: root causes, architectural changes, test outcomes, manual verification checklist, sleep impact, browser extension compatibility, and database migration notes.
