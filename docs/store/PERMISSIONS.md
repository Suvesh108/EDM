# EDM Browser Extension — Permissions Justification

This document justifies every permission requested by the EDM browser extension in `manifest.chromium.json` and `manifest.firefox.json` for submission to the Chrome Web Store, Microsoft Edge Add-ons, and Mozilla Add-ons (AMO).

---

## Retained Permissions & One-Line Justifications

| Permission | Justification |
| :--- | :--- |
| **`nativeMessaging`** | Communicates with the local `edm-nmh.exe` native host to wake EDM when closed and exchange loopback authentication tokens. |
| **`cookies`** | Captures authentication cookies exclusively for the user-initiated download URL to authenticate multi-connection requests in the EDM desktop engine. |
| **`downloads`** | Intercepts native browser downloads to cancel browser-handled downloads and hand off URLs to the high-speed EDM engine. |
| **`webRequest`** | Inspects streaming media headers and content-disposition response headers to detect downloadable video and audio files before browser save prompts trigger. |
| **`<all_urls>`** (Host Permission) | Enables download interception, media stream detection, and cookie retrieval across arbitrary download sites requested by the user. |
| **`activeTab`** | Allows the extension popup and context menu to read the active page URL and detect downloadable media streams on the current page. |
| **`scripting`** | Injects the client-side link sniffer and video media probe when the user opens the Link Grabber in the popup or right-clicks a page. |
| **`contextMenus`** | Adds the "Download with EDM" and "Download all links with EDM" options to the browser's right-click context menu. |
| **`notifications`** | Displays native desktop notifications when download tasks begin, finish, or encounter errors without needing EDM's main window focused. |
| **`storage`** | Persists user preferences locally (interception toggles, UI theme, token cache, and excluded domains) without any remote transmission. |

---

## Pruned / Unused Permissions

| Permission | Status | Justification |
| :--- | :--- | :--- |
| **`tabs`** | **Removed / Omitted** | Broad access to all tab URLs/titles across all windows is not needed; `activeTab` provides scoped access exclusively when the user interacts with the extension. `chrome.tabs.onRemoved` does not require the `tabs` permission. |
