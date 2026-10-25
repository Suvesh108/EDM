# ADR 0005: Fail-Open Browser Extension Interception

## Status
Accepted

## Context
Aggressive download managers often cancel browser downloads immediately when intercepted. If the desktop application is unresponsive, crashes, or rejects the download, the user loses their download entirely.

## Decision
The EDM browser extension enforces a strict **Fail-Open Policy**:
- The extension intercepts `chrome.downloads.onCreated`.
- It sends the request to `edm-nmh` and sets a strict 3-second timeout.
- The browser download is cancelled and erased **only after** receiving an explicit `accepted` reply from EDM.
- On timeout, error, or `declined` status, EDM takes no action, and the native browser completes the download uninterrupted.

## Consequences
Downloads are never dropped or silently lost due to background service delays.
