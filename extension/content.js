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
function isYouTube() {
  return window.location.hostname.includes("youtube.com") || window.location.hostname.includes("youtu.be");
}
function isYouTubeShorts() {
  return window.location.pathname.startsWith("/shorts");
}
function isYouTubeWatch() {
  return window.location.pathname === "/watch" || window.location.pathname.startsWith("/watch");
}
function isYouTubeDarkMode() {
  return document.documentElement.hasAttribute("dark") || document.body?.hasAttribute("dark") || Boolean(document.querySelector("html[dark]")) || window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}
function injectYouTubeButton() {
  if (!isYouTube()) return;
  if (isYouTubeShorts()) {
    chrome.storage.local.get(["youtube_shorts_enabled"], (res) => {
      if (!res.youtube_shorts_enabled) return;
      doInjectYouTubeButton();
    });
    return;
  }
  if (!isYouTubeWatch()) return;
  doInjectYouTubeButton();
}
function doInjectYouTubeButton() {
  chrome.storage.local.get(
    ["media_button_master", "media_button_youtube", "hidden_sites", "disabled_video_domains"],
    (res) => {
      if (res.media_button_master === false) return;
      if (res.media_button_youtube === false) return;
      const hidden = res.hidden_sites || res.disabled_video_domains || [];
      if (hidden.some((h) => window.location.hostname.includes(h))) return;
      if (document.getElementById("edm-yt-button-host")) return;
      const subscribeBtn = document.querySelector("#owner #subscribe-button") || document.querySelector("ytd-watch-metadata #owner #subscribe-button") || document.querySelector("#subscribe-button");
      if (!subscribeBtn || !subscribeBtn.parentElement) return;
      const isDark = isYouTubeDarkMode();
      const hostEl = document.createElement("div");
      hostEl.id = "edm-yt-button-host";
      hostEl.style.display = "inline-flex";
      hostEl.style.alignItems = "center";
      hostEl.style.marginLeft = "8px";
      hostEl.style.verticalAlign = "middle";
      const shadow = hostEl.attachShadow({ mode: "closed" });
      const bg = isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.05)";
      const bgHover = isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.1)";
      const color = isDark ? "#f1f1f1" : "#0f0f0f";
      const border = isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.1)";
      const style = document.createElement("style");
      style.textContent = `
        .edm-yt-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 36px;
          padding: 0 16px;
          border-radius: 18px;
          background: ${bg};
          color: ${color};
          border: 1px solid ${border};
          font-family: "Roboto", "Segoe UI", Arial, sans-serif;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          user-select: none;
          transition: background-color 0.2s cubic-bezier(0.05, 0, 0.2, 1), transform 0.1s;
          box-sizing: border-box;
          position: relative;
        }
        .edm-yt-pill:hover {
          background: ${bgHover};
        }
        .edm-yt-pill:active {
          transform: scale(0.98);
        }
        .edm-yt-icon {
          width: 16px;
          height: 16px;
          fill: currentColor;
          flex-shrink: 0;
        }
        .edm-yt-dropdown {
          display: none;
          position: absolute;
          top: 42px;
          left: 0;
          min-width: 200px;
          background: ${isDark ? "#1f1f1f" : "#ffffff"};
          color: ${isDark ? "#f1f1f1" : "#0f0f0f"};
          border: 1px solid ${border};
          border-radius: 12px;
          padding: 6px 0;
          box-shadow: 0 8px 24px rgba(0, 0, 0, ${isDark ? "0.6" : "0.2"});
          z-index: 2147483647;
          font-size: 13px;
        }
        .edm-yt-dropdown.open {
          display: block;
        }
        .edm-yt-item {
          padding: 8px 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background 0.15s;
        }
        .edm-yt-item:hover {
          background: ${isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.05)"};
        }
        .edm-yt-divider {
          height: 1px;
          background: ${border};
          margin: 4px 0;
        }
        .edm-yt-sub {
          font-size: 11px;
          opacity: 0.65;
        }
      `;
      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";
      wrapper.innerHTML = `
        <button class="edm-yt-pill" type="button" aria-label="Download with EDM">
          <svg class="edm-yt-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14l-4-4 1.41-1.41L11 13.17V7h2v6.17l2.59-2.58L17 12l-5 4z"/></svg>
          <span>EDM</span>
        </button>
        <div class="edm-yt-dropdown">
          <div class="edm-yt-item" id="opt-quick">
            <div>
              <div>Download Video</div>
              <div class="edm-yt-sub">Best available quality</div>
            </div>
          </div>
          <div class="edm-yt-item" id="opt-probe">
            <div>
              <div>Probe Formats</div>
              <div class="edm-yt-sub">Inspect 1080p, 720p & audio</div>
            </div>
          </div>
          <div class="edm-yt-divider"></div>
          <div class="edm-yt-item" id="opt-hide">
            <div style="font-size:12px; opacity:0.8;">Hide button on YouTube</div>
          </div>
        </div>
      `;
      shadow.appendChild(style);
      shadow.appendChild(wrapper);
      if (subscribeBtn.nextSibling) {
        subscribeBtn.parentElement.insertBefore(hostEl, subscribeBtn.nextSibling);
      } else {
        subscribeBtn.parentElement.appendChild(hostEl);
      }
      const pillBtn = wrapper.querySelector(".edm-yt-pill");
      const dropdown = wrapper.querySelector(".edm-yt-dropdown");
      const optQuick = wrapper.querySelector("#opt-quick");
      const optProbe = wrapper.querySelector("#opt-probe");
      const optHide = wrapper.querySelector("#opt-hide");
      pillBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
      });
      document.addEventListener("click", () => {
        dropdown.classList.remove("open");
      });
      optQuick.addEventListener("click", () => {
        dropdown.classList.remove("open");
        const cleanTitle = (document.title || "YouTube Video").replace(" - YouTube", "").trim();
        chrome.runtime.sendMessage({
          action: "add_download",
          url: window.location.href,
          filename: cleanTitle + ".mp4",
          referrer: window.location.href
        });
      });
      optProbe.addEventListener("click", () => {
        dropdown.classList.remove("open");
        optProbe.innerHTML = '<div><div>Probing...</div><div class="edm-yt-sub">Querying formats</div></div>';
        chrome.runtime.sendMessage(
          { action: "probe_page_media", url: window.location.href },
          (res2) => {
            if (res2 && res2.ok && Array.isArray(res2.variants) && res2.variants.length > 0) {
              const cleanTitle = (document.title || "YouTube Video").replace(" - YouTube", "").trim();
              let html = `<div style="padding:6px 14px; font-weight:600; font-size:11px; opacity:0.7;">AVAILABLE FORMATS</div>`;
              res2.variants.slice(0, 5).forEach((v) => {
                html += `
                  <div class="edm-yt-item edm-probe-variant" data-url="${encodeURIComponent(v.url)}" data-type="${v.media_type || "direct"}">
                    <div>
                      <div>${v.quality || v.resolution || "Direct Stream"}</div>
                      <div class="edm-yt-sub">${v.resolution || ""} ${v.media_type || ""}</div>
                    </div>
                  </div>
                `;
              });
              html += `<div class="edm-yt-divider"></div><div class="edm-yt-item" id="opt-hide"><div style="font-size:12px; opacity:0.8;">Hide button on YouTube</div></div>`;
              dropdown.innerHTML = html;
              dropdown.classList.add("open");
              dropdown.querySelectorAll(".edm-probe-variant").forEach((el) => {
                el.addEventListener("click", () => {
                  const targetUrl = decodeURIComponent(el.getAttribute("data-url") || "");
                  if (targetUrl) {
                    chrome.runtime.sendMessage({
                      action: "add_download",
                      url: targetUrl,
                      filename: cleanTitle + ".mp4",
                      referrer: window.location.href
                    });
                    dropdown.classList.remove("open");
                  }
                });
              });
            } else {
              const cleanTitle = (document.title || "YouTube Video").replace(" - YouTube", "").trim();
              chrome.runtime.sendMessage({
                action: "add_download",
                url: window.location.href,
                filename: cleanTitle + ".mp4",
                referrer: window.location.href
              });
            }
          }
        );
      });
      optHide.addEventListener("click", () => {
        dropdown.classList.remove("open");
        chrome.storage.local.get(["hidden_sites"], (r) => {
          const list = r.hidden_sites || [];
          if (!list.includes("youtube.com")) list.push("youtube.com");
          chrome.storage.local.set({ hidden_sites: list }, () => {
            hostEl.remove();
          });
        });
      });
    }
  );
}
function injectFloatingMediaButton() {
  if (isYouTube()) {
    const existing = document.getElementById("edm-video-sniffer-host");
    if (existing) existing.remove();
    return;
  }
  const hostDomain = window.location.hostname;
  chrome.storage.local.get(
    ["media_button_master", "media_button_other_sites", "hidden_sites", "disabled_video_domains", "disable_floating_button"],
    (res) => {
      if (res.disable_floating_button) return;
      if (res.media_button_master === false) return;
      if (res.media_button_other_sites === false) return;
      const disabledList = res.hidden_sites || res.disabled_video_domains || [];
      if (disabledList.some((d) => hostDomain.includes(d))) return;
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
            contentEl.innerHTML = '<div style="font-size:11px; color:#94a3b8; padding:8px 0;">No direct video streams captured yet. Start playback to sniff streams.</div>';
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
        chrome.storage.local.get(["hidden_sites", "disabled_video_domains"], (r) => {
          const list = r.hidden_sites || r.disabled_video_domains || [];
          if (!list.includes(hostDomain)) list.push(hostDomain);
          chrome.storage.local.set({ hidden_sites: list, disabled_video_domains: list }, () => {
            hostEl.remove();
          });
        });
      });
    }
  );
}
function runButtonInjection() {
  if (isYouTube()) {
    injectYouTubeButton();
  } else {
    injectFloatingMediaButton();
  }
}
if (isYouTube()) {
  window.addEventListener("yt-navigate-finish", () => {
    setTimeout(injectYouTubeButton, 600);
  });
  document.addEventListener("spfdone", () => {
    setTimeout(injectYouTubeButton, 600);
  });
}
let debounceTimer = null;
const observer = new MutationObserver(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runButtonInjection();
  }, 500);
});
observer.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true
});
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(runButtonInjection, 800);
  });
} else {
  setTimeout(runButtonInjection, 800);
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
