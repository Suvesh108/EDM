let isAltPressed = false;
window.addEventListener("keydown", (e) => {
  if (e.key === "Alt" && !isAltPressed) {
    isAltPressed = true;
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {
    });
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt") {
    isAltPressed = false;
  }
});
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
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "get_page_resources") {
    sendResponse({ resources: sniffResources(), pageTitle: document.title, pageUrl: window.location.href });
    return true;
  }
  if (msg.action === "get_page_images") {
    sendResponse({ images: sniffImages(), pageTitle: document.title, pageUrl: window.location.href });
    return true;
  }
});
