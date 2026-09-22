import { disconnectBrowserDebugger, executeBrowserCommand } from "./browser-tools.js";
import { getOrCreateClientId, getSettings, updateSettings } from "./storage.js";
import { isCommand, PROTOCOL_VERSION, serializeError } from "../shared/protocol.js";

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let connectionState = { status: "disconnected", message: "尚未连接" };
const RECONNECT_DELAY_MS = 10_000;

function broadcastState() {
  chrome.runtime.sendMessage({ type: "bridge-state", state: connectionState }).catch(() => {});
}

function setConnectionState(status, message) {
  connectionState = { status, message };
  broadcastState();
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect().catch(() => {}), RECONNECT_DELAY_MS);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function realCodeOrigin(serverUrl) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

async function selectRealCodeTab(settings) {
  const origin = realCodeOrigin(settings.serverUrl);
  const tabs = await chrome.tabs.query({});
  const activeRealCode = tabs.find((tab) => {
    try { return tab.active && new URL(tab.url).origin === origin; }
    catch { return false; }
  });
  if (activeRealCode?.id) {
    if (settings.selectedTabId !== activeRealCode.id || settings.fallbackTabId !== null) {
      await updateSettings({ selectedTabId: activeRealCode.id, fallbackTabId: null });
      send({ type: "state", selectedTabId: activeRealCode.id });
    }
    return activeRealCode.id;
  }
  if (Number.isInteger(settings.selectedTabId)) {
    try {
      const selected = await chrome.tabs.get(settings.selectedTabId);
      if (new URL(selected.url).origin === origin || settings.selectedTabId === settings.fallbackTabId) return settings.selectedTabId;
      await updateSettings({ selectedTabId: null, fallbackTabId: null });
    } catch {
      await updateSettings({ selectedTabId: null, fallbackTabId: null });
    }
  }
  const matches = tabs.filter((tab) => {
    try { return new URL(tab.url).origin === origin; }
    catch { return false; }
  });
  const tab = matches.find((item) => item.active) ?? matches[0];
  if (!tab?.id) throw new Error(`找不到已打开的 RealCode 页面：${origin}`);
  await updateSettings({ selectedTabId: tab.id });
  send({ type: "state", selectedTabId: tab.id });
  return tab.id;
}

async function readPairingFromTab(tabId) {
  const [entry] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const response = await fetch(`${location.origin}/api/browser/pairing`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const pairing = await response.json();
      return {
        token: pairing.token,
        protocol: pairing.protocol,
        serverUrl: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser-extension`
      };
    }
  });
  const pairing = entry?.result;
  if (pairing?.protocol !== PROTOCOL_VERSION || typeof pairing.token !== "string" || !pairing.token) {
    throw new Error("当前页面不是可配对的 RealCode 页面");
  }
  return pairing;
}

async function discoverRealCode(settings) {
  const tabs = await chrome.tabs.query({});
  const configuredOrigin = realCodeOrigin(settings.serverUrl);
  const candidates = [];
  const add = (tab) => {
    if (tab?.id && !candidates.some((item) => item.id === tab.id)) candidates.push(tab);
  };
  if (Number.isInteger(settings.selectedTabId)) add(tabs.find((tab) => tab.id === settings.selectedTabId));
  add(tabs.find((tab) => tab.active && /^https?:/i.test(tab.url || "")));
  for (const tab of tabs) {
    try { if (new URL(tab.url).origin === configuredOrigin) add(tab); }
    catch {}
  }
  for (const tab of candidates) {
    try {
      const pairing = await readPairingFromTab(tab.id);
      return { ...pairing, selectedTabId: tab.id };
    } catch {}
  }
  throw new Error("找不到可配对的 RealCode 页面，请先打开 RealCode 并授权网页访问");
}

async function handleCommand(command) {
  const settings = await getSettings();
  try {
    const selectedTabId = await selectRealCodeTab(settings);
    const result = await executeBrowserCommand(command.method, command.args, selectedTabId);
    if ((command.method === "browser.openTab" || command.method === "browser.switchTab") && Number.isInteger(result?.tabId)) {
      await updateSettings({ selectedTabId: result.tabId, fallbackTabId: command.method === "browser.openTab" ? result.tabId : null });
      send({ type: "state", selectedTabId: result.tabId });
    }
    send({ type: "result", id: command.id, ok: true, result });
  } catch (error) {
    send({ type: "result", id: command.id, ok: false, error: serializeError(error) });
  }
}

async function connect() {
  let settings = await getSettings();
  if (!settings.serverUrl) throw new Error("请先填写 RealCode WebSocket 地址");
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

  clearTimers();
  setConnectionState("connecting", "正在连接 RealCode…");
  let discovered;
  try {
    discovered = await discoverRealCode(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setConnectionState("error", `${message}，10 秒后重试`);
    const latest = await getSettings();
    if (latest.autoConnect) scheduleReconnect();
    throw error;
  }
  settings = await updateSettings({
    serverUrl: discovered.serverUrl,
    pairingToken: discovered.token,
    selectedTabId: discovered.selectedTabId,
    fallbackTabId: null
  });
  const clientId = await getOrCreateClientId();
  const nextSocket = new WebSocket(settings.serverUrl);
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    setConnectionState("connecting", "正在验证配对令牌…");
    send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      clientId,
      token: settings.pairingToken,
      userAgent: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      selectedTabId: settings.selectedTabId
    });
  });

  nextSocket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === "ready" && message.protocol === PROTOCOL_VERSION) {
      setConnectionState("connected", "已连接，等待浏览器任务");
      heartbeatTimer = setInterval(() => send({ type: "ping", at: Date.now() }), 20_000);
      return;
    }
    if (isCommand(message)) void handleCommand(message);
  });

  nextSocket.addEventListener("close", (event) => {
    if (socket !== nextSocket) return;
    socket = null;
    clearTimers();
    const authenticationFailed = event.code === 4003;
    setConnectionState(authenticationFailed ? "error" : "disconnected", `${event.reason || "连接已断开"}，10 秒后重试`);
    void getSettings().then((latest) => {
      if (latest.autoConnect) scheduleReconnect();
    });
  });

  nextSocket.addEventListener("error", () => {
    if (socket === nextSocket) setConnectionState("error", "无法连接 RealCode");
  });
}

async function disconnect() {
  clearTimers();
  const current = socket;
  socket = null;
  current?.close(1000, "Disconnected by user");
  await disconnectBrowserDebugger();
  await updateSettings({ autoConnect: false });
  setConnectionState("disconnected", "已主动断开");
}

chrome.runtime.onInstalled.addListener(async () => {
  await getOrCreateClientId();
  const settings = await getSettings();
  if (settings.retryPolicyVersion < 1) {
    await updateSettings({ autoConnect: true, retryPolicyVersion: 1 });
    void connect().catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.autoConnect) void connect();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const settings = await getSettings();
  if (settings.selectedTabId === tabId) {
    await updateSettings({ selectedTabId: null, fallbackTabId: null });
    send({ type: "state", selectedTabId: null });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = async () => {
    switch (message?.type) {
      case "get-state":
        return { settings: await getSettings(), connectionState };
      case "save-settings":
        return { settings: await updateSettings(message.settings || {}) };
      case "connect":
        await updateSettings({ autoConnect: true });
        await connect();
        return { connectionState };
      case "disconnect":
        await disconnect();
        return { connectionState };
      case "select-active-tab": {
        const settings = await getSettings();
        await updateSettings({ selectedTabId: null });
        const tabId = await selectRealCodeTab({ ...settings, selectedTabId: null });
        const tab = await chrome.tabs.get(tabId);
        return { tab: { id: tab.id, title: tab.title, url: tab.url } };
      }
      case "test-snapshot": {
        const settings = await getSettings();
        return executeBrowserCommand("browser.snapshot", { maxElements: 20, maxTextLength: 600 }, settings.selectedTabId);
      }
      default:
        throw new Error("未知扩展消息");
    }
  };

  respond().then((result) => sendResponse({ ok: true, result })).catch((error) => {
    sendResponse({ ok: false, error: serializeError(error) });
  });
  return true;
});

void getSettings().then((settings) => {
  if (settings.autoConnect) void connect();
});
