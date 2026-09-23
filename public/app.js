import { createAttachments } from "./attachments.js";
import { createChatView } from "./chat-view.js";
import { createDialogs } from "./dialogs.js";
import { createFloatingWindow } from "./floating-window.js";
import { groupByRecency } from "./session-grouping.js";
import { createResourceBrowser } from "./resource-browser.js";

const $ = (selector) => document.querySelector(selector);
const state = { connected: false, sessionId: null, busy: false, messages: new Map(), pendingPermission: null, pendingQuestion: null, title: "新会话", supportsImages: false, agentSupportsImages: false, files: [], images: [], commands: [], planEntries: [], usage: null, workspace: "", snapshotMessages: [], browser: { connected: false, authenticated: false, selectedTabId: null } };
const list = $("#message-list");
const trace = $("#event-list");
let toastTimer;
let bootstrapPromise;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
}

function showError(message) {
  $("#error-text").textContent = message;
  $("#error-banner").hidden = false;
  toast(message);
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function renderStatus() {
  const pill = $("#connection-pill");
  pill.classList.toggle("connected", state.connected);
  pill.lastChild.textContent = state.connected ? "已连接" : "未连接";
  $("#connect-button").disabled = state.connected;
  $("#new-button").disabled = !state.connected || state.busy;
  $("#refresh-button").disabled = !state.connected;
  $("#prompt-input").disabled = !state.connected || !state.sessionId || state.busy;
  $("#send-button").disabled = !state.connected || !state.sessionId || state.busy;
  $("#cancel-button").disabled = !state.busy;
  $("#loading-indicator").hidden = !state.busy;
  $("#attach-file").disabled = !state.connected || !state.sessionId || state.busy;
  $("#attach-image").disabled = !state.connected || !state.sessionId || state.busy || !state.supportsImages;
  $("#session-id").textContent = state.sessionId || "NO SESSION";
  $("#conversation-title").textContent = state.title;
}

function renderBrowserBridge(status = state.browser) {
  state.browser = status ?? { connected: false, authenticated: false, selectedTabId: null };
  const ready = state.browser.connected && state.browser.authenticated;
  const selected = Number.isInteger(state.browser.selectedTabId);
  const button = $("#browser-bridge-button");
  button.classList.toggle("connected", ready);
  button.querySelector("span").textContent = ready ? (selected ? "扩展已连接" : "请选择标签页") : "扩展未连接";
  const card = $("#browser-modal-status");
  card.classList.toggle("connected", ready);
  card.querySelector("strong").textContent = ready ? "Chrome 扩展已连接" : "扩展未连接";
  card.querySelector("span").textContent = ready
    ? `${state.browser.extensionVersion ? `版本 ${state.browser.extensionVersion} · ` : ""}${selected ? `标签页 ${state.browser.selectedTabId}` : "尚未选择标签页"}`
    : "安装扩展后使用下方令牌配对";
}

async function openBrowserPairing() {
  const pairing = await api("/api/browser/pairing");
  $("#browser-websocket-url").textContent = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser-extension`;
  renderBrowserBridge(pairing.status);
  $("#browser-modal").hidden = false;
}

function renderActivity(snapshotMessages = []) {
  const panel = $("#activity-panel");
  const lastTodo = [...snapshotMessages].reverse().find((item) => item.role === "tool" && /todo/i.test(item.text) && Array.isArray(item.details?.rawInput?.todos));
  const items = state.planEntries.length ? state.planEntries : lastTodo?.details.rawInput.todos ?? [];
  panel.hidden = items.length === 0;
  panel.replaceChildren();
  if (!items.length) return;
  const heading = document.createElement("strong");
  heading.textContent = state.planEntries.length ? "执行计划" : "待办事项";
  panel.append(heading);
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `activity-item ${item.status ?? "pending"}`;
    row.textContent = `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"} ${item.content ?? item.text ?? "任务"}`;
    panel.append(row);
  }
}

const { renderAttachments, renderCommands, addFiles, addImages } = createAttachments({ $, state, api });

function renderConfig(options = []) {
  const effortLabels = { none: "无", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", default: "默认" };
  for (const category of ["mode", "model", "effort"]) {
    const select = $(`#${category}-select`);
    const option = options.find((item) => item.id === category || item.category === (category === "effort" ? "thought_level" : category));
    select.hidden = !option?.options?.length;
    select.replaceChildren();
    if (!option) continue;
    select.dataset.configId = option.id;
    for (const choice of option.options) {
      const item = document.createElement("option");
      item.value = choice.value;
      item.textContent = category === "effort" ? `推理 · ${effortLabels[choice.value] ?? choice.name}` : choice.name;
      select.append(item);
    }
    select.value = option.currentValue;
    select.dataset.currentValue = option.currentValue;
  }
  const model = options.find((item) => item.category === "model" || item.id === "model")?.currentValue;
  state.supportsImages = state.agentSupportsImages && model !== "opencode/big-pickle";
  renderStatus();
  renderContext();
}

function renderContext(snapshotMessages = state.snapshotMessages) {
  const stats = $("#context-stats");
  const model = $("#model-select").selectedOptions[0]?.textContent ?? "未选择";
  const effort = $("#effort-select").selectedOptions[0]?.textContent ?? "未提供";
  const usage = state.usage;
  const changedFiles = [...new Set(snapshotMessages.filter((item) => item.role === "tool" && ["edit", "write"].includes(item.details?.kind)).flatMap((item) => (item.details?.locations ?? []).map((location) => location.path)))];
  const values = [
    ["模型", model],
    ["推理强度", effort],
    ["输入 token", String(usage?.inputTokens ?? "—")],
    ["输出 token", String(usage?.outputTokens ?? "—")],
    ["消息", String(snapshotMessages.filter((item) => item.role === "user" || item.role === "assistant").length)],
    ["工具调用", String(snapshotMessages.filter((item) => item.role === "tool").length)],
    ["更改文件", String(changedFiles.length)],
    ["工作区", state.workspace],
  ];
  stats.replaceChildren();
  for (const [label, value] of values) {
    const row = document.createElement("div");
    const name = document.createElement("span"); name.textContent = label;
    const detail = document.createElement("strong"); detail.textContent = value;
    row.append(name, detail); stats.append(row);
  }
  if (changedFiles.length) {
    const files = document.createElement("ul");
    files.className = "changed-files";
    for (const path of changedFiles) {
      const item = document.createElement("li");
      item.textContent = path.split(/[\\/]/).at(-1);
      item.title = path;
      files.append(item);
    }
    stats.append(files);
  }
}

const floatingWindow = createFloatingWindow({ $, api, toast });
const { upsertMessage, syncMessages, resetMessages, updateScrollButton } = createChatView({ $, state, list, api, toast, renderActivity, renderContext, openFloatingPreview: floatingWindow.openFrame });

function appendTrace(event) {
  const item = document.createElement("div");
  item.className = "event-item";
  const head = document.createElement("div");
  head.className = "event-top";
  const title = document.createElement("span");
  title.textContent = event.type.toUpperCase();
  const time = document.createElement("time");
  time.textContent = new Date(event.at).toLocaleTimeString();
  head.append(title, time);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(event.data, null, 2);
  item.append(head, pre);
  trace.prepend(item);
  while (trace.children.length > 80) trace.lastElementChild.remove();
}

const { showPermission, answerPermission, showQuestion, answerQuestion } = createDialogs({ $, state, api, toast });
const resourceBrowser = createResourceBrowser({ $, api, toast, openFile: floatingWindow.openFile });

function onEvent(event) {
  appendTrace(event);
  if (event.type === "status" || event.type === "connection") {
    state.connected = event.data.connected;
    if (event.type === "connection" && !state.connected) setTimeout(() => bootstrapSession(), 1500);
    if (event.type === "status") {
      state.sessionId = event.data.sessionId;
      state.busy = event.data.busy;
      state.agentSupportsImages = event.data.promptSupportsImages === true;
      state.supportsImages = event.data.supportsImages === true;
      state.commands = event.data.availableCommands ?? [];
      state.planEntries = event.data.planEntries ?? [];
      renderActivity();
      renderCommands();
      $("#workspace-path").textContent = event.data.workspace;
      state.workspace = event.data.workspace;
      state.usage = event.data.lastUsage;
      renderBrowserBridge(event.data.browser);
      renderConfig(event.data.configOptions);
      if (event.data.questions?.length) showQuestion(event.data.questions[0]);
      if (event.data.permissions?.length) showPermission(event.data.permissions[0]);
      syncMessages().catch((error) => toast(error.message));
    }
    renderStatus();
  }
  if (event.type === "browser_bridge") renderBrowserBridge(event.data);
  if (event.type === "session_reset") {
    resetMessages();
    if (event.data.sessionId === null) { state.sessionId = null; state.title = "新会话"; renderStatus(); }
  }
  if (event.type === "session") {
    state.sessionId = event.data.sessionId;
    state.title = event.data.action === "new" ? "新会话" : state.title;
    state.planEntries = [];
    state.usage = null;
    renderActivity();
    renderContext();
    if (event.data.action === "new") resetMessages();
    renderConfig(event.data.result?.configOptions);
    renderStatus();
    refreshSessions();
    syncMessages().catch((error) => toast(error.message));
  }
  if (event.type === "user_message") { upsertMessage({ id: `user-live-${Date.now()}`, role: "user", text: event.data.text }); syncMessages().catch((error) => toast(error.message)); }
  if (event.type === "update") {
    const update = event.data.update || {};
    if (update.sessionUpdate === "available_commands_update") { state.commands = update.availableCommands ?? []; renderCommands(); }
    if (update.sessionUpdate === "plan") { state.planEntries = update.entries ?? []; renderActivity(); }
    if (update.sessionUpdate === "plan_update" && update.plan?.type === "items") { state.planEntries = update.plan.entries ?? []; renderActivity(); }
    if (update.sessionUpdate === "plan_removed") { state.planEntries = []; renderActivity(); }
    if (update.sessionUpdate === "config_option_update") renderConfig(update.configOptions);
    if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      syncMessages().catch((error) => toast(error.message));
    }
  }
  if (event.type === "permission") showPermission(event.data);
  if (event.type === "question") showQuestion(event.data);
  if (event.type === "question_expired" && state.pendingQuestion?.requestId === event.data.requestId) { state.pendingQuestion = null; $("#question-modal").hidden = true; toast("问题已超时"); }
  if (event.type === "configuration" && event.data.configOptions) renderConfig(event.data.configOptions);
  if (event.type === "prompt_complete" && !$("#inspector").hidden) void resourceBrowser.refresh();
  if (event.type === "prompt_complete" && event.data.usage) {
    const usage = event.data.usage;
    state.usage = usage;
    renderContext();
    $("#usage-label").textContent = `${usage.inputTokens ?? 0} 输入 · ${usage.outputTokens ?? 0} 输出 token`;
  }
  if (event.type === "permission_expired" && state.pendingPermission?.requestId === event.data.requestId) {
    state.pendingPermission = null;
    $("#permission-modal").hidden = true;
    toast("权限请求已超时");
  }
  if (event.type === "idle") { state.busy = false; renderStatus(); syncMessages().catch((error) => toast(error.message)); refreshSessions(); }
}

async function refreshSessions() {
  if (!state.connected) return null;
  try {
    const result = await api("/api/sessions");
    const container = $("#session-list");
    container.replaceChildren();
    if (!result.sessions?.length) { container.innerHTML = '<div class="empty-list">尚无历史会话</div>'; return []; }
    const groups = groupByRecency(result.sessions, { today: "今天", yesterday: "昨天", earlier: "更早" });
    let lastGroup = "";
    for (const session of groups.flatMap((group) => group.sessions)) {
      const group = groups.find((item) => item.sessions.includes(session)).label;
      if (group !== lastGroup) {
        const heading = document.createElement("div");
        heading.className = "session-group";
        heading.textContent = group;
        container.append(heading);
        lastGroup = group;
      }
      const button = document.createElement("button");
      button.className = `session-item ${session.sessionId === state.sessionId ? "active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = session.title || "新会话";
      if (session.sessionId === state.sessionId && session.title) { state.title = session.title; renderStatus(); }
      const id = document.createElement("small");
      id.textContent = session.sessionId;
      button.append(title, id);
      button.addEventListener("click", async () => {
        try {
          state.title = title.textContent;
          await api("/api/session/load", { sessionId: session.sessionId });
          await syncMessages();
          renderStatus();
        } catch (error) { toast(error.message); }
      });
      const row = document.createElement("div");
      row.className = "session-row";
      const rename = document.createElement("button");
      rename.className = "session-rename";
      rename.textContent = "✎";
      rename.title = "重命名会话";
      rename.setAttribute("aria-label", `重命名会话 ${title.textContent}`);
      rename.addEventListener("click", async () => {
        const next = prompt("会话标题", title.textContent);
        if (!next?.trim() || next.trim() === title.textContent) return;
        try { await api("/api/session/rename", { sessionId: session.sessionId, title: next.trim() }); await refreshSessions(); }
        catch (error) { toast(error.message); }
      });
      const remove = document.createElement("button");
      remove.className = "session-delete";
      remove.textContent = "×";
      remove.title = "删除会话";
      remove.setAttribute("aria-label", `删除会话 ${title.textContent}`);
      remove.addEventListener("click", async () => {
        if (!confirm(`确定删除“${title.textContent}”？`)) return;
        try { await api("/api/session/delete", { sessionId: session.sessionId }); await refreshSessions(); }
        catch (error) { toast(error.message); }
      });
      row.append(button, rename, remove);
      container.append(row);
    }
    return result.sessions;
  } catch (error) { toast(error.message); return null; }
}

function bootstrapSession() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    if (!state.connected) {
      const status = await api("/api/connect", {});
      state.connected = status.connected;
      state.agentSupportsImages = status.promptSupportsImages === true;
      state.supportsImages = status.supportsImages === true;
      renderStatus();
    }
    const sessions = await refreshSessions();
    if (sessions === null) return;
    if (!state.sessionId) {
      if (sessions?.length) {
        state.sessionId = sessions[0].sessionId;
        state.title = sessions[0].title || "新会话";
        await api("/api/session/load", { sessionId: state.sessionId });
        await syncMessages();
      } else {
        const created = await api("/api/session/new", {});
        state.sessionId = created.sessionId;
      }
      renderStatus();
      await refreshSessions();
    }
  })().then(() => { $("#error-banner").hidden = true; }).catch((error) => showError(error.message)).finally(() => { bootstrapPromise = undefined; });
  return bootstrapPromise;
}

$("#connect-button").addEventListener("click", async () => {
  await bootstrapSession();
});
$("#new-button").addEventListener("click", async () => {
  try { await api("/api/session/new", {}); } catch (error) { toast(error.message); }
});
$("#refresh-button").addEventListener("click", refreshSessions);
$("#trace-toggle").addEventListener("click", () => {
  const panel = $("#inspector");
  panel.hidden = !panel.hidden;
  $("#trace-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) resourceBrowser.open();
});
$("#clear-events").addEventListener("click", () => trace.replaceChildren());
$("#browser-bridge-button").addEventListener("click", () => openBrowserPairing().catch((error) => toast(error.message)));
$("#browser-modal-close").addEventListener("click", () => { $("#browser-modal").hidden = true; });
$("#browser-rotate-token").addEventListener("click", async () => {
  try {
    const pairing = await api("/api/browser/rotate-token", {});
    renderBrowserBridge(pairing.status);
    toast("已更新配对令牌，扩展将自动重新连接");
  } catch (error) { toast(error.message); }
});
list.addEventListener("scroll", updateScrollButton);
$("#scroll-bottom").addEventListener("click", () => list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }));
$("#error-close").addEventListener("click", () => { $("#error-banner").hidden = true; });
$("#deny-permission").addEventListener("click", () => answerPermission());
$("#decline-question").addEventListener("click", () => answerQuestion());
$("#question-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = {};
  for (const [name, schema] of Object.entries(state.pendingQuestion?.schema?.properties ?? {})) {
    const inputs = [...$("#question-fields").querySelectorAll("input, select")].filter((input) => input.name === name);
    if (schema.type === "array") {
      const values = inputs.filter((input) => input.checked).map((input) => input.value);
      if (values.length < (schema.minItems ?? 0) || values.length > (schema.maxItems ?? Infinity)) { showError(`请选择 ${schema.minItems ?? 0} 到 ${schema.maxItems ?? "不限"} 项`); return; }
      content[name] = values;
    } else {
      const input = inputs[0];
      if (input) content[name] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    }
  }
  answerQuestion(content);
});
$("#cancel-button").addEventListener("click", async () => {
  try { await api("/api/session/cancel", {}); } catch (error) { toast(error.message); }
});
$("#attach-file").addEventListener("click", () => $("#file-input").click());
$("#attach-image").addEventListener("click", () => $("#image-input").click());
$("#file-input").addEventListener("change", async (event) => { try { await addFiles([...event.target.files]); } catch (error) { toast(error.message); } event.target.value = ""; });
$("#image-input").addEventListener("change", async (event) => { try { await addImages([...event.target.files]); } catch (error) { toast(error.message); } event.target.value = ""; });
$("#prompt-input").addEventListener("paste", async (event) => {
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  try { await addImages(images); } catch (error) { toast(error.message); }
});
$("#composer").addEventListener("dragover", (event) => event.preventDefault());
$("#composer").addEventListener("drop", async (event) => {
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  try {
    await addImages(files.filter((file) => file.type.startsWith("image/")));
    await addFiles(files.filter((file) => !file.type.startsWith("image/")));
  } catch (error) { toast(error.message); }
});
for (const category of ["mode", "model", "effort"]) {
  $(`#${category}-select`).addEventListener("change", async (event) => {
    const select = event.target;
    try { renderConfig((await api("/api/session/config", { configId: select.dataset.configId, value: select.value })).configOptions); }
    catch (error) { select.value = select.dataset.currentValue; toast(error.message); }
  });
}
$("#file-close").addEventListener("click", () => { $("#file-modal").hidden = true; });
$("#image-close").addEventListener("click", () => { $("#image-modal").hidden = true; $("#image-expanded").removeAttribute("src"); });
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#prompt-input");
  const text = input.value.trim();
  if ((!text && !state.files.length && !state.images.length) || state.busy) return;
  const promptText = `${text}${state.files.length ? `\n\n附加文件（位于当前工作区）：\n${state.files.map((file) => `- ${file.path}`).join("\n")}` : ""}`;
  state.busy = true;
  renderStatus();
  try {
    await api("/api/session/prompt", { text: promptText, images: state.images.map(({ data, mimeType }) => ({ data, mimeType })) });
    $("#error-banner").hidden = true;
    input.value = "";
    state.files = [];
    state.images = [];
    renderAttachments();
    await syncMessages();
  }
  catch (error) { showError(error.message); }
  finally { state.busy = false; renderStatus(); }
});
$("#prompt-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { $("#command-menu").hidden = true; return; }
  if (event.key === "Enter" && !$("#command-menu").hidden) {
    const first = $("#command-menu button");
    if (first) { event.preventDefault(); first.click(); return; }
  }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); }
});
$("#prompt-input").addEventListener("input", renderCommands);

const events = new EventSource("/api/events");
events.onmessage = (message) => { try { onEvent(JSON.parse(message.data)); } catch (error) { console.error(error); } };
events.onopen = () => {
  api("/api/status").then(async (status) => {
    onEvent({ type: "status", at: new Date().toISOString(), data: status });
    await bootstrapSession();
  }).catch((error) => toast(error.message));
};
events.onerror = () => toast("事件连接中断，正在重连…");
