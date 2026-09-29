# ⚡ Vortex Downloader - Browser Extension (Manifest V3)

The official browser companion extension for **Vortex Downloader**. 

Provides automatic media sniffing (YouTube, HLS/m3u8, HTML5 videos, direct streams), IDM-style download interception, a floating hover download button over videos, and right-click context menu integration.

---

### Features

1. **Active Page Media Sniffer**: Automatically detects streaming video and audio files on any web page (MP4, WebM, M3U8, DASH, AAC, MP3) with one-click download buttons.
2. **Floating Video Badge**: Hover over any HTML5 video to get a sleek, non-intrusive "⚡ Vortex Download" button.
3. **Download Interception**: Optional toggle to automatically intercept standard browser file downloads and accelerate them via Vortex Downloader's 16-connection chunking engine.
4. **Context Menu Actions**: Right-click any link, video, audio, or image $\rightarrow$ "⚡ Download with Vortex Downloader".
5. **Direct Backend & Aria2 RPC Sync**: Communicates directly with the local Vortex Downloader Engine (`http://localhost:8000`) and Aria2 JSON-RPC endpoint.

---

### How to Install (Chrome / Edge / Brave / Opera)

1. Open your browser and navigate to the Extensions management page:
   - **Google Chrome**: `chrome://extensions`
   - **Microsoft Edge**: `edge://extensions`
   - **Brave**: `brave://extensions`
2. Enable **Developer mode** (toggle located at the top-right corner).
3. Click the **Load unpacked** button.
4. Select this directory:
   ```
   c:\Users\Suvesh\Desktop\projects\vortexdownloader\extension
   ```
5. The **Vortex Downloader** icon will appear in your browser toolbar! Click the extension icon to start sniffing and downloading media.
