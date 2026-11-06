let isAltPressed = false;
window.addEventListener("keydown", (e) => {
  if ((e.key === "Alt" || e.key === "Shift") && !isAltPressed) {
    isAltPressed = true;
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {
    });
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt" || e.key === "Shift") {
    isAltPressed = false;
  }
});
window.addEventListener("click", (e) => {
  if (e.shiftKey || e.altKey) {
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {
    });
  }
}, true);
const detectedMediaMap = /* @__PURE__ */ new Map();
let isMediaReportPending = false;
function cleanMediaTitle(raw, fallbackUrl) {
  if (raw && raw.trim().length > 1) {
    return raw.trim().replace(/[\\/:*?"<>|]/g, "_");
  }
  try {
    const u = new URL(fallbackUrl);
    const lastPart = u.pathname.split("/").pop() || "media";
    return decodeURIComponent(lastPart).replace(/[\\/:*?"<>|]/g, "_");
  } catch {
    return document.title.replace(/[\\/:*?"<>|]/g, "_") || "media_file";
  }
}
function detectFormat(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "HLS (m3u8)";
  if (clean.endsWith(".mpd")) return "DASH (mpd)";
  if (clean.endsWith(".mp4")) return "MP4";
  if (clean.endsWith(".webm")) return "WebM";
  if (clean.endsWith(".mkv")) return "MKV";
  if (clean.endsWith(".mov")) return "MOV";
  if (clean.endsWith(".ts")) return "TS Stream";
  if (clean.endsWith(".mp3")) return "MP3 Audio";
  if (clean.endsWith(".flac")) return "FLAC";
  if (clean.endsWith(".wav")) return "WAV";
  if (clean.endsWith(".m4a")) return "M4A";
  if (clean.endsWith(".aac")) return "AAC";
  if (url.includes("blob:")) return "Media Stream (Blob)";
  return "Media";
}
function registerMedia(url, titleHint, type = "video", duration, quality) {
  if (!url || typeof url !== "string") return;
  if (url.startsWith("data:") || url.length < 8) return;
  if (detectedMediaMap.has(url)) return;
  const title = cleanMediaTitle(titleHint || document.title, url);
  const format = detectFormat(url);
  detectedMediaMap.set(url, {
    url,
    title,
    type,
    format,
    duration: duration && Number.isFinite(duration) ? Math.round(duration) : void 0,
    quality
  });
  scheduleMediaReport();
}
function scheduleMediaReport() {
  if (isMediaReportPending) return;
  isMediaReportPending = true;
  setTimeout(() => {
    isMediaReportPending = false;
    const mediaList = Array.from(detectedMediaMap.values());
    if (mediaList.length > 0) {
      chrome.runtime.sendMessage({
        action: "media_detected",
        media: mediaList
      }).catch(() => {
      });
    }
  }, 500);
}
function scanDOMForMedia() {
  document.querySelectorAll("video").forEach((video) => {
    let src = video.currentSrc || video.src;
    const title = video.getAttribute("title") || video.getAttribute("aria-label") || document.title;
    const quality = video.videoHeight ? `${video.videoHeight}p` : void 0;
    if (src && !src.startsWith("blob:")) {
      registerMedia(src, title, "video", video.duration, quality);
    }
    video.querySelectorAll("source").forEach((source) => {
      if (source.src && !source.src.startsWith("blob:")) {
        registerMedia(source.src, title, "video", video.duration, quality);
      }
    });
  });
  document.querySelectorAll("audio").forEach((audio) => {
    const src = audio.currentSrc || audio.src;
    const title = audio.getAttribute("title") || audio.getAttribute("aria-label") || document.title;
    if (src && !src.startsWith("blob:")) {
      registerMedia(src, title, "audio", audio.duration);
    }
    audio.querySelectorAll("source").forEach((source) => {
      if (source.src && !source.src.startsWith("blob:")) {
        registerMedia(source.src, title, "audio", audio.duration);
      }
    });
  });
  const mediaLinkRegex = /\.(mp4|mkv|webm|m3u8|mpd|mp3|flac|wav|aac|m4a|mov|avi|ts)(\?.*)?$/i;
  document.querySelectorAll("a[href]").forEach((link) => {
    const href = link.href;
    if (mediaLinkRegex.test(href)) {
      const isAudio = /\.(mp3|flac|wav|aac|m4a)(\?.*)?$/i.test(href);
      registerMedia(href, link.innerText || link.getAttribute("title") || document.title, isAudio ? "audio" : "video");
    }
  });
}
function cleanupFloatingBadges() {
  document.querySelectorAll(".edm-floating-media-badge").forEach((el) => el.remove());
}
cleanupFloatingBadges();
const mutationObserver = new MutationObserver(() => {
  scanDOMForMedia();
  injectYoutubePillIfNeeded();
});
mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true
});
let isYoutubePillEnabled = true;
chrome.storage.local.get("edm_youtube_pill_enabled", (res) => {
  if (res && res.edm_youtube_pill_enabled === false) {
    isYoutubePillEnabled = false;
    removeYoutubePill();
  } else {
    isYoutubePillEnabled = true;
    injectYoutubePillIfNeeded();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.edm_youtube_pill_enabled) {
    isYoutubePillEnabled = changes.edm_youtube_pill_enabled.newValue !== false;
    if (isYoutubePillEnabled) {
      injectYoutubePillIfNeeded();
    } else {
      removeYoutubePill();
    }
  }
});
window.addEventListener("DOMContentLoaded", () => {
  scanDOMForMedia();
  injectYoutubePillIfNeeded();
});
window.addEventListener("load", () => {
  scanDOMForMedia();
  injectYoutubePillIfNeeded();
});
setInterval(() => {
  scanDOMForMedia();
  injectYoutubePillIfNeeded();
}, 2500);
function removeYoutubePill() {
  document.querySelectorAll(".edm-yt-pill-wrapper").forEach((el) => el.remove());
}
function ensureYoutubeCustomStyles() {
  if (document.getElementById("edm-yt-styles")) return;
  const style = document.createElement("style");
  style.id = "edm-yt-styles";
  style.textContent = `
    #edm-yt-download-pill {
      position: relative !important;
      display: inline-flex !important;
      align-items: center !important;
      vertical-align: middle !important;
      margin-left: 10px !important;
      max-width: none !important;
    }

    #edm-yt-download-pill .edm-yt-dropdown-menu {
      position: absolute !important;
      top: 44px !important;
      left: 0 !important;
      z-index: 2147483647 !important;
      width: 310px !important;
      min-width: 310px !important;
      max-width: 310px !important;
      box-sizing: border-box !important;
      contain: paint layout !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      max-height: 460px !important;
      background: linear-gradient(180deg, #181c24 0%, #0d1017 100%) !important;
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      border-radius: 12px !important;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
      padding: 10px !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    }

    #edm-yt-download-pill .edm-yt-dropdown-menu::-webkit-scrollbar {
      width: 5px !important;
    }
    #edm-yt-download-pill .edm-yt-dropdown-menu::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.22) !important;
      border-radius: 4px !important;
    }

    #edm-yt-download-pill .edm-yt-header {
      width: 100% !important;
      max-width: 288px !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      padding: 4px 8px 8px 8px !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
      margin-bottom: 4px !important;
    }

    #edm-yt-download-pill .edm-yt-title-text {
      display: block !important;
      width: 100% !important;
      max-width: 284px !important;
      min-width: 0 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      line-height: 1.3 !important;
      box-sizing: border-box !important;
      cursor: default !important;
    }

    #edm-yt-download-pill .edm-yt-subtitle {
      font-size: 10px !important;
      color: #3b82f6 !important;
      font-weight: 600 !important;
      margin-top: 2px !important;
      display: block !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }

    #edm-yt-download-pill .edm-yt-sec-header {
      font-size: 9.5px !important;
      font-weight: 700 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
      color: #71717a !important;
      padding: 5px 8px 3px 8px !important;
      display: block !important;
      box-sizing: border-box !important;
    }

    #edm-yt-download-pill .edm-yt-menu-item {
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 7px 10px !important;
      border-radius: 7px !important;
      cursor: pointer !important;
      background: transparent !important;
      width: 100% !important;
      max-width: 288px !important;
      box-sizing: border-box !important;
      min-width: 0 !important;
      overflow: hidden !important;
      transition: background 0.15s ease, transform 0.1s ease !important;
    }

    #edm-yt-download-pill .edm-yt-menu-item:hover {
      background: rgba(59, 130, 246, 0.15) !important;
      transform: translateX(2px) !important;
    }

    #edm-yt-download-pill .edm-yt-item-text {
      flex: 1 1 0% !important;
      min-width: 0 !important;
      max-width: 228px !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    #edm-yt-download-pill .edm-yt-item-title {
      font-size: 12px !important;
      font-weight: 600 !important;
      color: #f4f4f5 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 228px !important;
      display: block !important;
      line-height: 1.3 !important;
    }

    #edm-yt-download-pill .edm-yt-item-subtitle {
      font-size: 10px !important;
      color: #8fa0be !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 228px !important;
      display: block !important;
      line-height: 1.2 !important;
      margin-top: 1px !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}
function formatBytes(bytes) {
  if (!bytes) return "";
  const n = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (!n || isNaN(n) || n <= 0) return "";
  if (n >= 1024 * 1024 * 1024) {
    return `~${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (n >= 1024 * 1024) {
    return `~${Math.round(n / (1024 * 1024))} MB`;
  }
  return `~${Math.round(n / 1024)} KB`;
}
let cachedStreamData = null;
function injectYoutubePillIfNeeded() {
  if (!isYoutubePillEnabled) return;
  const isYouTube = window.location.hostname.includes("youtube.com");
  if (!isYouTube) return;
  const isWatch = window.location.pathname === "/watch" || window.location.pathname.startsWith("/shorts");
  if (!isWatch) {
    removeYoutubePill();
    return;
  }
  const existing = document.getElementById("edm-yt-download-pill");
  if (existing && document.body.contains(existing)) {
    return;
  }
  const subscribeContainer = document.querySelector("#owner #subscribe-button") || document.querySelector("ytd-watch-metadata #owner #subscribe-button") || document.querySelector("#subscribe-button-shape") || document.querySelector("ytd-reel-player-header-renderer #subscribe-button") || document.querySelector("#actions #subscribe-button") || document.querySelector("#owner #sponsor-button") || document.querySelector("#owner ytd-button-renderer");
  if (!subscribeContainer || !subscribeContainer.parentElement) {
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.id = "edm-yt-download-pill";
  wrapper.className = "edm-yt-pill-wrapper";
  wrapper.style.display = "inline-flex";
  wrapper.style.alignItems = "center";
  wrapper.style.marginLeft = "10px";
  wrapper.style.verticalAlign = "middle";
  wrapper.style.position = "relative";
  wrapper.style.fontFamily = "Roboto, Arial, sans-serif";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "edm-yt-pill-btn";
  btn.style.height = "36px";
  btn.style.padding = "0 14px";
  btn.style.borderRadius = "18px";
  btn.style.background = "linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.04) 100%), #141414";
  btn.style.border = "1px solid rgba(255, 255, 255, 0.18)";
  btn.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 2px 6px rgba(0, 0, 0, 0.5)";
  btn.style.color = "#f1f1f1";
  btn.style.fontSize = "13px";
  btn.style.fontWeight = "600";
  btn.style.cursor = "pointer";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.gap = "7px";
  btn.style.transition = "all 0.15s cubic-bezier(0.16, 1, 0.3, 1)";
  btn.style.userSelect = "none";
  btn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    <span class="edm-yt-btn-label">Download</span>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity: 0.7; margin-left: 1px;">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "linear-gradient(180deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.06) 100%), #1e1e1e";
    btn.style.borderColor = "#3b82f6";
    btn.style.transform = "translateY(-1px)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.04) 100%), #141414";
    btn.style.borderColor = "rgba(255, 255, 255, 0.18)";
    btn.style.transform = "translateY(0)";
  });
  ensureYoutubeCustomStyles();
  const menu = document.createElement("div");
  menu.className = "edm-yt-dropdown-menu";
  menu.style.position = "absolute";
  menu.style.top = "44px";
  menu.style.left = "0";
  menu.style.zIndex = "2147483647";
  menu.style.setProperty("width", "310px", "important");
  menu.style.setProperty("min-width", "310px", "important");
  menu.style.setProperty("max-width", "310px", "important");
  menu.style.setProperty("box-sizing", "border-box", "important");
  menu.style.setProperty("contain", "paint layout", "important");
  menu.style.setProperty("overflow-x", "hidden", "important");
  menu.style.setProperty("overflow-y", "auto", "important");
  menu.style.setProperty("max-height", "460px", "important");
  menu.style.background = "linear-gradient(180deg, #181c24 0%, #0d1017 100%)";
  menu.style.border = "1px solid rgba(255, 255, 255, 0.16)";
  menu.style.borderRadius = "12px";
  menu.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.15)";
  menu.style.padding = "10px";
  menu.style.display = "none";
  menu.style.flexDirection = "column";
  menu.style.gap = "6px";
  menu.style.color = "#f4f4f5";
  menu.style.backdropFilter = "blur(14px)";
  function getCleanVideoTitle() {
    const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string") || document.querySelector("h1.title yt-formatted-string") || document.querySelector("#title h1");
    if (titleEl && titleEl.textContent && titleEl.textContent.trim().length > 1) {
      return titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, "_");
    }
    return document.title.replace(" - YouTube", "").trim().replace(/[\\/:*?"<>|]/g, "_") || "YouTube_Video";
  }
  function requestPageStreamData() {
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.source === window && event.data?.type === "EDM_STREAM_DATA_RESPONSE") {
          window.removeEventListener("message", handler);
          resolve(event.data.payload);
        }
      };
      window.addEventListener("message", handler);
      setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, 900);
      try {
        const script = document.createElement("script");
        script.textContent = `
          (function() {
            try {
              const player = document.getElementById('movie_player');
              let data = null;
              if (player && typeof player.getStreamingData === 'function') {
                data = player.getStreamingData();
              } else if (player && typeof player.getPlayerResponse === 'function') {
                data = player.getPlayerResponse()?.streamingData;
              } else if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.streamingData) {
                data = window.ytInitialPlayerResponse.streamingData;
              }
              window.postMessage({ type: 'EDM_STREAM_DATA_RESPONSE', payload: data }, '*');
            } catch (e) {
              window.postMessage({ type: 'EDM_STREAM_DATA_RESPONSE', payload: null }, '*');
            }
          })();
        `;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
      } catch {
        resolve(null);
      }
    });
  }
  async function triggerDownload(formatTag, customTitleSuffix, isAudio = false) {
    const title = getCleanVideoTitle();
    const ext = isAudio ? formatTag.includes("m4a") ? "m4a" : "mp3" : "mp4";
    const filename = `${title}${customTitleSuffix}.${ext}`;
    const label = btn.querySelector(".edm-yt-btn-label");
    if (label) {
      label.textContent = "Resolving...";
      label.style.color = "#60a5fa";
    }
    let downloadUrl = window.location.href.split("#")[0] + (formatTag ? "#" + formatTag : "");
    try {
      const streamData = cachedStreamData || await requestPageStreamData();
      if (streamData) {
        cachedStreamData = streamData;
        const formats = Array.isArray(streamData.formats) ? streamData.formats : [];
        const adaptive = Array.isArray(streamData.adaptiveFormats) ? streamData.adaptiveFormats : [];
        const all = [...formats, ...adaptive];
        if (isAudio) {
          const audioFormats = all.filter((f) => f.mimeType && f.mimeType.startsWith("audio/") && f.url);
          if (formatTag.includes("m4a")) {
            const m4a = audioFormats.find((f) => f.mimeType && f.mimeType.includes("mp4a"));
            if (m4a?.url) downloadUrl = m4a.url;
            else if (audioFormats[0]?.url) downloadUrl = audioFormats[0].url;
          } else if (audioFormats[0]?.url) {
            downloadUrl = audioFormats[0].url;
          }
        } else {
          if (formatTag === "720p" || formatTag === "480p" || !formatTag) {
            const muxed = formats.find(
              (f) => f.url && f.qualityLabel && (!formatTag || f.qualityLabel.includes(formatTag.replace("p", "")))
            );
            if (muxed?.url && !formatTag) {
              downloadUrl = muxed.url;
            }
          }
        }
      }
    } catch {
    }
    if (label) {
      label.textContent = "Sending...";
    }
    chrome.runtime.sendMessage(
      {
        action: "create_task",
        url: downloadUrl,
        filename,
        referrer: window.location.href
      },
      (resp) => {
        if (label) {
          if (resp && resp.ok) {
            label.textContent = "Added \u2713";
            label.style.color = "#34d399";
          } else {
            label.textContent = resp?.error || "Error";
            label.style.color = "#f87171";
          }
          setTimeout(() => {
            label.textContent = "Download";
            label.style.color = "";
          }, 2500);
        }
      }
    );
    menu.style.display = "none";
  }
  function createMenuItem(iconSvg, title, subtitle, onClick) {
    const item = document.createElement("div");
    item.className = "edm-yt-menu-item";
    item.style.setProperty("width", "100%", "important");
    item.style.setProperty("max-width", "288px", "important");
    item.style.setProperty("box-sizing", "border-box", "important");
    item.style.setProperty("min-width", "0", "important");
    item.style.setProperty("overflow", "hidden", "important");
    item.innerHTML = `
      <div style="width: 26px; height: 26px; border-radius: 6px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        ${iconSvg}
      </div>
      <div class="edm-yt-item-text" style="flex: 1 1 0%; min-width: 0; max-width: 228px; overflow: hidden; box-sizing: border-box;">
        <span class="edm-yt-item-title" title="${title}" style="display: block; font-size: 12px; font-weight: 600; color: #f4f4f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 228px;">${title}</span>
        <span class="edm-yt-item-subtitle" title="${subtitle}" style="display: block; font-size: 10px; color: #8fa0be; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 228px; margin-top: 1px;">${subtitle}</span>
      </div>
    `;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return item;
  }
  function renderMenuContent(streamData) {
    menu.innerHTML = "";
    const header = document.createElement("div");
    header.className = "edm-yt-header";
    header.style.setProperty("width", "100%", "important");
    header.style.setProperty("max-width", "288px", "important");
    header.style.setProperty("box-sizing", "border-box", "important");
    header.style.setProperty("overflow", "hidden", "important");
    const rawTitle = getCleanVideoTitle();
    const titleEl = document.createElement("div");
    titleEl.className = "edm-yt-title-text";
    titleEl.style.setProperty("width", "100%", "important");
    titleEl.style.setProperty("max-width", "284px", "important");
    titleEl.style.setProperty("min-width", "0", "important");
    titleEl.style.setProperty("white-space", "nowrap", "important");
    titleEl.style.setProperty("overflow", "hidden", "important");
    titleEl.style.setProperty("text-overflow", "ellipsis", "important");
    titleEl.textContent = rawTitle;
    titleEl.title = rawTitle;
    header.appendChild(titleEl);
    const subEl = document.createElement("div");
    subEl.className = "edm-yt-subtitle";
    subEl.textContent = "EDM Adaptive Engine";
    header.appendChild(subEl);
    menu.appendChild(header);
    const videoSecTitle = document.createElement("div");
    videoSecTitle.className = "edm-yt-sec-header";
    videoSecTitle.textContent = "Video Qualities";
    menu.appendChild(videoSecTitle);
    const videoIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><rect x="2" y="2" width="20" height="20" rx="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line></svg>`;
    menu.appendChild(
      createMenuItem(videoIcon, "Best Available Quality", "Auto-select maximum resolution + audio", () => {
        triggerDownload("", "");
      })
    );
    const formats = streamData && Array.isArray(streamData.formats) ? streamData.formats : [];
    const adaptive = streamData && Array.isArray(streamData.adaptiveFormats) ? streamData.adaptiveFormats : [];
    const allFormats = [...formats, ...adaptive];
    const findFormat = (predicate) => allFormats.filter(predicate).pop();
    const f2160 = findFormat((f) => f.height >= 2160 || f.qualityLabel && f.qualityLabel.includes("2160"));
    if (f2160) {
      const sizeStr = formatBytes(f2160.contentLength);
      const sub = sizeStr ? `Ultra-crisp 2160p (${sizeStr})` : "Ultra-crisp 2160p MP4 (Max detail)";
      menu.appendChild(
        createMenuItem(videoIcon, "4K Ultra HD (2160p)", sub, () => {
          triggerDownload("2160p", " [2160p 4K]");
        })
      );
    }
    const f1440 = findFormat((f) => f.height >= 1440 && f.height < 2160 || f.qualityLabel && f.qualityLabel.includes("1440"));
    if (f1440) {
      const sizeStr = formatBytes(f1440.contentLength);
      const sub = sizeStr ? `Quad HD 1440p (${sizeStr})` : "High-res 1440p MP4 (Sharp detail)";
      menu.appendChild(
        createMenuItem(videoIcon, "2K Quad HD (1440p)", sub, () => {
          triggerDownload("1440p", " [1440p 2K]");
        })
      );
    }
    const f1080 = findFormat((f) => f.height >= 1080 && f.height < 1440 || f.qualityLabel && f.qualityLabel.includes("1080"));
    if (f1080 || !streamData) {
      const sizeStr = f1080 ? formatBytes(f1080.contentLength) : "";
      const sub = sizeStr ? `Crisp 1080p MP4 (${sizeStr})` : "Crisp 1080p MP4 with merged audio";
      menu.appendChild(
        createMenuItem(videoIcon, "1080p Full HD", sub, () => {
          triggerDownload("1080p", " [1080p]");
        })
      );
    }
    const f720 = findFormat((f) => f.height >= 720 && f.height < 1080 || f.qualityLabel && f.qualityLabel.includes("720"));
    if (f720 || !streamData) {
      const sizeStr = f720 ? formatBytes(f720.contentLength) : "";
      const sub = sizeStr ? `Standard 720p MP4 (${sizeStr})` : "Standard 720p MP4 (Fast download)";
      menu.appendChild(
        createMenuItem(videoIcon, "720p HD", sub, () => {
          triggerDownload("720p", " [720p]");
        })
      );
    }
    const f480 = findFormat((f) => f.height >= 360 && f.height < 720 || f.qualityLabel && (f.qualityLabel.includes("480") || f.qualityLabel.includes("360")));
    if (f480 || !streamData) {
      const sizeStr = f480 ? formatBytes(f480.contentLength) : "";
      const sub = sizeStr ? `Compressed MP4 (${sizeStr})` : "Compressed MP4 (Data saver)";
      menu.appendChild(
        createMenuItem(videoIcon, "480p / 360p", sub, () => {
          triggerDownload("480p", " [480p]");
        })
      );
    }
    const audioSecTitle = document.createElement("div");
    audioSecTitle.className = "edm-yt-sec-header";
    audioSecTitle.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
    audioSecTitle.style.marginTop = "4px";
    audioSecTitle.textContent = "Audio Only";
    menu.appendChild(audioSecTitle);
    const audioIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    const audioStreams = allFormats.filter((f) => f.mimeType && f.mimeType.startsWith("audio/"));
    const m4aStream = audioStreams.find((f) => f.mimeType && f.mimeType.includes("mp4a"));
    const bestAudio = audioStreams[0];
    const mp3Size = formatBytes(bestAudio?.contentLength);
    const m4aSize = formatBytes(m4aStream?.contentLength || bestAudio?.contentLength);
    menu.appendChild(
      createMenuItem(audioIcon, "Extract Audio (MP3)", mp3Size ? `Universal MP3 stream (${mp3Size})` : "Universal MP3 at highest bitrate", () => {
        triggerDownload("audio", "", true);
      })
    );
    menu.appendChild(
      createMenuItem(audioIcon, "Extract Audio (M4A)", m4aSize ? `Original AAC sound stream (${m4aSize})` : "Original AAC/M4A sound stream", () => {
        triggerDownload("audio#m4a", "", true);
      })
    );
  }
  async function updateMenuWithStreamingData() {
    try {
      const data = await requestPageStreamData();
      if (data) {
        cachedStreamData = data;
        if (menu.style.display === "flex") {
          renderMenuContent(data);
        }
      }
    } catch {
    }
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (menu.style.display === "none" || !menu.style.display) {
      renderMenuContent(cachedStreamData);
      menu.style.display = "flex";
      updateMenuWithStreamingData();
    } else {
      menu.style.display = "none";
    }
  });
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "linear-gradient(180deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.06) 100%), #1e1e1e";
    btn.style.borderColor = "#3b82f6";
    btn.style.transform = "translateY(-1px)";
    if (!cachedStreamData) {
      requestPageStreamData().then((data) => {
        if (data) cachedStreamData = data;
      }).catch(() => {
      });
    }
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.04) 100%), #141414";
    btn.style.borderColor = "rgba(255, 255, 255, 0.18)";
    btn.style.transform = "translateY(0)";
  });
  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) {
      menu.style.display = "none";
    }
  });
  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  subscribeContainer.insertAdjacentElement("afterend", wrapper);
}
window.addEventListener("yt-navigate-finish", () => {
  cleanupFloatingBadges();
  cachedStreamData = null;
  setTimeout(injectYoutubePillIfNeeded, 700);
});
window.addEventListener("yt-page-data-updated", () => {
  cleanupFloatingBadges();
  cachedStreamData = null;
  setTimeout(injectYoutubePillIfNeeded, 500);
});
window.addEventListener("popstate", () => {
  if (window.location.hostname.includes("youtube.com")) {
    cleanupFloatingBadges();
    cachedStreamData = null;
    setTimeout(injectYoutubePillIfNeeded, 500);
  }
});
