// EDM Background Service Worker (Manifest V3)
// Direct High-Performance Local WebSocket Client for 127.0.0.1:14370

interface WsTaskItem {
  id: string;
  filename: string;
  total: number | null;
  downloaded: number;
  speed: number;
  status: "queued" | "downloading" | "paused" | "completed" | "failed";
}

interface PendingAck {
  resolve: (ack: { ok: boolean; id?: string; error?: string }) => void;
  timer: any;
}

const WS_URL = "ws://127.0.0.1:14370";
let socket: WebSocket | null = null;
let connectionStatus: "connecting" | "connected" | "disconnected" = "disconnected";
let reconnectTimer: any = null;
let pingInterval: any = null;
let bypassNextDownload = false;

// Shared state
let latestTasks: WsTaskItem[] = [];
const pendingAcks = new Map<string, PendingAck>();
const popupPorts = new Set<chrome.runtime.Port>();

// 1. Get Authentication Token from chrome.storage.local or auto-detect
async function autoDetectAndSetToken(): Promise<string | null> {
  // 1. Try Native Messaging Host com.edm.nmh first (fastest, reads token directly)
  try {
    const nmhToken = await new Promise<string | null>((resolve) => {
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
  } catch (_e) {}

  // 2. Try HTTP loopback endpoints
  const headers = {
    "X-EDM-Client": "extension",
    "X-EDM-Extension-Id": (typeof chrome !== "undefined" && chrome.runtime?.id) ? chrome.runtime.id : "extension",
  };

  for (const url of ["http://127.0.0.1:14370/token", "http://localhost:14370/token"]) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
          await chrome.storage.local.set({ edm_ws_token: data.token });
          console.log("[EDM Extension] Successfully auto-detected token from HTTP handshake!");
          return data.token;
        }
      }
    } catch (_e) {}
  }

  return null;
}

async function getToken(): Promise<string> {
  const store = await chrome.storage.local.get("edm_ws_token");
  if (
    store &&
    store.edm_ws_token &&
    typeof store.edm_ws_token === "string" &&
    store.edm_ws_token.trim().length >= 32 &&
    !store.edm_ws_token.startsWith("ed0000000000")
  ) {
    return store.edm_ws_token.trim();
  }

  // Attempt automatic detection from running desktop application
  const detected = await autoDetectAndSetToken();
  if (detected) {
    return detected;
  }

  return (store && store.edm_ws_token) || "ed00000000000000000000000000000000000000000000000000000000000000";
}

// 2. Broadcast snapshot and status to open popup ports
function notifyPopupPorts() {
  const msg = {
    type: "snapshot",
    tasks: latestTasks,
    connectionStatus,
  };
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {
      popupPorts.delete(port);
    }
  }

  // Update extension badge
  const activeCount = latestTasks.filter((t) => t.status === "downloading").length;
  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: String(activeCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// 3. Connect to Desktop App WebSocket Server
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
    // Phase 1 Invariant: First frame MUST be hello { token }
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
          // Phase 4 Invariant: Send subscribe after ready
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "subscribe" }));
          }
          startPingInterval();
          notifyPopupPorts();
          break;
        }

        case "pong": {
          // Keep-alive acknowledged
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
            const pending = pendingAcks.get(data.req_id)!;
            clearTimeout(pending.timer);
            pendingAcks.delete(data.req_id);
            pending.resolve({
              ok: !!data.ok,
              id: data.id,
              error: data.error,
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
  // Auto-reconnect every 2 seconds
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, 2000);
}

function startPingInterval() {
  stopPingInterval();
  // Keep service worker alive: Send ping every 20 seconds
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// 4. Send Create Task request and wait for ACK (with configurable timeout)
async function sendWsCreateTask(payload: {
  type: "create_task";
  req_id: string;
  url: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  referrer?: string;
  user_agent?: string;
  filename?: string;
}, timeoutMs = 3000): Promise<{ ok: boolean; id?: string; error?: string }> {
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

// 5. Send Task Action (pause, resume, cancel, remove, open_file, open_folder)
function sendWsTaskAction(id: string, action: string) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "task_action",
      id,
      action,
    }));
  }
}

// 6. Connect with Popup UI via Port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPorts.add(port);

    // Instantly receive last snapshot and connection status on connect
    port.postMessage({
      type: "snapshot",
      tasks: latestTasks,
      connectionStatus,
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === "task_action" && msg.id && msg.action) {
        sendWsTaskAction(msg.id, msg.action);
      } else if (msg.type === "create_task") {
        const req_id = msg.req_id || crypto.randomUUID();
        sendWsCreateTask({ ...msg, req_id }).then((ack) => {
          try {
            port.postMessage({ type: "ack", ...ack, req_id });
          } catch {}
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

// Track handled download IDs to prevent duplicate interceptions
const handledDownloadIds = new Set<number>();

// 7. Download Interception Engine (MV3 downloads.onDeterminingFilename)
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let suggested = false;
  const safeSuggest = (options?: { filename?: string; conflictAction?: string }) => {
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

  // Avoid duplicate handling for the same download ID
  if (handledDownloadIds.has(item.id)) {
    safeSuggest();
    return false;
  }

  (async () => {
    // 1. Check interception toggle (default enabled)
    const store = await chrome.storage.local.get("edm_interception_enabled");
    if (store && store.edm_interception_enabled === false) {
      safeSuggest();
      return;
    }

    // 2. Shift-click / Alt bypass
    if (bypassNextDownload) {
      bypassNextDownload = false;
      safeSuggest();
      return;
    }

    // 3. Skip non-http(s) URLs
    const url = item.finalUrl || item.url;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      safeSuggest();
      return;
    }

    handledDownloadIds.add(item.id);
    if (handledDownloadIds.size > 500) {
      const first = handledDownloadIds.values().next().value;
      if (first !== undefined) handledDownloadIds.delete(first);
    }

    // 4. Gather metadata: suggested filename (basename only), mime, fileSize, referrer, cookies, user_agent
    let filename: string | undefined = undefined;
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
      } catch {}
    }

    let cookies: Array<{ name: string; value: string; domain?: string; path?: string }> = [];
    try {
      const rawCookies = await chrome.cookies.getAll({ url });
      cookies = rawCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      }));
    } catch (e) {
      console.warn("[EDM Extension] Cookie retrieval failed:", e);
    }

    const referrer = item.referrer || "";
    const userAgent = navigator.userAgent;
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
          filename,
        },
        3000
      );

      if (ack && ack.ok) {
        // Cancel and erase browser download, then call suggest so browser never opens Save-As dialog
        try {
          await chrome.downloads.cancel(item.id);
        } catch {}
        try {
          await chrome.downloads.erase({ id: item.id });
        } catch {}
        safeSuggest();
      } else {
        console.warn("[EDM Extension] App rejected task or ack timeout. Calling suggest for normal browser download.");
        safeSuggest();
      }
    } catch (err) {
      console.warn("[EDM Extension] create_task failed, falling back to browser download:", err);
      safeSuggest();
    }
  })();

  // Return true to indicate asynchronous suggest() invocation
  return true;
});

// 8. Runtime Messages from Content Script & Options Page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "bypass_next") {
    bypassNextDownload = true;
    setTimeout(() => {
      bypassNextDownload = false;
    }, 4000);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "get_status") {
    sendResponse({
      connectionStatus,
      tasksCount: latestTasks.length,
      activeTasks: latestTasks.filter((t) => t.status === "downloading").length,
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
    let testWs: WebSocket | null = null;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (testWs) testWs.close();
        sendResponse({ ok: false, error: "Connection timed out after 3 seconds" });
      }
    }, 3000);

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
          } catch {}
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
    } catch (e: any) {
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
          error: "Could not auto-detect token from EDM Desktop. Please ensure EDM Desktop application is running.",
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
            status, // "throttled" | "no_update" | "update_available"
            version: details?.version || "0.0.1",
          });
        }
      });
    } catch (err: any) {
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

// 9. Context Menus: "Download with EDM"
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

  const req_id = crypto.randomUUID();
  let cookies: Array<{ name: string; value: string }> = [];
  try {
    const rawCookies = await chrome.cookies.getAll({ url: targetUrl });
    cookies = rawCookies.map((c) => ({ name: c.name, value: c.value }));
  } catch {}

  const ack = await sendWsCreateTask({
    type: "create_task",
    req_id,
    url: targetUrl,
    referrer: tab?.url,
    user_agent: navigator.userAgent,
    cookies,
  });

  if (ack && ack.ok) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "logo.png",
      title: "EDM — Task Added",
      message: `Started: ${targetUrl.split("/").pop()?.split("?")[0] || "Download"}`,
    });
  }
});

// Start initial WebSocket connection on worker start
connectWebSocket();
