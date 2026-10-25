# ADR 0004: Local Named Pipe IPC Architecture

## Status
Accepted

## Context
Browser extensions cannot directly manipulate native OS files or execute GUI processes. They communicate via standard Chrome/Edge Native Messaging (`stdin`/`stdout`). Running an open HTTP server on `localhost` introduces significant security vulnerabilities (such as arbitrary websites triggering malicious downloads via CSRF/DNS rebinding).

## Decision
We utilize a two-tier IPC architecture:
1. `edm-nmh`: A tiny, stateless native messaging host binary launched by the browser on demand.
2. Windows Named Pipe (`\\.\pipe\edm_ipc_service`): Restricted strictly to the current Windows user SID, ensuring isolation from other users and preventing browser-side web page access.

## Consequences
Zero open TCP ports listening on localhost. All external inputs from the extension are treated as untrusted and strictly validated.
