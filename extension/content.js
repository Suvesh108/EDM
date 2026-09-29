/**
 * Vortex Downloader - Page Content Script
 * Sniffs video elements, audio streams, HLS playlists, and injects interactive download hooks.
 */

// Sniff all media resources currently on page
function sniffMediaResources() {
  const mediaList = [];
  const seenUrls = new Set();

  function addMedia(url, type, title, resolution) {
    if (!url || seenUrls.has(url) || url.startsWith("data:") || url.startsWith("blob:")) return;
    seenUrls.add(url);
    mediaList.push({
      url,
      type: type || "VIDEO",
      title: title || document.title || "Web Media",
      resolution: resolution || "Adaptive Stream"
    });
  }

  // 1. YouTube specific detection
  if (window.location.hostname.includes("youtube.com") || window.location.hostname.includes("youtu.be")) {
    const videoTitle = document.querySelector("h1.ytd-watch-metadata")?.innerText || document.title;
    addMedia(window.location.href, "YOUTUBE", videoTitle, "Adaptive 4K/2K/1080p");
  }

  // 2. Scan <video> elements
  const videos = document.querySelectorAll("video");
  videos.forEach((v, index) => {
    const src = v.currentSrc || v.src;
    if (src) {
      const res = v.videoWidth && v.videoHeight ? `${v.videoWidth}x${v.videoHeight}` : "Video Stream";
      addMedia(src, "VIDEO", `${document.title} (Video ${index + 1})`, res);
    }

    const sources = v.querySelectorAll("source");
    sources.forEach((s) => {
      if (s.src) {
        addMedia(s.src, "VIDEO", document.title, s.type || "Video");
      }
    });
  });

  // 3. Scan <audio> elements
  const audios = document.querySelectorAll("audio");
  audios.forEach((a, index) => {
    const src = a.currentSrc || a.src;
    if (src) {
      addMedia(src, "AUDIO", `${document.title} (Audio ${index + 1})`, "Audio Stream");
    }
  });

  // 4. Scan performance / resource timings for .m3u8, .mpd, .mp4
  try {
    const entries = performance.getEntriesByType("resource");
    entries.forEach((e) => {
      const name = e.name;
      if (name.includes(".m3u8") || name.includes(".mpd") || name.match(/\.(mp4|webm|m4a|mp3)(\?.*)?$/i)) {
        const isHls = name.includes(".m3u8");
        const isDash = name.includes(".mpd");
        const type = isHls ? "M3U8" : isDash ? "DASH" : "STREAM";
        const label = name.split("/").pop().split("?")[0] || "Stream";
        addMedia(name, type, label, isHls ? "HLS Master Playlist" : "Direct Stream");
      }
    });
  } catch (_) {}

  return mediaList;
}

// Inject floating "⚡ Vortex Download" button over HTML5 videos
function injectFloatingButtons() {
  chrome.storage.sync.get("showFloatingButton", ({ showFloatingButton }) => {
    if (showFloatingButton === false) return;

    const videos = document.querySelectorAll("video:not([data-vortex-hooked])");
    videos.forEach((video) => {
      video.setAttribute("data-vortex-hooked", "true");

      const wrapper = video.parentElement;
      if (!wrapper || window.getComputedStyle(wrapper).position === "static") {
        if (wrapper) wrapper.style.position = "relative";
      }

      const btn = document.createElement("button");
      btn.className = "vortex-floating-btn";
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Vortex Download</span>
      `;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetUrl = video.currentSrc || video.src || window.location.href;
        chrome.runtime.sendMessage({
          action: "download_stream",
          url: targetUrl,
          title: document.title
        });
      });

      if (wrapper) {
        wrapper.appendChild(btn);
      }
    });
  });
}

// Initialize observer for dynamically inserted videos (SPA / YouTube / Netflix / Twitter)
const observer = new MutationObserver(() => {
  injectFloatingButtons();
});
observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
injectFloatingButtons();

// Respond to popup sniffer requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "sniff_page_media") {
    sendResponse({ media: sniffMediaResources() });
  }
});
