// EDM Background Service Worker (Manifest V3)
const NMH_HOST = "com.edm.nmh";
const FALLBACK_HTTP_URL = "http://127.0.0.1:8998/api";

type ConnectionState = "connected" | "connecting" | "connection_failed" | "application_not_running" | "reconnecting";

let connectionState: ConnectionState = "connecting";
let lastPingTime = 0;
let bypassNextDownload = false;
const notifiedCompletedIds = new Set<string>();
const notifiedFailedIds = new Set<string>();

// Cached telemetry for popup instant load
let cachedStatus: any = {
  status: "connecting",
  version: "0.0.1",
  protocol: 1,
  active_downloads: 0,
  queued_tasks: 0,
  completed_tasks: 0,
  aggregate_speed_bps: 0,
};

// Dispatch message to Native Messaging Host with automatic loopback HTTP fallback
async function sendHostMessage(message: any): Promise<any> {
  // 1. Try Native Messaging Host first
  try {
    const nativeReply = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendNativeMessage(NMH_HOST, message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(resp);
        }
      });
    });

    connectionState = "connected";
    lastPingTime = Date.now();
    return nativeReply;
  } catch (err: any) {
    // 2. Fallback to Local Loopback HTTP Bridge (port 8998)
    try {
      const httpRes = await fetch(FALLBACK_HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      if (httpRes.ok) {
        const json = await httpRes.json();
        connectionState = "connected";
        lastPingTime = Date.now();
        return json;
      }
    } catch {
      // Both channels unreachable
    }

    connectionState = "connection_failed";
    return {
      type: "error",
      message: "Desktop application is not running or native host is unregistered.",
    };
  }
}

// Check desktop host connection status
async function probeConnection() {
  const reply = await sendHostMessage({ type: "ping" });
  if (reply && reply.type === "pong") {
    connectionState = "connected";
    // Sync status
    const statusReply = await sendHostMessage({ type: "get_status" });
    if (statusReply && statusReply.type === "status") {
      cachedStatus = statusReply;
    }
  } else {
    connectionState = "application_not_running";
  }
}

// Background polling loop for download updates & notifications
setInterval(async () => {
  try {
    const listRes = await sendHostMessage({ type: "list_downloads", filter: "all" });
    if (listRes && listRes.type === "download_list") {
      connectionState = "connected";
      cachedStatus.active_downloads = listRes.active_count;
      cachedStatus.queued_tasks = listRes.queued_count;
      cachedStatus.completed_tasks = listRes.completed_count;
      cachedStatus.aggregate_speed_bps = listRes.aggregate_speed_bps;

      // Update extension badge with active download count
      if (listRes.active_count > 0) {
        chrome.action.setBadgeText({ text: String(listRes.active_count) });
        chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }

      // Check notifications
      const settings = (await chrome.storage.local.get("edm_settings"))?.edm_settings || {};
      const notifyComplete = settings.notifyComplete !== false;
      const notifyFail = settings.notifyFail !== false;

      for (const dl of listRes.downloads || []) {
        if (dl.state === "completed" && notifyComplete && !notifiedCompletedIds.has(dl.id)) {
          notifiedCompletedIds.add(dl.id);
          chrome.notifications.create(`complete-${dl.id}`, {
            type: "basic",
            iconUrl: "logo.png",
            title: "EDM — Download Completed",
            message: `${dl.filename} is ready.`,
            priority: 1,
          });
        }
        if (dl.state === "failed" && notifyFail && !notifiedFailedIds.has(dl.id)) {
          notifiedFailedIds.add(dl.id);
          chrome.notifications.create(`fail-${dl.id}`, {
            type: "basic",
            iconUrl: "logo.png",
            title: "EDM — Download Failed",
            message: `${dl.filename} encountered an error.`,
            priority: 2,
          });
        }
      }
    }
  } catch {}
}, 2000);

// Initial probe
probeConnection();

// Context Menu: "Download with EDM"
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "edm_download_link",
    title: "Download with EDM",
    contexts: ["link", "video", "audio", "image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl;
  if (!targetUrl) return;

  await sendHostMessage({
    type: "add_download",
    url: targetUrl,
    referrer: tab?.url,
    source: "context_menu",
  });

  chrome.notifications.create({
    type: "basic",
    iconUrl: "logo.png",
    title: "EDM — Task Added",
    message: `Sent to EDM: ${targetUrl.split("/").pop()?.split("?")[0] || "Download"}`,
  });
});

// Intercept browser downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (bypassNextDownload) {
    bypassNextDownload = false;
    return;
  }

  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url || url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("file:")) {
    return;
  }

  try {
    const cookies = await chrome.cookies.getAll({ url });
    const cookiePayload = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));

    const payload = {
      type: "add_download",
      url: downloadItem.url,
      finalUrl: downloadItem.finalUrl,
      referrer: downloadItem.referrer,
      userAgent: navigator.userAgent,
      cookies: cookiePayload,
      filename: downloadItem.filename,
      mime: downloadItem.mime,
      size: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : undefined,
      source: "browser_interception",
    };

    const reply = await sendHostMessage(payload);
    if (reply && reply.type === "accepted") {
      try {
        await chrome.downloads.cancel(downloadItem.id);
        await chrome.downloads.erase({ id: downloadItem.id });
      } catch {}
    }
  } catch (err) {
    console.warn("EDM download interception fallback:", err);
  }
});

// Handle messages from Popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "bypass_next") {
    bypassNextDownload = true;
    setTimeout(() => { bypassNextDownload = false; }, 5000);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "get_connection_state") {
    sendResponse({ state: connectionState, cachedStatus });
    return true;
  }

  if (msg.action === "forward_to_host") {
    sendHostMessage(msg.payload).then((resp) => {
      sendResponse(resp);
    });
    return true;
  }
});
