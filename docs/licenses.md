# EDM Dependency Licenses

Every external crate, library, and tool included in EDM is reviewed for permissive licensing.
In accordance with EDM operating rules, no GPL or AGPL code is incorporated into the codebase.

## Rust Workspace Dependencies
- `tokio`: MIT
- `serde`, `serde_json`: MIT / Apache-2.0
- `reqwest`: MIT / Apache-2.0
- `rusqlite`: MIT
- `thiserror`: MIT / Apache-2.0
- `tracing`, `tracing-subscriber`: MIT
- `uuid`: MIT / Apache-2.0
- `chrono`: MIT / Apache-2.0
- `sha2`, `md-5`, `sha1`, `hex`: MIT / Apache-2.0
- `bytes`, `futures-util`: MIT / Apache-2.0
- `axum`, `tower-http`: MIT
- `clap`: MIT / Apache-2.0
- `url`, `urlencoding`: MIT / Apache-2.0

## Frontend UI Dependencies
- `react`, `react-dom`: MIT
- `motion`: MIT
- `tailwindcss`: MIT
- `zustand`: MIT
- `@tanstack/react-virtual`: MIT
- `uplot`: MIT
- `lucide-react`: ISC / MIT
- `radix-ui`: MIT

## Bundled Tools & Sidecars
- `ffmpeg`: LGPL v2.1+ build (separate standalone executable sidecar, non-static linkage, zero modification).
