const WS_URL = "ws://127.0.0.1:14370";
let socket = null;
let connectionStatus = "asleep";
let latestLifecycleState = "active";
let nmhHealth = { ok: true };
let latestDiagnosticsReport = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let pingInterval = null;
let bypassNextDownload = false;
let latestTasks = [];
let currentEpoch = "";
let currentRev = 0;
let currentTheme = "dark";
let currentPalette = "blue";
const pendingAcks = /* @__PURE__ */ new Map();
const popupPorts = /* @__PURE__ */ new Set();
const previousTaskStates = /* @__PURE__ */ new Map();
const detectedMediaByTab = /* @__PURE__ */ new Map();
let activeHandoffsCount = 0;
let isWaking = false;
let pendingReload = false;
function detectCurrentBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Firefox/")) return "firefox";
  if (navigator.brave && typeof navigator.brave.isBrave === "function") return "brave";
  return "chrome";
}
function checkAndPerformAutoReload(expectedVersion) {
  if (!expectedVersion) return;
  const currentVersion = chrome.runtime.getManifest().version;
  chrome.storage.local.set({ expected_extension_version: expectedVersion });
  if (expectedVersion === currentVersion) {
    pendingReload = false;
    chrome.storage.local.set({ edm_update_status: "latest" });
    return;
  }
  chrome.storage.local.set({ edm_update_status: "update_available" });
  if (activeHandoffsCount > 0 || isWaking) {
    pendingReload = true;
    console.log("[EDM Extension] Update available, deferring reload until active handoff/wake completes");
    return;
  }
  console.log(`[EDM Extension] App update detected (${currentVersion} -> ${expectedVersion}). Reloading extension...`);
  try {
    chrome.runtime.reload();
  } catch (err) {
    console.warn("[EDM Extension] runtime.reload() invocation:", err);
  }
}
function onHandoffSettle() {
  if (pendingReload && activeHandoffsCount === 0 && !isWaking) {
    console.log("[EDM Extension] Active handoff settled. Executing deferred reload...");
    try {
      chrome.runtime.reload();
    } catch (err) {
      console.warn("[EDM Extension] runtime.reload() invocation:", err);
    }
  }
}
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
    nmhHealth,
    diagnosticsReport: latestDiagnosticsReport,
    epoch: currentEpoch,
    rev: currentRev,
    theme: currentTheme,
    palette: currentPalette,
    currentVersion: chrome.runtime.getManifest().version,
    browser: detectCurrentBrowser()
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
async function checkNmhHealth() {
  if (connectionStatus === "connected") {
    nmhHealth = { ok: true };
    return nmhHealth;
  }
  return new Promise((resolve) => {
    try {
      const extId = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "ginpdimhcdbojbhemgjedghkeolbcmgj";
      chrome.runtime.sendNativeMessage(
        "com.edm.nmh",
        { type: "get_diagnostics", extension_id: extId },
        async (response) => {
          if (chrome.runtime.lastError) {
            const st = await checkIfEdmRunning();
            if (st.running) {
              nmhHealth = { ok: true };
              notifyPopupPorts();
              return resolve(nmhHealth);
            }
            const err = chrome.runtime.lastError.message || "Native host not found";
            nmhHealth = { ok: false, reason: err };
            notifyPopupPorts();
            return resolve(nmhHealth);
          }
          if (response && response.type === "diagnostics" && response.report) {
            latestDiagnosticsReport = response.report;
            const rep = response.report;
            const myBrowser = rep.browsers.find((b) => b.origin_matched) || rep.browsers[0];
            if (!rep.app_installed) {
              nmhHealth = { ok: false, reason: "EDM desktop executable not found on disk", report: rep };
            } else if (myBrowser && !myBrowser.helper_registered) {
              nmhHealth = { ok: false, reason: `Native host not registered for ${myBrowser.browser}`, report: rep };
            } else if (myBrowser && !myBrowser.manifest_exists) {
              nmhHealth = { ok: false, reason: `Manifest file missing for ${myBrowser.browser}`, report: rep };
            } else {
              nmhHealth = { ok: true, report: rep };
            }
          } else {
            nmhHealth = { ok: true };
          }
          notifyPopupPorts();
          resolve(nmhHealth);
        }
      );
    } catch (e) {
      nmhHealth = { ok: false, reason: e?.message || "Failed to contact host" };
      notifyPopupPorts();
      resolve(nmhHealth);
    }
  });
}
async function wakeDesktop(showWindow = false) {
  isWaking = true;
  connectionStatus = "waking";
  notifyPopupPorts();
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(
        "com.edm.nmh",
        { type: "wake", show_window: showWindow },
        async (response) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message || "Failed to communicate with NMH";
            const runningCheck = await checkIfEdmRunning();
            if (runningCheck.running) {
              nmhHealth = { ok: true };
              return resolve({ ok: true, token: runningCheck.token });
            }
            nmhHealth = { ok: false, reason: err };
            return resolve({ ok: false, error: err });
          }
          nmhHealth = { ok: true };
          resolve(response || { ok: false, error: "No response from NMH" });
        }
      );
    });
    if (res && res.ok) {
      nmhHealth = { ok: true };
      if (res.token && typeof res.token === "string" && res.token.length >= 32) {
        await chrome.storage.local.set({ edm_ws_token: res.token });
      }
      const connected = await connectWebSocketPromise(2e4);
      if (connected) {
        connectionStatus = "connected";
        notifyPopupPorts();
        return { ok: true, token: res.token };
      } else {
        connectionStatus = "asleep";
        notifyPopupPorts();
        return { ok: false, error: "Wake succeeded but WebSocket failed to connect within timeout" };
      }
    } else {
      const runningCheck = await checkIfEdmRunning();
      if (runningCheck.running) {
        nmhHealth = { ok: true };
        if (runningCheck.token) {
          await chrome.storage.local.set({ edm_ws_token: runningCheck.token });
        }
        const connected = await connectWebSocketPromise(5e3);
        if (connected) {
          connectionStatus = "connected";
          notifyPopupPorts();
          return { ok: true, token: runningCheck.token };
        }
      }
      connectionStatus = "asleep";
      if (res && res.error) {
        nmhHealth = { ok: false, reason: res.error };
      }
      notifyPopupPorts();
      return { ok: false, error: res?.error || "Wake failed" };
    }
  } catch (err) {
    connectionStatus = "asleep";
    nmhHealth = { ok: false, reason: err?.message || String(err) };
    notifyPopupPorts();
    return { ok: false, error: err?.message || String(err) };
  } finally {
    isWaking = false;
    onHandoffSettle();
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
async function checkIfEdmRunning() {
  try {
    const extId = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "ginpdimhcdbojbhemgjedghkeolbcmgj";
    const headers = {
      "X-EDM-Client": "extension",
      "X-EDM-Extension-Id": extId
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 600);
    const resp = await fetch("http://127.0.0.1:14370/token", {
      method: "GET",
      headers,
      signal: ctrl.signal,
      cache: "no-store"
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.token && typeof data.token === "string" && data.token.length >= 32) {
        return { running: true, token: data.token };
      }
    }
  } catch {
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "get_status" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          console.debug("[EDM Extension] NMH status check:", chrome.runtime.lastError?.message || "No response");
          return resolve({ running: false });
        }
        if (res.running || res.status === "running" || res.status === "connected") {
          return resolve({ running: true, token: res.token });
        }
        return resolve({ running: false });
      });
    } catch {
      resolve({ running: false });
    }
  });
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
    console.debug("[EDM Extension] WebSocket creation:", err);
    return;
  }
  socket.onopen = () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      const manifest = chrome.runtime.getManifest();
      const browser = detectCurrentBrowser();
      socket.send(
        JSON.stringify({
          type: "hello",
          token,
          browser,
          version: manifest.version,
          extension_id: chrome.runtime.id
        })
      );
    }
  };
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "ready": {
          connectionStatus = "connected";
          nmhHealth = { ok: true };
          if (data.extension_version) {
            checkAndPerformAutoReload(data.extension_version);
          }
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
          if (data.extension_version) {
            checkAndPerformAutoReload(data.extension_version);
          }
          const epoch = data.epoch || "";
          const rev = typeof data.rev === "number" ? data.rev : 0;
          let tasksUpdated = false;
          if (epoch !== currentEpoch) {
            currentEpoch = epoch;
            currentRev = rev;
            if (Array.isArray(data.tasks)) {
              latestTasks = data.tasks;
              tasksUpdated = true;
            }
          } else if (rev >= currentRev) {
            currentRev = rev;
            if (Array.isArray(data.tasks)) {
              latestTasks = data.tasks;
              tasksUpdated = true;
            }
          }
          if (tasksUpdated && Array.isArray(latestTasks)) {
            chrome.storage.local.get(["edm_notify_complete", "edm_notify_fail"]).then((st) => {
              const notifyComplete = st.edm_notify_complete !== false;
              const notifyFail = st.edm_notify_fail !== false;
              for (const t of latestTasks) {
                const prev = previousTaskStates.get(t.id);
                if (prev && prev !== t.state) {
                  const state = t.state;
                  if (state === "completed" && notifyComplete) {
                    chrome.notifications.create({
                      type: "basic",
                      iconUrl: "logo.png",
                      title: "EDM: Download Completed",
                      message: `${t.filename || "File"} has finished downloading.`
                    });
                  } else if ((state === "error" || state === "failed") && notifyFail) {
                    chrome.notifications.create({
                      type: "basic",
                      iconUrl: "logo.png",
                      title: "EDM: Download Error",
                      message: `${t.filename || "File"} failed or was interrupted.`
                    });
                  }
                }
                previousTaskStates.set(t.id, t.state);
              }
            });
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
        case "media_variants": {
          if (data.req_id && pendingAcks.has(data.req_id)) {
            const pending = pendingAcks.get(data.req_id);
            clearTimeout(pending.timer);
            pendingAcks.delete(data.req_id);
            pending.resolve({
              ok: true,
              variants: data.variants || [],
              is_drm: !!data.is_drm
            });
          }
          break;
        }
        case "refresh_link": {
          console.log("[EDM Extension] Download link expired for task:", data.task_id, data.filename);
          chrome.storage.local.set({
            pending_refresh_task: {
              task_id: data.task_id,
              page_url: data.page_url,
              filename: data.filename,
              size: data.size,
              timestamp: Date.now()
            }
          });
          if (chrome.notifications) {
            chrome.notifications.create({
              type: "basic",
              iconUrl: "logo.png",
              title: "EDM: Link Expired",
              message: `${data.filename || "Your download"} expired mid-download. Refresh link in popup to resume.`,
              priority: 2
            });
          }
          notifyPopupPorts();
          break;
        }
        case "power_countdown": {
          notifyPopupPorts();
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.warn("[EDM Extension] Error handling inbound message:", e);
    }
  };
  socket.onclose = async () => {
    const wasConnected = connectionStatus === "connected";
    connectionStatus = "asleep";
    socket = null;
    stopPingInterval();
    notifyPopupPorts();
    console.debug("[EDM Extension] WebSocket connection closed.");
    const store = await chrome.storage.local.get("edm_auto_reconnect");
    if (store && store.edm_auto_reconnect === false) {
      console.debug("[EDM Extension] Auto-reconnect disabled in settings. Staying idle.");
      return;
    }
    const st = await checkIfEdmRunning();
    if (st.running) {
      if (st.token) {
        await chrome.storage.local.set({ edm_ws_token: st.token });
      }
      reconnectAttempts++;
      const delay = Math.min(1e3 * Math.pow(2, Math.min(reconnectAttempts, 5)), 3e4);
      console.debug(`[EDM Extension] EDM is running, scheduling reconnect in ${delay}ms`);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (connectionStatus !== "connected") {
          connectWebSocket();
        }
      }, delay);
    } else {
      console.debug("[EDM Extension] EDM is asleep or closed. Staying idle.");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
    }
  };
  socket.onerror = (err) => {
    console.debug("[EDM Extension] WebSocket event:", err);
    if (socket) {
      socket.close();
    }
  };
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
  if (connectionStatus === "asleep" || !socket || socket.readyState !== WebSocket.OPEN) {
    const wake = await wakeDesktop(false);
    if (!wake.ok) return { ok: false, error: wake.error || "EDM Desktop is not running" };
  }
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return resolve({ ok: false, error: "WebSocket not connected to EDM Desktop" });
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(rId);
      resolve({ ok: false, error: "Action timeout waiting for EDM Desktop" });
    }, 4e3);
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
async function sendWsRefreshTask(taskId, newUrl, reqId) {
  const rId = reqId || crypto.randomUUID();
  if (connectionStatus === "asleep" || !socket || socket.readyState !== WebSocket.OPEN) {
    const wake = await wakeDesktop(false);
    if (!wake.ok) return { ok: false, error: wake.error || "EDM Desktop is not running" };
  }
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return resolve({ ok: false, error: "WebSocket not connected to EDM Desktop" });
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(rId);
      resolve({ ok: false, error: "Refresh task timeout waiting for EDM Desktop" });
    }, 5e3);
    pendingAcks.set(rId, { resolve, timer });
    socket.send(
      JSON.stringify({
        type: "refresh_task",
        req_id: rId,
        task_id: taskId,
        new_url: newUrl
      })
    );
  });
}
async function sendWsProbeMedia(url, reqId) {
  const rId = reqId || crypto.randomUUID();
  if (connectionStatus === "asleep" || !socket || socket.readyState !== WebSocket.OPEN) {
    const wake = await wakeDesktop(false);
    if (!wake.ok) return { ok: false, error: wake.error || "EDM Desktop is not running" };
  }
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return resolve({ ok: false, error: "WebSocket not connected to EDM Desktop" });
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(rId);
      resolve({ ok: false, error: "Probe timeout waiting for EDM Desktop" });
    }, 12e3);
    pendingAcks.set(rId, {
      resolve: (ack) => resolve(ack),
      timer
    });
    socket.send(
      JSON.stringify({
        type: "probe_media",
        req_id: rId,
        media_url: url
      })
    );
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPorts.add(port);
    checkNmhHealth();
    port.postMessage({
      type: "snapshot",
      tasks: latestTasks,
      connectionStatus,
      lifecycleState: latestLifecycleState,
      nmhHealth,
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
      } else if (msg.type === "refresh_task") {
        const req_id = msg.req_id || crypto.randomUUID();
        sendWsRefreshTask(msg.task_id, msg.new_url, req_id).then((ack) => {
          try {
            port.postMessage({ type: "ack", ...ack, req_id });
          } catch {
          }
        });
      } else if (msg.type === "reconnect") {
        connectWebSocket();
      } else if (msg.type === "wake_desktop") {
        wakeDesktop(!!msg.show_window);
      } else if (msg.type === "get_diagnostics") {
        checkNmhHealth().then((h) => {
          try {
            port.postMessage({ type: "diagnostics_report", report: h.report || latestDiagnosticsReport });
          } catch {
          }
        });
      } else if (msg.type === "repair_registration") {
        chrome.runtime.sendNativeMessage("com.edm.nmh", { type: "repair_registration" }, (resp) => {
          checkNmhHealth().then((h) => {
            try {
              port.postMessage({
                type: "repair_result",
                ok: !!resp?.ok,
                message: resp?.message || "Repair completed",
                report: h.report || latestDiagnosticsReport
              });
            } catch {
            }
          });
        });
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
      activeHandoffsCount = Math.max(0, activeHandoffsCount - 1);
      onHandoffSettle();
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
  activeHandoffsCount++;
  (async () => {
    const store = await chrome.storage.local.get([
      "edm_interception_enabled",
      "edm_min_size",
      "edm_excluded_domains",
      "edm_file_extensions"
    ]);
    if (store && store.edm_interception_enabled === false) {
      safeSuggest();
      return;
    }
    const minSizeKb = Number(store?.edm_min_size || 0);
    if (minSizeKb > 0 && typeof item.fileSize === "number" && item.fileSize > 0) {
      if (item.fileSize < minSizeKb * 1024) {
        safeSuggest();
        return;
      }
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
    if (store?.edm_excluded_domains) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const domains = String(store.edm_excluded_domains).split("\n").map((d) => d.trim().toLowerCase()).filter(Boolean);
        if (domains.some(
          (d) => host === d || host.endsWith("." + d) || d.startsWith("*.") && host.endsWith(d.slice(1))
        )) {
          safeSuggest();
          return;
        }
      } catch {
      }
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
    if (store?.edm_file_extensions && filename) {
      const allowed = String(store.edm_file_extensions).split(",").map((x) => x.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
      if (allowed.length > 0) {
        const fileExt = filename.split(".").pop()?.toLowerCase() || "";
        if (!allowed.includes(fileExt)) {
          safeSuggest();
          return;
        }
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
        try {
          chrome.notifications.create("edm-wake-fail", {
            type: "basic",
            iconUrl: "logo.png",
            title: "EDM Wake Failed \u2014 Download Handled by Browser",
            message: `${wakeRes.error || "EDM could not be woken"}. Browser download resumed. Click to view Diagnostics.`,
            priority: 2
          });
        } catch {
        }
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
  if (msg.action === "refresh_task") {
    sendWsRefreshTask(msg.task_id, msg.new_url).then((res) => {
      sendResponse(res);
    });
    return true;
  }
  if (msg.action === "create_task") {
    const req_id = crypto.randomUUID();
    sendWsCreateTask({
      type: "create_task",
      req_id,
      url: msg.url,
      filename: msg.filename,
      referrer: msg.referrer,
      user_agent: navigator.userAgent,
      cookies: []
    }).then((res) => {
      sendResponse(res);
    });
    return true;
  }
  if (msg.action === "media_detected") {
    const tabId = _sender.tab?.id;
    if (tabId && Array.isArray(msg.media)) {
      detectedMediaByTab.set(tabId, msg.media);
      try {
        chrome.action.setBadgeText({
          text: msg.media.length > 0 ? String(msg.media.length) : "",
          tabId
        });
        chrome.action.setBadgeBackgroundColor({
          color: "#2563eb",
          tabId
        });
      } catch {
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === "get_detected_media") {
    const tabId = msg.tabId;
    const media = (tabId ? detectedMediaByTab.get(tabId) : []) || [];
    sendResponse({ ok: true, media });
    return true;
  }
  if (msg.action === "probe_media") {
    sendWsProbeMedia(msg.url).then((res) => {
      sendResponse(res);
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
            version: details?.version || chrome.runtime.getManifest().version
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
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMediaByTab.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    detectedMediaByTab.delete(tabId);
    try {
      chrome.action.setBadgeText({ text: "", tabId });
    } catch {
    }
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
  if (!socket || socket.readyState !== WebSocket.OPEN || connectionStatus !== "connected") {
    const wakeRes = await wakeDesktop(false);
    if (!wakeRes.ok) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "logo.png",
        title: "EDM Offline",
        message: "Could not wake EDM Desktop to handle context menu download."
      });
      return;
    }
  }
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
chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId === "edm-wake-fail") {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  }
});
async function initOnStartup() {
  const st = await checkIfEdmRunning();
  if (st.running) {
    if (st.token) {
      await chrome.storage.local.set({ edm_ws_token: st.token });
    }
    connectWebSocket();
  } else {
    connectionStatus = "asleep";
    notifyPopupPorts();
    console.debug("[EDM Extension] EDM is asleep on startup. Staying idle.");
  }
}
initOnStartup();
