# EDM Browser Extension — Store Listing Assets & Text

This document contains copy, metadata, and graphical specifications for submitting EDM to the **Chrome Web Store**, **Microsoft Edge Add-ons**, and **Mozilla Add-ons (AMO)**.

---

## 1. Extension Metadata

- **Name:** EDM — Edge Download Manager
- **Short Name:** EDM
- **Category:** Productivity / Tools
- **Version:** `0.0.7`
- **Supported Browsers:** Google Chrome, Microsoft Edge, Brave Browser, Mozilla Firefox
- **Gecko ID (Firefox):** `edm@suvesh.dev`
- **Pricing:** Free & Open Source (MIT)

---

## 2. Store Descriptions

### Short Description (Max 132 Characters)
> High-speed download acceleration, link grabber, media sniffer, and seamless browser integration companion for EDM.

*(Character count: 121 characters — complies with Chrome Web Store <= 132 chars limit)*

### Long Description

```markdown
**IMPORTANT: This extension requires the EDM desktop application installed on your Windows PC.**
Get the EDM desktop app: https://github.com/suveshmohandas/EDM/releases

EDM (Edge Download Manager) is a modern, ultra-fast download manager featuring dynamic multi-connection acceleration, media link sniffing, YouTube/stream downloading, and quiet background sleep efficiency.

The EDM Browser Extension seamlessly bridges your browser with the EDM desktop application, taking over downloads automatically with zero friction.

### Key Features:
- ⚡ **Seamless Download Interception**: Automatically catches browser download links and routes them to EDM's high-speed multi-connection engine.
- 🎬 **Smart Media Sniffer**: Detects streaming video and audio files (MP4, WebM, HLS M3U8, DASH MPD) across websites with one-click download buttons.
- 🧲 **Universal Link Grabber**: Scan and batch-extract downloadable links, images, documents, and media from any active webpage.
- 🌙 **Zero Idle Footprint & Auto-Wake**: EDM sleeps quietly in the background without wasting CPU or battery. When you click a download, the extension wakes EDM instantly via Native Messaging.
- 🔒 **Private & Secure**: 100% of your data stays on your PC. No telemetry, no ads, no trackers, and parameterized loopback token authentication.
- 🎨 **Minimal Modern UI**: Sleek silver/dark theme dashboard with live task progression, speed graphs, pause/resume, and diagnostic health checks.

### Requirements:
- Windows 10 or Windows 11 (64-bit)
- EDM Desktop Application (v0.0.6 or newer)
```

---

## 3. Screenshot Checklist & Assets

All screenshots must be captured in 16:9 ratio (1280x800 or 1920x1080 PNG, RGB, no transparency).

| # | Asset Name | Dimensions | Description / Screen Content |
| :--- | :--- | :--- | :--- |
| 1 | `screenshot_1_dashboard.png` | 1280x800 | Extension popup live dashboard showing multi-part active downloads, speed badges, and pause/resume buttons. |
| 2 | `screenshot_2_link_grabber.png` | 1280x800 | Link Grabber tab scanning links on a media-heavy webpage, with filters and "Download All" button. |
| 3 | `screenshot_3_media_sniffer.png` | 1280x800 | Smart video/media sniffer overlay button on YouTube or video streaming player. |
| 4 | `screenshot_4_diagnostics.png` | 1280x800 | Settings & Diagnostics view showing HKCU registry checks, Native Host health, and Connected Extension ID. |
| 5 | `promo_tile_small.png` | 440x280 | EDM icon with high-contrast metallic wordmark on black backdrop (#000000). |
| 6 | `promo_tile_marquee.png` | 1400x560 | Hero banner displaying desktop app chassis alongside the browser extension popup. |

---

## 4. Single-Purpose & Policy Compliance Statements

- **Single Purpose:** The single purpose of the EDM extension is to hand off user-initiated download requests and detected page media links to the local EDM desktop application.
- **Privacy Policy URL:** `https://suveshmohandas.github.io/EDM/store/PRIVACY.html`
- **Support / Source URL:** `https://github.com/suveshmohandas/EDM`
