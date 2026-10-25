const NMH_HOST = "com.edm.nmh";
const FALLBACK_HTTP_URL = "http://127.0.0.1:8998/api";
let connectionState = "connecting";
let lastPingTime = 0;
let bypassNextDownload = false;
const notifiedCompletedIds = /* @__PURE__ */ new Set();
const notifiedFailedIds = /* @__PURE__ */ new Set();
let cachedStatus = {
  status: "connecting",
  version: "0.0.1",
  protocol: 1,
  active_downloads: 0,
  queued_tasks: 0,
  completed_tasks: 0,
  aggregate_speed_bps: 0
};
let activeChannel = "unknown";
async function sendViaNative(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native host timeout")), 1500);
    try {
      chrome.runtime.sendNativeMessage(NMH_HOST, message, (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}
async function sendViaHttp(message) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 2e3);
  try {
    const res = await fetch(FALLBACK_HTTP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EDM-Client": "extension"
      },
      body: JSON.stringify(message),
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
async function sendHostMessage(message) {
  if (activeChannel === "http") {
    try {
      const resp = await sendViaHttp(message);
      connectionState = "connected";
      lastPingTime = Date.now();
      return resp;
    } catch {
      activeChannel = "unknown";
    }
  } else if (activeChannel === "native") {
    try {
      const resp = await sendViaNative(message);
      connectionState = "connected";
      lastPingTime = Date.now();
      return resp;
    } catch {
      activeChannel = "unknown";
    }
  }
  try {
    const httpReply = await sendViaHttp(message);
    activeChannel = "http";
    connectionState = "connected";
    lastPingTime = Date.now();
    return httpReply;
  } catch {
    try {
      const nativeReply = await sendViaNative(message);
      activeChannel = "native";
      connectionState = "connected";
      lastPingTime = Date.now();
      return nativeReply;
    } catch {
    }
  }
  connectionState = "connection_failed";
  return {
    type: "error",
    message: "EDM Desktop is not running. Please launch the EDM application."
  };
}
async function probeConnection() {
  const reply = await sendHostMessage({ type: "ping" });
  if (reply && reply.type === "pong") {
    connectionState = "connected";
    const statusReply = await sendHostMessage({ type: "get_status" });
    if (statusReply && statusReply.type === "status") {
      cachedStatus = statusReply;
    }
  } else {
    connectionState = "application_not_running";
  }
}
setInterval(async () => {
  try {
    const listRes = await sendHostMessage({ type: "list_downloads", filter: "all" });
    if (listRes && listRes.type === "download_list") {
      connectionState = "connected";
      cachedStatus.active_downloads = listRes.active_count;
      cachedStatus.queued_tasks = listRes.queued_count;
      cachedStatus.completed_tasks = listRes.completed_count;
      cachedStatus.aggregate_speed_bps = listRes.aggregate_speed_bps;
      if (listRes.active_count > 0) {
        chrome.action.setBadgeText({ text: String(listRes.active_count) });
        chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
      const settings = (await chrome.storage.local.get("edm_settings"))?.edm_settings || {};
      const notifyComplete = settings.notifyComplete !== false;
      const notifyFail = settings.notifyFail !== false;
      for (const dl of listRes.downloads || []) {
        if (dl.state === "completed" && notifyComplete && !notifiedCompletedIds.has(dl.id)) {
          notifiedCompletedIds.add(dl.id);
          chrome.notifications.create(`complete-${dl.id}`, {
            type: "basic",
            iconUrl: "logo.png",
            title: "EDM \u2014 Download Completed",
            message: `${dl.filename} is ready.`,
            priority: 1
          });
        }
        if (dl.state === "failed" && notifyFail && !notifiedFailedIds.has(dl.id)) {
          notifiedFailedIds.add(dl.id);
          chrome.notifications.create(`fail-${dl.id}`, {
            type: "basic",
            iconUrl: "logo.png",
            title: "EDM \u2014 Download Failed",
            message: `${dl.filename} encountered an error.`,
            priority: 2
          });
        }
      }
    }
  } catch {
  }
}, 2e3);
probeConnection();
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "edm_download_link",
    title: "Download with EDM",
    contexts: ["link", "video", "audio", "image"]
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl;
  if (!targetUrl) return;
  await sendHostMessage({
    type: "add_download",
    url: targetUrl,
    referrer: tab?.url,
    source: "context_menu"
  });
  chrome.notifications.create({
    type: "basic",
    iconUrl: "logo.png",
    title: "EDM \u2014 Task Added",
    message: `Sent to EDM: ${targetUrl.split("/").pop()?.split("?")[0] || "Download"}`
  });
});
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
      path: c.path
    }));
    let derivedName = downloadItem.filename;
    if (!derivedName || derivedName === "download" || derivedName === "download.bin" || !derivedName.includes(".")) {
      try {
        const u = new URL(url);
        const lastPart = u.pathname.split("/").pop() || "";
        if (lastPart && lastPart.includes(".") && lastPart.length > 2) {
          derivedName = decodeURIComponent(lastPart);
        } else {
          for (const [k, v] of u.searchParams.entries()) {
            if (["filename", "file", "title", "name"].includes(k.toLowerCase()) && v.trim()) {
              derivedName = decodeURIComponent(v.trim());
              break;
            }
          }
        }
      } catch {
      }
    }
    const payload = {
      type: "add_download",
      url: downloadItem.url,
      finalUrl: downloadItem.finalUrl,
      referrer: downloadItem.referrer,
      userAgent: navigator.userAgent,
      cookies: cookiePayload,
      filename: derivedName || downloadItem.filename,
      mime: downloadItem.mime,
      size: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : void 0,
      source: "browser_interception"
    };
    const reply = await sendHostMessage(payload);
    if (reply && reply.type === "accepted") {
      try {
        await chrome.downloads.cancel(downloadItem.id);
        await chrome.downloads.erase({ id: downloadItem.id });
      } catch {
      }
    }
  } catch (err) {
    console.warn("EDM download interception fallback:", err);
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "bypass_next") {
    bypassNextDownload = true;
    setTimeout(() => {
      bypassNextDownload = false;
    }, 5e3);
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
