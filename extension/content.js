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
function sniffResources() {
  const resources = [];
  const seenUrls = /* @__PURE__ */ new Set();
  function add(url, title, type, format, size) {
    try {
      const absUrl = new URL(url, window.location.href).href;
      if (!absUrl.startsWith("http")) return;
      if (seenUrls.has(absUrl)) return;
      seenUrls.add(absUrl);
      resources.push({
        url: absUrl,
        title: title.trim() || absUrl.split("/").pop()?.split("?")[0] || "Resource",
        type,
        format: format.toUpperCase(),
        size
      });
    } catch {
    }
  }
  document.querySelectorAll("video, audio").forEach((media) => {
    const el = media;
    const src = el.src || el.currentSrc;
    const isVideo = el.tagName.toLowerCase() === "video";
    const type = isVideo ? "video" : "audio";
    if (src) {
      const ext = src.split(".").pop()?.split("?")[0] || (isVideo ? "mp4" : "mp3");
      add(src, document.title || (isVideo ? "Web Video" : "Audio Track"), type, ext);
    }
    el.querySelectorAll("source").forEach((source) => {
      const sSrc = source.src;
      const mime = source.type || "";
      if (sSrc) {
        const ext = sSrc.split(".").pop()?.split("?")[0] || (mime.includes("video") ? "mp4" : "media");
        add(sSrc, document.title || "Stream Source", type, ext);
      }
    });
  });
  const interestingExtensions = {
    mp4: "video",
    mkv: "video",
    webm: "video",
    mov: "video",
    avi: "video",
    m3u8: "stream",
    mpd: "stream",
    mp3: "audio",
    flac: "audio",
    wav: "audio",
    m4a: "audio",
    zip: "archive",
    rar: "archive",
    "7z": "archive",
    tar: "archive",
    gz: "archive",
    iso: "archive",
    pdf: "document",
    docx: "document",
    xlsx: "document",
    exe: "executable",
    msi: "executable",
    dmg: "executable",
    apk: "executable"
  };
  document.querySelectorAll("a[href]").forEach((link) => {
    const a = link;
    const href = a.href;
    try {
      const urlObj = new URL(href, window.location.href);
      const pathname = urlObj.pathname.toLowerCase();
      for (const [ext, type] of Object.entries(interestingExtensions)) {
        if (pathname.endsWith(`.${ext}`) || pathname.includes(`.${ext}?`)) {
          const text = a.innerText.trim() || a.getAttribute("download") || a.title || urlObj.pathname.split("/").pop() || "Download";
          add(href, text, type, ext);
          break;
        }
      }
    } catch {
    }
  });
  return resources;
}
function sniffImages() {
  const images = [];
  const seenUrls = /* @__PURE__ */ new Set();
  document.querySelectorAll("img").forEach((img) => {
    try {
      const src = img.src || img.currentSrc || img.getAttribute("data-src") || "";
      if (!src) return;
      const absUrl = new URL(src, window.location.href).href;
      if (!absUrl.startsWith("http")) return;
      if (seenUrls.has(absUrl)) return;
      const width = img.naturalWidth || img.clientWidth || 0;
      const height = img.naturalHeight || img.clientHeight || 0;
      if (width > 0 && width < 32 && height > 0 && height < 32) return;
      seenUrls.add(absUrl);
      const ext = absUrl.split("/").pop()?.split("?")[0]?.split(".").pop()?.toUpperCase() || "IMAGE";
      images.push({
        url: absUrl,
        alt: img.alt || img.title || absUrl.split("/").pop()?.split("?")[0] || "Page Image",
        width: width || 400,
        height: height || 300,
        format: ext.length <= 4 ? ext : "IMG"
      });
    } catch {
    }
  });
  return images.slice(0, 60);
}
function injectFloatingMediaButton() {
  const hostDomain = window.location.hostname;
  chrome.storage.local.get(["disabled_video_domains", "disable_floating_button"], (res) => {
    if (res.disable_floating_button) return;
    const disabledList = res.disabled_video_domains || [];
    if (disabledList.includes(hostDomain)) return;
    const videos = document.querySelectorAll("video, audio");
    if (videos.length === 0) return;
    if (document.getElementById("edm-video-sniffer-host")) return;
    const hostEl = document.createElement("div");
    hostEl.id = "edm-video-sniffer-host";
    hostEl.style.position = "fixed";
    hostEl.style.bottom = "24px";
    hostEl.style.right = "24px";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);
    const shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .edm-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(12px);
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 9999px;
        padding: 8px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
      }
      .edm-pill:hover {
        background: #0284c7;
        transform: translateY(-2px);
        box-shadow: 0 15px 30px -5px rgba(2, 132, 199, 0.4);
      }
      .edm-icon {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }
      .edm-panel {
        display: none;
        position: absolute;
        bottom: 50px;
        right: 0;
        width: 300px;
        background: #0f172a;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6);
        color: #e2e8f0;
      }
      .edm-panel.open { display: block; }
      .edm-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; display: flex; justify-content: space-between; }
      .edm-variant {
        padding: 8px 10px;
        margin-bottom: 6px;
        background: rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        transition: background 0.15s;
      }
      .edm-variant:hover { background: #0284c7; color: #fff; }
      .edm-drm-warning {
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #f87171;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.4;
      }
      .edm-hide-site {
        margin-top: 8px;
        font-size: 11px;
        color: #94a3b8;
        cursor: pointer;
        text-align: right;
      }
      .edm-hide-site:hover { color: #f1f5f9; text-decoration: underline; }
    `;
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="edm-pill">
        <svg class="edm-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14l-4-4 1.41-1.41L11 13.17V7h2v6.17l2.59-2.58L17 12l-5 4z"/></svg>
        <span>Download Video</span>
      </div>
      <div class="edm-panel">
        <div class="edm-title">
          <span>Detected Streams</span>
          <span style="cursor:pointer;" class="edm-close">\u2715</span>
        </div>
        <div class="edm-content">Scanning media...</div>
        <div class="edm-hide-site">Hide button on this site</div>
      </div>
    `;
    shadow.appendChild(style);
    shadow.appendChild(container);
    const pill = container.querySelector(".edm-pill");
    const panel = container.querySelector(".edm-panel");
    const closeBtn = container.querySelector(".edm-close");
    const contentEl = container.querySelector(".edm-content");
    const hideBtn = container.querySelector(".edm-hide-site");
    pill.addEventListener("click", () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        const resources = sniffResources().filter((r) => r.type === "video" || r.type === "stream");
        if (resources.length === 0) {
          contentEl.innerHTML = '<div style="font-size:11px; color:#94a3b8; padding:8px 0;">No direct video streams captured yet. Start playing video to sniff streams.</div>';
          return;
        }
        contentEl.innerHTML = resources.map(
          (r, idx) => `
          <div class="edm-variant" data-idx="${idx}">
            <div>
              <div style="font-weight:600; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.title}</div>
              <div style="font-size:10px; opacity:0.7;">${r.format} Stream</div>
            </div>
            <button style="background:#0284c7; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer;">Download</button>
          </div>
        `
        ).join("");
        contentEl.querySelectorAll(".edm-variant").forEach((item) => {
          item.addEventListener("click", () => {
            const idx = parseInt(item.getAttribute("data-idx") || "0", 10);
            const target = resources[idx];
            if (target) {
              chrome.runtime.sendMessage({
                action: "add_download",
                url: target.url,
                filename: target.title + (target.format ? `.${target.format.toLowerCase()}` : ""),
                referrer: window.location.href
              });
              panel.classList.remove("open");
            }
          });
        });
      }
    });
    closeBtn.addEventListener("click", () => panel.classList.remove("open"));
    hideBtn.addEventListener("click", () => {
      chrome.storage.local.get(["disabled_video_domains"], (r) => {
        const list = r.disabled_video_domains || [];
        list.push(hostDomain);
        chrome.storage.local.set({ disabled_video_domains: list }, () => {
          hostEl.remove();
        });
      });
    });
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(injectFloatingMediaButton, 1200);
  });
} else {
  setTimeout(injectFloatingMediaButton, 1200);
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "get_page_resources" || msg.action === "grab_page_links") {
    sendResponse({ resources: sniffResources(), pageTitle: document.title, pageUrl: window.location.href });
    return true;
  }
  if (msg.action === "get_page_images") {
    sendResponse({ images: sniffImages(), pageTitle: document.title, pageUrl: window.location.href });
    return true;
  }
});
