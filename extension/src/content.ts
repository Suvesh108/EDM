// EDM Content Script — Media Sniffer, Floating Video Overlay & Bypass Coordinator

// 1. Download Interception Bypass Coordinator (Alt / Shift Key)
let isAltPressed = false;

window.addEventListener("keydown", (e) => {
  if ((e.key === "Alt" || e.key === "Shift") && !isAltPressed) {
    isAltPressed = true;
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {});
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "Alt" || e.key === "Shift") {
    isAltPressed = false;
  }
});

window.addEventListener("click", (e) => {
  if (e.shiftKey || e.altKey) {
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {});
  }
}, true);

// 2. Media Sniffer Data Structures
export interface DetectedMedia {
  url: string;
  title: string;
  type: "video" | "audio" | "stream";
  format?: string;
  duration?: number;
  quality?: string;
}

const detectedMediaMap = new Map<string, DetectedMedia>();
let isMediaReportPending = false;

function cleanMediaTitle(raw: string | null | undefined, fallbackUrl: string): string {
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

function detectFormat(url: string): string {
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

function registerMedia(url: string, titleHint?: string, type: "video" | "audio" | "stream" = "video", duration?: number, quality?: string) {
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
    duration: duration && Number.isFinite(duration) ? Math.round(duration) : undefined,
    quality,
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
        media: mediaList,
      }).catch(() => {});
    }
  }, 500);
}

// 3. Scan DOM for Media Elements and Streaming Sources
function scanDOMForMedia() {
  // A. Scan <video> elements
  document.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
    let src = video.currentSrc || video.src;
    const title = video.getAttribute("title") || video.getAttribute("aria-label") || document.title;
    const quality = video.videoHeight ? `${video.videoHeight}p` : undefined;

    if (src && !src.startsWith("blob:")) {
      registerMedia(src, title, "video", video.duration, quality);
    }

    // Inspect child <source> elements
    video.querySelectorAll<HTMLSourceElement>("source").forEach((source) => {
      if (source.src && !source.src.startsWith("blob:")) {
        registerMedia(source.src, title, "video", video.duration, quality);
      }
    });

    // Video player overlay: Strictly disabled on YouTube watch pages & SPA navigations
    // Enabled on all other general websites
    const isYouTube = window.location.hostname.includes("youtube.com");
    if (!isYouTube) {
      attachVideoOverlay(video);
    }
  });

  // B. Scan <audio> elements
  document.querySelectorAll<HTMLAudioElement>("audio").forEach((audio) => {
    const src = audio.currentSrc || audio.src;
    const title = audio.getAttribute("title") || audio.getAttribute("aria-label") || document.title;
    if (src && !src.startsWith("blob:")) {
      registerMedia(src, title, "audio", audio.duration);
    }
    audio.querySelectorAll<HTMLSourceElement>("source").forEach((source) => {
      if (source.src && !source.src.startsWith("blob:")) {
        registerMedia(source.src, title, "audio", audio.duration);
      }
    });
  });

  // C. Scan <a> links that directly point to media
  const mediaLinkRegex = /\.(mp4|mkv|webm|m3u8|mpd|mp3|flac|wav|aac|m4a|mov|avi|ts)(\?.*)?$/i;
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    const href = link.href;
    if (mediaLinkRegex.test(href)) {
      const isAudio = /\.(mp3|flac|wav|aac|m4a)(\?.*)?$/i.test(href);
      registerMedia(href, link.innerText || link.getAttribute("title") || document.title, isAudio ? "audio" : "video");
    }
  });
}

// 4. Floating "Download with EDM" Overlay for Non-YouTube Video Players
const attachedVideos = new WeakSet<HTMLVideoElement>();

function cleanupFloatingBadges() {
  document.querySelectorAll(".edm-floating-media-badge").forEach((el) => el.remove());
}
cleanupFloatingBadges();

function attachVideoOverlay(video: HTMLVideoElement) {
  // Absolute Invariant: Completely disabled on YouTube (overlay redundant with Subscribe pill)
  if (window.location.hostname.includes("youtube.com")) {
    cleanupFloatingBadges();
    return;
  }

  if (attachedVideos.has(video)) return;
  attachedVideos.add(video);

  let overlay: HTMLDivElement | null = null;
  let hideTimeout: any = null;

  function ensureOverlay(): HTMLDivElement {
    if (overlay && document.body.contains(overlay)) return overlay;

    overlay = document.createElement("div");
    overlay.className = "edm-floating-media-badge";
    overlay.style.position = "absolute";
    overlay.style.zIndex = "2147483647";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.gap = "8px";
    overlay.style.padding = "7px 12px";
    overlay.style.background = "linear-gradient(180deg, #181c24 0%, #0d1017 100%)";
    overlay.style.border = "1px solid rgba(255, 255, 255, 0.15)";
    overlay.style.borderRadius = "8px";
    overlay.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.15)";
    overlay.style.color = "#ffffff";
    overlay.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    overlay.style.fontSize = "12px";
    overlay.style.fontWeight = "600";
    overlay.style.cursor = "pointer";
    overlay.style.userSelect = "none";
    overlay.style.transition = "all 0.18s cubic-bezier(0.16, 1, 0.3, 1)";
    overlay.style.pointerEvents = "auto";

    overlay.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span class="edm-badge-label" style="letter-spacing: 0.02em;">Download with EDM</span>
    `;

    overlay.addEventListener("mouseenter", () => {
      if (overlay) {
        overlay.style.background = "linear-gradient(180deg, #222834 0%, #11151f 100%)";
        overlay.style.borderColor = "#3b82f6";
        overlay.style.transform = "scale(1.03)";
      }
    });

    overlay.addEventListener("mouseleave", () => {
      if (overlay) {
        overlay.style.background = "linear-gradient(180deg, #181c24 0%, #0d1017 100%)";
        overlay.style.borderColor = "rgba(255, 255, 255, 0.15)";
        overlay.style.transform = "scale(1.0)";
      }
    });

    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();

      const targetSrc = video.currentSrc || video.src || window.location.href;
      const label = overlay?.querySelector(".edm-badge-label") as HTMLSpanElement;
      if (label) {
        label.textContent = "Sending to EDM...";
        label.style.color = "#60a5fa";
      }

      chrome.runtime.sendMessage(
        {
          action: "create_task",
          url: targetSrc,
          filename: cleanMediaTitle(video.getAttribute("title") || document.title, targetSrc),
          referrer: window.location.href,
        },
        (resp) => {
          if (label) {
            if (resp && resp.ok) {
              label.textContent = "Added to EDM ✓";
              label.style.color = "#34d399";
            } else {
              label.textContent = resp?.error || "Error adding";
              label.style.color = "#f87171";
            }
            setTimeout(() => {
              if (label) {
                label.textContent = "Download with EDM";
                label.style.color = "#ffffff";
              }
            }, 2500);
          }
        }
      );
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function updatePosition() {
    if (!overlay || !document.body.contains(video)) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80 || rect.top > window.innerHeight || rect.bottom < 0) {
      overlay.style.display = "none";
      return;
    }
    const top = Math.max(8, rect.top + window.scrollY + 12);
    const left = rect.left + window.scrollX + rect.width - (overlay.offsetWidth || 170) - 14;
    overlay.style.top = `${top}px`;
    overlay.style.left = `${Math.max(10, left)}px`;
    overlay.style.display = "inline-flex";
  }

  function showOverlay() {
    ensureOverlay();
    updatePosition();
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (overlay && !overlay.matches(":hover")) {
        overlay.style.display = "none";
      }
    }, 4000);
  }

  video.addEventListener("mouseenter", showOverlay);
  video.addEventListener("play", showOverlay);
  video.addEventListener("mousemove", showOverlay);
  video.addEventListener("mouseleave", () => {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (overlay && !overlay.matches(":hover")) {
        overlay.style.display = "none";
      }
    }, 1500);
  });
}

// 5. Observers & Lifecycle Triggers
const mutationObserver = new MutationObserver(() => {
  scanDOMForMedia();
  injectYoutubePillIfNeeded();
});

mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// ─────────────────────────────────────────────────────────────
// 6. YOUTUBE QUICK DOWNLOAD PILL (NEXT TO SUBSCRIBE BUTTON)
// ─────────────────────────────────────────────────────────────
let isYoutubePillEnabled = true;

// Load user preference for YouTube pill
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

function injectYoutubePillIfNeeded() {
  if (!isYoutubePillEnabled) return;
  const isYouTube = window.location.hostname.includes("youtube.com");
  if (!isYouTube) return;

  const isWatch = window.location.pathname === "/watch" || window.location.pathname.startsWith("/shorts");
  if (!isWatch) {
    removeYoutubePill();
    return;
  }

  // Check if pill already exists on page and is still connected
  const existing = document.getElementById("edm-yt-download-pill");
  if (existing && document.body.contains(existing)) {
    return;
  }

  // Find Subscribe button container on watch page or shorts
  const subscribeContainer =
    document.querySelector("#owner #subscribe-button") ||
    document.querySelector("ytd-watch-metadata #owner #subscribe-button") ||
    document.querySelector("#subscribe-button-shape") ||
    document.querySelector("ytd-reel-player-header-renderer #subscribe-button") ||
    document.querySelector("#actions #subscribe-button") ||
    document.querySelector("#owner #sponsor-button") ||
    document.querySelector("#owner ytd-button-renderer");

  if (!subscribeContainer || !subscribeContainer.parentElement) {
    return;
  }

  // Create wrapper
  const wrapper = document.createElement("div");
  wrapper.id = "edm-yt-download-pill";
  wrapper.className = "edm-yt-pill-wrapper";
  wrapper.style.display = "inline-flex";
  wrapper.style.alignItems = "center";
  wrapper.style.marginLeft = "10px";
  wrapper.style.verticalAlign = "middle";
  wrapper.style.position = "relative";
  wrapper.style.fontFamily = "Roboto, Arial, sans-serif";

  // Create button
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

  // Dropdown menu (Compact fixed width matching reference ~320px)
  const menu = document.createElement("div");
  menu.className = "edm-yt-dropdown-menu";
  menu.style.position = "absolute";
  menu.style.top = "44px";
  menu.style.left = "0";
  menu.style.zIndex = "2147483647";
  menu.style.width = "320px";
  menu.style.maxWidth = "320px";
  menu.style.minWidth = "320px";
  menu.style.setProperty("width", "320px", "important");
  menu.style.setProperty("max-width", "320px", "important");
  menu.style.setProperty("min-width", "320px", "important");
  menu.style.boxSizing = "border-box";
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
  menu.style.overflow = "hidden";

  function getCleanVideoTitle(): string {
    const titleEl =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("h1.title yt-formatted-string") ||
      document.querySelector("#title h1");
    if (titleEl && titleEl.textContent && titleEl.textContent.trim().length > 1) {
      return titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, "_");
    }
    return document.title.replace(" - YouTube", "").trim().replace(/[\\/:*?"<>|]/g, "_") || "YouTube_Video";
  }

  function triggerDownload(formatTag: string, customTitleSuffix: string, isAudio = false) {
    const title = getCleanVideoTitle();
    const downloadUrl = window.location.href + (formatTag ? "#" + formatTag : "");
    const ext = isAudio ? (formatTag.includes("m4a") ? "m4a" : "mp3") : "mp4";
    const filename = `${title}${customTitleSuffix}.${ext}`;

    const label = btn.querySelector(".edm-yt-btn-label") as HTMLSpanElement;
    if (label) {
      label.textContent = "Sending...";
      label.style.color = "#60a5fa";
    }

    chrome.runtime.sendMessage(
      {
        action: "create_task",
        url: downloadUrl,
        filename,
        referrer: window.location.href,
      },
      (resp) => {
        if (label) {
          if (resp && resp.ok) {
            label.textContent = "Added ✓";
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

  function createMenuItem(iconSvg: string, title: string, subtitle: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "10px";
    item.style.padding = "7px 10px";
    item.style.borderRadius = "7px";
    item.style.cursor = "pointer";
    item.style.transition = "background 0.15s ease, transform 0.1s ease";
    item.style.background = "transparent";
    item.style.width = "100%";
    item.style.boxSizing = "border-box";
    item.style.minWidth = "0";
    item.style.overflow = "hidden";

    item.innerHTML = `
      <div style="width: 26px; height: 26px; border-radius: 6px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        ${iconSvg}
      </div>
      <div style="flex: 1; min-width: 0; overflow: hidden;">
        <div style="font-size: 12px; font-weight: 600; color: #f4f4f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</div>
        <div style="font-size: 10px; color: #8fa0be; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${subtitle}</div>
      </div>
    `;

    item.addEventListener("mouseenter", () => {
      item.style.background = "rgba(59, 130, 246, 0.15)";
      item.style.transform = "translateX(2px)";
    });

    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
      item.style.transform = "translateX(0)";
    });

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });

    return item;
  }

  function renderMenuContent() {
    menu.innerHTML = "";

    // Header (Compact layout strictly within 320px container)
    const header = document.createElement("div");
    header.style.padding = "4px 8px 8px 8px";
    header.style.borderBottom = "1px solid rgba(255, 255, 255, 0.1)";
    header.style.marginBottom = "4px";
    header.style.width = "100%";
    header.style.maxWidth = "100%";
    header.style.boxSizing = "border-box";
    header.style.minWidth = "0";
    header.style.overflow = "hidden";

    const titleEl = document.createElement("div");
    titleEl.style.fontSize = "12px";
    titleEl.style.fontWeight = "700";
    titleEl.style.color = "#ffffff";
    titleEl.style.whiteSpace = "nowrap";
    titleEl.style.overflow = "hidden";
    titleEl.style.textOverflow = "ellipsis";
    titleEl.style.width = "100%";
    titleEl.style.maxWidth = "296px";
    titleEl.style.minWidth = "0";
    titleEl.style.boxSizing = "border-box";
    titleEl.style.display = "block";
    titleEl.textContent = getCleanVideoTitle();
    header.appendChild(titleEl);

    const subEl = document.createElement("div");
    subEl.style.fontSize = "10px";
    subEl.style.color = "#3b82f6";
    subEl.style.fontWeight = "600";
    subEl.style.marginTop = "2px";
    subEl.textContent = "EDM Adaptive Engine";
    header.appendChild(subEl);

    menu.appendChild(header);

    // Section 1: Video Qualities
    const videoSecTitle = document.createElement("div");
    videoSecTitle.style.fontSize = "9.5px";
    videoSecTitle.style.fontWeight = "700";
    videoSecTitle.style.textTransform = "uppercase";
    videoSecTitle.style.letterSpacing = "0.05em";
    videoSecTitle.style.color = "#71717a";
    videoSecTitle.style.padding = "4px 8px 2px 8px";
    videoSecTitle.textContent = "Video Qualities";
    menu.appendChild(videoSecTitle);

    const videoIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><rect x="2" y="2" width="20" height="20" rx="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line></svg>`;

    menu.appendChild(
      createMenuItem(videoIcon, "Best Available Quality", "Auto-select maximum resolution + audio", () => {
        triggerDownload("", "");
      })
    );

    menu.appendChild(
      createMenuItem(videoIcon, "1080p Full HD", "Crisp 1080p MP4 with merged audio", () => {
        triggerDownload("1080p", " [1080p]");
      })
    );

    menu.appendChild(
      createMenuItem(videoIcon, "720p HD", "Standard 720p MP4 (Fast download)", () => {
        triggerDownload("720p", " [720p]");
      })
    );

    menu.appendChild(
      createMenuItem(videoIcon, "480p / 360p", "Compressed MP4 (Data saver)", () => {
        triggerDownload("480p", " [480p]");
      })
    );

    // Section 2: Audio Only
    const audioSecTitle = document.createElement("div");
    audioSecTitle.style.fontSize = "9.5px";
    audioSecTitle.style.fontWeight = "700";
    audioSecTitle.style.textTransform = "uppercase";
    audioSecTitle.style.letterSpacing = "0.05em";
    audioSecTitle.style.color = "#71717a";
    audioSecTitle.style.padding = "6px 8px 2px 8px";
    audioSecTitle.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
    audioSecTitle.style.marginTop = "4px";
    audioSecTitle.textContent = "Audio Only";
    menu.appendChild(audioSecTitle);

    const audioIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;

    menu.appendChild(
      createMenuItem(audioIcon, "Extract Audio (MP3)", "Universal MP3 at highest bitrate", () => {
        triggerDownload("audio", "", true);
      })
    );

    menu.appendChild(
      createMenuItem(audioIcon, "Extract Audio (M4A)", "Original AAC/M4A sound stream", () => {
        triggerDownload("audio#m4a", "", true);
      })
    );
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (menu.style.display === "none" || !menu.style.display) {
      renderMenuContent();
      menu.style.display = "flex";
    } else {
      menu.style.display = "none";
    }
  });

  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target as Node)) {
      menu.style.display = "none";
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);

  // Insert right after Subscribe button
  subscribeContainer.insertAdjacentElement("afterend", wrapper);
}

// Watch navigation events in YouTube SPA
window.addEventListener("yt-navigate-finish", () => {
  cleanupFloatingBadges();
  setTimeout(injectYoutubePillIfNeeded, 700);
});
window.addEventListener("yt-page-data-updated", () => {
  cleanupFloatingBadges();
  setTimeout(injectYoutubePillIfNeeded, 500);
});
window.addEventListener("popstate", () => {
  if (window.location.hostname.includes("youtube.com")) {
    cleanupFloatingBadges();
    setTimeout(injectYoutubePillIfNeeded, 500);
  }
});

