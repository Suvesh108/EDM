const WS_URL = "ws://127.0.0.1:14370";
let socket = null;
let connectionStatus = "asleep";
let latestLifecycleState = "active";
let reconnectTimer = null;
let pingInterval = null;
let bypassNextDownload = false;
let latestTasks = [];
let currentEpoch = "";
let currentRev = 0;
let currentTheme = "dark";
let currentPalette = "blue";
const pendingAcks = /* @__PURE__ */ new Map();
const popupPorts = /* @__PURE__ */ new Set();
async function autoDetectAndSetToken() {
  try {
    const nmhToken = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_token" }, (response) => {
        if (chrome.runtime.lastError || !response) {
          return resolve(null);
        }
        if (response.token && typeof response.token === "string" && response.token.length >= 32) {
          resolve(response.token);
        } else {
          resolve(null);
        }
      });
    });
    if (nmhToken) {
      await chrome.storage.local.set({ edm_ws_token: nmhToken });
      console.log("[EDM Extension] Successfully auto-detected token from Native Messaging Host!");
      return nmhToken;
    }
  } catch (_e) {
  }
  const headers = {
    "X-EDM-Client": "extension",
    "X-EDM-Extension-Id": typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "extension"
  };
  for (const url of ["http://127.0.0.1:14370/token", "http://localhost:14370/token"]) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store"
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
          await chrome.storage.local.set({ edm_ws_token: data.token });
          console.log("[EDM Extension] Successfully auto-detected token from HTTP handshake!");
          return data.token;
        }
      }
    } catch (_e) {
    }
  }
  return null;
}
async function getToken() {
  const store = await chrome.storage.local.get("edm_ws_token");
  if (store && store.edm_ws_token && typeof store.edm_ws_token === "string" && store.edm_ws_token.trim().length >= 32 && !store.edm_ws_token.startsWith("ed0000000000")) {
    return store.edm_ws_token.trim();
  }
  const detected = await autoDetectAndSetToken();
  if (detected) {
    return detected;
  }
  return store && store.edm_ws_token || "ed00000000000000000000000000000000000000000000000000000000000000";
}
function notifyPopupPorts() {
  const msg = {
    type: "snapshot",
    tasks: latestTasks,
    connectionStatus,
    lifecycleState: latestLifecycleState,
    epoch: currentEpoch,
    rev: currentRev,
    theme: currentTheme,
    palette: currentPalette
  };
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {
      popupPorts.delete(port);
    }
  }
  const activeCount = latestTasks.filter((t) => t.status === "downloading").length;
  if (connectionStatus === "waking") {
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
  } else if (activeCount > 0) {
    chrome.action.setBadgeText({ text: String(activeCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}
async function wakeDesktop(showWindow = false) {
  connectionStatus = "waking";
  notifyPopupPorts();
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(
        "com.edm.nmh",
        { type: "wake", show_window: showWindow },
        (response) => {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(response || { ok: false, error: "No response from NMH" });
        }
      );
    });
    if (res && res.ok) {
      if (res.token && typeof res.token === "string" && res.token.length >= 32) {
        await chrome.storage.local.set({ edm_ws_token: res.token });
      }
      const connected = await connectWebSocketPromise(8e3);
      if (connected) {
        connectionStatus = "connected";
        notifyPopupPorts();
        return { ok: true, token: res.token };
      } else {
        connectionStatus = "asleep";
        notifyPopupPorts();
        return { ok: false, error: "Wake succeeded but WebSocket failed to connect" };
      }
    } else {
      connectionStatus = "asleep";
      notifyPopupPorts();
      return { ok: false, error: res?.error || "Wake failed" };
    }
  } catch (err) {
    connectionStatus = "asleep";
    notifyPopupPorts();
    return { ok: false, error: err?.message || String(err) };
  }
}
async function connectWebSocketPromise(timeoutMs = 8e3) {
  if (socket && socket.readyState === WebSocket.OPEN && connectionStatus === "connected") {
    return true;
  }
  connectWebSocket();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (socket && socket.readyState === WebSocket.OPEN && connectionStatus === "connected") {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return socket !== null && socket.readyState === WebSocket.OPEN && connectionStatus === "connected";
}
async function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }
  connectionStatus = "connecting";
  notifyPopupPorts();
  const token = await getToken();
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[EDM Extension] WebSocket creation failed:", err);
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "hello", token }));
    }
  };
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "ready": {
          connectionStatus = "connected";
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "subscribe" }));
          }
          startPingInterval();
          notifyPopupPorts();
          break;
        }
        case "pong": {
          break;
        }
        case "snapshot": {
          const epoch = data.epoch || "";
          const rev = typeof data.rev === "number" ? data.rev : 0;
          if (epoch !== currentEpoch) {
            currentEpoch = epoch;
            currentRev = rev;
            if (Array.isArray(data.tasks)) latestTasks = data.tasks;
          } else if (rev >= currentRev) {
            currentRev = rev;
            if (Array.isArray(data.tasks)) latestTasks = data.tasks;
          }
          if (data.theme) {
            currentTheme = data.theme;
            chrome.storage.local.set({ edm_theme: data.theme });
          }
          if (data.palette) {
            currentPalette = data.palette;
            chrome.storage.local.set({ edm_palette: data.palette });
          }
          if (data.lifecycle_state) {
            latestLifecycleState = data.lifecycle_state;
          }
          notifyPopupPorts();
          break;
        }
        case "task_removed": {
          if (data.id) {
            if (data.epoch && data.epoch === currentEpoch && typeof data.rev === "number" && data.rev < currentRev) {
              break;
            }
            if (data.epoch && data.epoch !== currentEpoch) {
              currentEpoch = data.epoch;
            }
            if (typeof data.rev === "number") {
              currentRev = data.rev;
            }
            latestTasks = latestTasks.filter((t) => t.id !== data.id);
            notifyPopupPorts();
          }
          break;
        }
        case "ack": {
          if (data.req_id && pendingAcks.has(data.req_id)) {
            const pending = pendingAcks.get(data.req_id);
            clearTimeout(pending.timer);
            pendingAcks.delete(data.req_id);
            pending.resolve({
              ok: !!data.ok,
              id: data.id,
              error: data.error
            });
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.warn("[EDM Extension] Error handling inbound message:", e);
    }
  };
  socket.onclose = () => {
    connectionStatus = "asleep";
    socket = null;
    stopPingInterval();
    notifyPopupPorts();
    scheduleReconnect();
  };
  socket.onerror = (err) => {
    console.warn("[EDM Extension] WebSocket error:", err);
    if (socket) {
      socket.close();
    }
  };
}
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (connectionStatus !== "connected") {
      connectWebSocket();
    }
  }, 3e3);
}
function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }));
    }
  }, 2e4);
}
function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}
async function sendWsCreateTask(payload, timeoutMs = 3e3) {
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return resolve({ ok: false, error: "WebSocket not connected to EDM Desktop" });
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(payload.req_id);
      resolve({ ok: false, error: "Timeout waiting for EDM desktop ack" });
    }, timeoutMs);
    pendingAcks.set(payload.req_id, { resolve, timer });
    socket.send(JSON.stringify(payload));
  });
}
async function sendWsTaskAction(id, action, delete_file, req_id) {
  const rId = req_id || crypto.randomUUID();
  if (action === "remove") {
    latestTasks = latestTasks.filter((t) => t.id !== id);
    notifyPopupPorts();
  }
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return resolve({ ok: false, error: "WebSocket not connected to EDM Desktop" });
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(rId);
      resolve({ ok: false, error: "Action timeout waiting for EDM Desktop" });
    }, 3e3);
    pendingAcks.set(rId, { resolve, timer });
    socket.send(
      JSON.stringify({
        type: "task_action",
        req_id: rId,
        id,
        action,
        delete_file: !!delete_file
      })
    );
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPorts.add(port);
    port.postMessage({
      type: "snapshot",
      tasks: latestTasks,
      connectionStatus,
      epoch: currentEpoch,
      rev: currentRev,
      theme: currentTheme,
      palette: currentPalette
    });
    port.onMessage.addListener((msg) => {
      if (msg.type === "task_action" && msg.id && msg.action) {
        sendWsTaskAction(msg.id, msg.action, msg.delete_file, msg.req_id).then((ack) => {
          try {
            port.postMessage({ type: "ack", ...ack, req_id: msg.req_id || "" });
          } catch {
          }
        });
      } else if (msg.type === "create_task") {
        const req_id = msg.req_id || crypto.randomUUID();
        sendWsCreateTask({ ...msg, req_id }).then((ack) => {
          try {
            port.postMessage({ type: "ack", ...ack, req_id });
          } catch {
          }
        });
      } else if (msg.type === "reconnect") {
        connectWebSocket();
      } else if (msg.type === "wake_desktop") {
        wakeDesktop(!!msg.show_window);
      }
    });
    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }
});
const handledDownloadIds = /* @__PURE__ */ new Set();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let suggested = false;
  const safeSuggest = (options) => {
    if (!suggested) {
      suggested = true;
      try {
        if (options && options.filename) {
          suggest(options);
        } else {
          suggest();
        }
      } catch (err) {
        console.warn("[EDM Extension] suggest invocation:", err);
      }
    }
  };
  if (handledDownloadIds.has(item.id)) {
    safeSuggest();
    return false;
  }
  (async () => {
    const store = await chrome.storage.local.get("edm_interception_enabled");
    if (store && store.edm_interception_enabled === false) {
      safeSuggest();
      return;
    }
    if (bypassNextDownload) {
      bypassNextDownload = false;
      safeSuggest();
      return;
    }
    const url = item.finalUrl || item.url;
    if (!url || !url.startsWith("http://") && !url.startsWith("https://")) {
      safeSuggest();
      return;
    }
    handledDownloadIds.add(item.id);
    if (handledDownloadIds.size > 500) {
      const first = handledDownloadIds.values().next().value;
      if (first !== void 0) handledDownloadIds.delete(first);
    }
    let filename = void 0;
    if (item.filename) {
      const base = item.filename.split(/[\\/]/).pop();
      if (base && base !== "download" && base !== "download.bin") {
        filename = base;
      }
    }
    if (!filename || !filename.includes(".")) {
      try {
        const u = new URL(url);
        const last = u.pathname.split("/").pop();
        if (last && last.includes(".")) {
          filename = decodeURIComponent(last);
        }
      } catch {
      }
    }
    let cookies = [];
    try {
      const rawCookies = await chrome.cookies.getAll({ url });
      cookies = rawCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path
      }));
    } catch (e) {
      console.warn("[EDM Extension] Cookie retrieval failed:", e);
    }
    const referrer = item.referrer || "";
    const userAgent = navigator.userAgent;
    const req_id = crypto.randomUUID();
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionStatus !== "connected") {
      console.log("[EDM Extension] EDM is not connected. Pausing browser download and waking EDM...");
      try {
        await chrome.downloads.pause(item.id);
      } catch {
      }
      const wakeRes = await wakeDesktop(false);
      if (!wakeRes.ok) {
        console.warn("[EDM Extension] NMH wake failed or timed out:", wakeRes.error);
        try {
          await chrome.downloads.resume(item.id);
        } catch {
        }
        safeSuggest();
        return;
      }
    }
    try {
      const ack = await sendWsCreateTask(
        {
          type: "create_task",
          req_id,
          url,
          cookies,
          referrer,
          user_agent: userAgent,
          filename
        },
        5e3
      );
      if (ack && ack.ok) {
        try {
          await chrome.downloads.cancel(item.id);
        } catch {
        }
        try {
          await chrome.downloads.erase({ id: item.id });
        } catch {
        }
        safeSuggest();
      } else {
        console.warn("[EDM Extension] App rejected task or ack timeout. Calling suggest for normal browser download.");
        try {
          await chrome.downloads.resume(item.id);
        } catch {
        }
        safeSuggest();
      }
    } catch (err) {
      console.warn("[EDM Extension] create_task failed, falling back to browser download:", err);
      try {
        await chrome.downloads.resume(item.id);
      } catch {
      }
      safeSuggest();
    }
  })();
  return true;
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "wake_desktop") {
    wakeDesktop(!!msg.show_window).then((res) => {
      sendResponse(res);
    });
    return true;
  }
  if (msg.action === "bypass_next") {
    bypassNextDownload = true;
    setTimeout(() => {
      bypassNextDownload = false;
    }, 4e3);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === "get_status") {
    sendResponse({
      connectionStatus,
      tasksCount: latestTasks.length,
      activeTasks: latestTasks.filter((t) => t.status === "downloading").length
    });
    return true;
  }
  if (msg.action === "update_token") {
    if (msg.token) {
      chrome.storage.local.set({ edm_ws_token: msg.token }).then(() => {
        if (socket) {
          socket.close();
        }
        connectWebSocket();
        sendResponse({ ok: true });
      });
      return true;
    }
  }
  if (msg.action === "test_token") {
    const testToken = msg.token;
    const start = Date.now();
    let testWs = null;
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (testWs) testWs.close();
        sendResponse({ ok: false, error: "Connection timed out after 3 seconds" });
      }
    }, 3e3);
    try {
      testWs = new WebSocket(WS_URL);
      testWs.onopen = () => {
        testWs?.send(JSON.stringify({ type: "hello", token: testToken }));
      };
      testWs.onmessage = (event) => {
        if (!finished) {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "ready") {
              finished = true;
              clearTimeout(timer);
              const latency = Date.now() - start;
              testWs?.close();
              sendResponse({ ok: true, latency });
            }
          } catch {
          }
        }
      };
      testWs.onerror = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          sendResponse({ ok: false, error: "WebSocket connection error to 127.0.0.1:14370" });
        }
      };
      testWs.onclose = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          sendResponse({ ok: false, error: "Connection closed (Invalid token or origin)" });
        }
      };
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        sendResponse({ ok: false, error: e?.message || "Failed to initiate WebSocket test" });
      }
    }
    return true;
  }
  if (msg.action === "auto_detect_token") {
    autoDetectAndSetToken().then((token) => {
      if (token) {
        if (socket) {
          socket.close();
        }
        connectWebSocket();
        sendResponse({ ok: true, token });
      } else {
        sendResponse({
          ok: false,
          error: "Could not auto-detect token from EDM Desktop. Please ensure EDM Desktop application is running."
        });
      }
    });
    return true;
  }
  if (msg.action === "check_update") {
    try {
      chrome.runtime.requestUpdateCheck((status, details) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({
            ok: true,
            status,
            // "throttled" | "no_update" | "update_available"
            version: details?.version || "0.0.4"
          });
        }
      });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || "Update check failed" });
    }
    return true;
  }
  if (msg.action === "reload_extension") {
    sendResponse({ ok: true });
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (e) {
        console.warn("[EDM Extension] reload error:", e);
      }
    }, 150);
    return true;
  }
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update" || details.reason === "install") {
    chrome.storage.local.remove([
      "edm_tasks",
      "edm_history",
      "edm_tasks_cache",
      "downloads",
      "history"
    ]);
  }
  chrome.contextMenus.create({
    id: "edm_download_link",
    title: "Download with EDM",
    contexts: ["link", "video", "audio", "image"]
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl;
  if (!targetUrl) return;
  const req_id = crypto.randomUUID();
  let cookies = [];
  try {
    const rawCookies = await chrome.cookies.getAll({ url: targetUrl });
    cookies = rawCookies.map((c) => ({ name: c.name, value: c.value }));
  } catch {
  }
  const ack = await sendWsCreateTask({
    type: "create_task",
    req_id,
    url: targetUrl,
    referrer: tab?.url,
    user_agent: navigator.userAgent,
    cookies
  });
  if (ack && ack.ok) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "logo.png",
      title: "EDM \u2014 Task Added",
      message: `Started: ${targetUrl.split("/").pop()?.split("?")[0] || "Download"}`
    });
  }
});
connectWebSocket();
