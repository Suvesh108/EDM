/**
 * Vortex Downloader - Background Service Worker (Manifest V3)
 * Manages context menus, browser download interception, and backend synchronization.
 */

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const WEB_APP_URL = "http://localhost:5173";

// Initialize Context Menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "vortex-download-link",
    title: "⚡ Download with Vortex Downloader",
    contexts: ["link", "video", "audio", "image"]
  });

  chrome.contextMenus.create({
    id: "vortex-sniff-page",
    title: "🔍 Sniff All Media on Page",
    contexts: ["page"]
  });

  // Default settings
  chrome.storage.sync.get(["backendUrl", "interceptDownloads", "showFloatingButton"], (res) => {
    if (!res.backendUrl) {
      chrome.storage.sync.set({
        backendUrl: DEFAULT_BACKEND_URL,
        interceptDownloads: false,
        showFloatingButton: true
      });
    }
  });
});

// Context Menu Action Handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.srcUrl || info.linkUrl || info.pageUrl;
  if (!targetUrl) return;

  if (info.menuItemId === "vortex-download-link") {
    await sendToVortex(targetUrl, tab?.title || "Web Media");
  } else if (info.menuItemId === "vortex-sniff-page") {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: "open_sniffer_modal" });
    }
  }
});

// Intercept Standard Browser Downloads if Enabled
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const { interceptDownloads, backendUrl } = await chrome.storage.sync.get(["interceptDownloads", "backendUrl"]);
  if (!interceptDownloads) return;

  // Avoid intercepting internal or loopback URLs
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url || url.startsWith("blob:") || url.includes("localhost") || url.includes("127.0.0.1")) {
    return;
  }

  // Cancel native browser download
  chrome.downloads.cancel(downloadItem.id, () => {
    chrome.downloads.erase({ id: downloadItem.id });
  });

  // Forward to Vortex Downloader
  const filename = downloadItem.filename ? downloadItem.filename.split(/[\\/]/).pop() : "download";
  await sendToVortex(url, filename, backendUrl || DEFAULT_BACKEND_URL);
});

// Dispatch URL to Vortex Engine
async function sendToVortex(url, title, configuredBackend) {
  const backend = configuredBackend || (await chrome.storage.sync.get("backendUrl")).backendUrl || DEFAULT_BACKEND_URL;

  try {
    // 1. Check if backend is alive
    const health = await fetch(`${backend}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (health.ok) {
      // 2. Dispatch to chunk-download or stream extraction
      const payload = {
        url,
        title: title.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60),
        threads: 16
      };

      const res = await fetch(`${backend}/api/chunk-download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        chrome.action.setBadgeText({ text: "✓" });
        chrome.action.setBadgeBackgroundColor({ color: "#06b6d4" });
        setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
        return { success: true, mode: "backend" };
      }
    }
  } catch (_) {
    // Backend offline: open web app tab with query parameter
  }

  // Open web interface if backend is offline or for interactive configuration
  const appTarget = `${WEB_APP_URL}/?url=${encodeURIComponent(url)}`;
  chrome.tabs.create({ url: appTarget });
  return { success: true, mode: "webapp" };
}

// Runtime Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "check_backend_status") {
    chrome.storage.sync.get("backendUrl", async ({ backendUrl }) => {
      const target = backendUrl || DEFAULT_BACKEND_URL;
      try {
        const res = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
          const data = await res.json();
          sendResponse({ online: true, version: data.service || "v0.6.7" });
        } else {
          sendResponse({ online: false });
        }
      } catch (_) {
        sendResponse({ online: false });
      }
    });
    return true; // Keep message channel open for async response
  }

  if (message.action === "download_stream") {
    sendToVortex(message.url, message.title || "Media Stream").then(sendResponse);
    return true;
  }
});
