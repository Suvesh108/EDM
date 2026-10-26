const WS_URL = "ws://127.0.0.1:14370";
let socket = null;
let connectionStatus = "disconnected";
let reconnectTimer = null;
let pingInterval = null;
let bypassNextDownload = false;
let latestTasks = [];
const pendingAcks = /* @__PURE__ */ new Map();
const popupPorts = /* @__PURE__ */ new Set();
async function getToken() {
  const store = await chrome.storage.local.get("edm_ws_token");
  if (store && store.edm_ws_token && typeof store.edm_ws_token === "string" && store.edm_ws_token.trim().length >= 32) {
    return store.edm_ws_token.trim();
  }
  return "ed00000000000000000000000000000000000000000000000000000000000000";
}
function notifyPopupPorts() {
  const msg = {
    type: "snapshot",
    tasks: latestTasks,
    connectionStatus
  };
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {
      popupPorts.delete(port);
    }
  }
  const activeCount = latestTasks.filter((t) => t.status === "downloading").length;
  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: String(activeCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
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
          if (Array.isArray(data.tasks)) {
            latestTasks = data.tasks;
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
    connectionStatus = "disconnected";
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
    connectWebSocket();
  }, 2e3);
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
function sendWsTaskAction(id, action) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "task_action",
      id,
      action
    }));
  }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPorts.add(port);
    port.postMessage({
      type: "snapshot",
      tasks: latestTasks,
      connectionStatus
    });
    port.onMessage.addListener((msg) => {
      if (msg.type === "task_action" && msg.id && msg.action) {
        sendWsTaskAction(msg.id, msg.action);
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
      }
    });
    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }
});
chrome.downloads.onCreated.addListener(async (item) => {
  const store = await chrome.storage.local.get("edm_interception_enabled");
  if (store && store.edm_interception_enabled === false) {
    return;
  }
  if (bypassNextDownload) {
    bypassNextDownload = false;
    return;
  }
  const url = item.finalUrl || item.url;
  if (!url || !url.startsWith("http://") && !url.startsWith("https://")) {
    return;
  }
  try {
    await chrome.downloads.pause(item.id);
  } catch (err) {
    console.warn("[EDM Extension] Could not pause browser download:", err);
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
    console.warn("[EDM Extension] Cookie retrieval:", e);
  }
  const referrer = item.referrer || "";
  const userAgent = navigator.userAgent;
  let filename = item.filename ? item.filename.split(/[\\/]/).pop() : void 0;
  if (!filename || filename === "download" || filename === "download.bin" || !filename.includes(".")) {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").pop();
      if (last && last.includes(".")) {
        filename = decodeURIComponent(last);
      }
    } catch {
    }
  }
  const req_id = crypto.randomUUID();
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
      3e3
    );
    if (ack && ack.ok) {
      try {
        await chrome.downloads.cancel(item.id);
        await chrome.downloads.erase({ id: item.id });
      } catch {
      }
    } else {
      console.warn("[EDM Extension] App rejected task or ack false. Resuming browser download.");
      try {
        await chrome.downloads.resume(item.id);
      } catch {
      }
    }
  } catch (e) {
    console.warn("[EDM Extension] create_task failed or timed out. Resuming browser download.", e);
    try {
      await chrome.downloads.resume(item.id);
    } catch {
    }
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
});
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
