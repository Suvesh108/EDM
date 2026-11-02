# Privacy Policy for EDM Browser Extension

**Last Updated:** November 2026  
**Effective Date:** November 2026  
**Hosted URL:** `https://suvesh108.github.io/EDM/store/PRIVACY.html`

---

## 1. Overview
The EDM Browser Extension ("Extension") is an open-source companion tool for the Edge Download Manager ("EDM") desktop application. We believe privacy is a fundamental human right. **The Extension does not collect, track, profile, store on remote servers, or transmit any user data or telemetry to third parties.**

All data processed by the Extension remains strictly on your local computer.

---

## 2. What Data Is Processed and Why

### A. Download URLs and Referrers
- **Purpose:** When you click a downloadable link or when browser downloads are intercepted, the target URL and HTTP referrer are handed over to the local EDM desktop application running on `127.0.0.1`.
- **Destination:** Transferred exclusively over a secured loopback WebSocket/IPC pipe to your locally running EDM desktop app. No external servers or telemetry endpoints are ever contacted.

### B. Session Cookies
- **Purpose:** Certain download links (such as cloud drives, restricted servers, or authorized members-only platforms) require valid session cookies to resume or accelerate multi-stream downloads.
- **Handling:** Cookies are only read for the specific host domain of the download item at the exact moment of download interception. They are passed directly to the local EDM desktop application and never stored unencrypted or transmitted across the internet.

### C. Active Page Media Streams
- **Purpose:** When you invoke the Link Grabber or browse media streaming sites with the Media Sniffer active, the extension extracts direct `.m3u8`, `.mpd`, or `.mp4` URLs to allow downloading in EDM.
- **Handling:** Extracted media URLs are processed purely in-memory and in local browser storage (`chrome.storage.session` and `chrome.storage.local`).

### D. User Preferences
- **Purpose:** User toggles (such as intercept state, excluded domain lists, dark/silver theme, and auto-wake options) are stored in your browser's local sandbox via `chrome.storage.local`.
- **Handling:** Preferences never leave your browser sandbox.

---

## 3. Telemetry and Analytics
- **Zero Telemetry:** The Extension contains **no** Google Analytics, no Mixpanel, no Sentry, no crash-reporting SDKs, and no tracking pixels.
- **No Remote Code Execution:** The Extension does not load external scripts (`eval`, remote CDNs, or remote workers). 100% of the executable code is packaged directly within the extension package and verified via SHA-256 integrity hashes.

---

## 4. Local Inter-Process Communication (IPC)
The Extension communicates solely with:
1. `com.edm.nmh` (Native Messaging Host binary `edm-nmh.exe` located on your local machine) to wake the EDM application if closed.
2. `ws://127.0.0.1:14370` (Local loopback WebSocket server) guarded by a high-entropy secret token and Origin verification.

External web origins and unauthenticated external entities are strictly rejected with HTTP 403 Forbidden.

---

## 5. Contact
If you have any questions or feedback regarding this Privacy Policy, please open an issue on the official GitHub repository:
- **Repository:** [https://github.com/Suvesh108/EDM](https://github.com/Suvesh108/EDM)
- **Author:** Suvesh (Suvesh108)
