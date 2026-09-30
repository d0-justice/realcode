import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { parseEscapedIframeSrc, parseLocalIframeSrc } from "./escaped-iframe.js";
import { configurePreviewFrame } from "./floating-window.js";
import { splitSystemReminderBlocks } from "./system-reminder.js";
import { BRAIN_ICON, CHEVRON_DOWN_ICON, CODE_XML_ICON, toolIcon } from "./chat-icons.js";

export function createChatView({ $, state, list, api, toast, renderActivity, renderContext, openFloatingPreview, focusFloatingPreview }) {
const welcomeTemplate = list.querySelector(".welcome").cloneNode(true);
let syncPromise;
let syncAgain = false;
const thoughtCloseTimers = new WeakMap();
function iframeUrl(text) {
  const value = text.trim();
  const escaped = value.startsWith("<iframe") ? value.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : value;
  return parseEscapedIframeSrc(escaped) ?? parseLocalIframeSrc(escaped);
}

function createIframeShell(frame, url) {
  const shell = document.createElement("div");
  shell.className = "message-iframe-shell";
  const status = document.createElement("button");
  status.type = "button";
  status.className = "message-iframe-status";
  const statusLabel = document.createElement("span");
  statusLabel.textContent = "已在浮窗中预览";
  status.append(statusLabel);
  status.addEventListener("click", () => focusFloatingPreview?.());
  if (frame.parentNode) frame.replaceWith(shell);
  shell.append(frame, status);
  return {
    shell,
    open: () => {
      shell.classList.add("floating-preview-source-active");
      openFloatingPreview(url, frame.title, shell);
    },
  };
}

function renderContent(body, role, text) {
  if (role === "assistant") {
    const url = iframeUrl(text);
    if (url) {
      if (body.dataset.iframeUrl === url) return;
      body.replaceChildren();
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = "RealCode 页面预览";
      frame.loading = "lazy";
      configurePreviewFrame(frame, url);
      frame.className = "message-iframe";
      const preview = createIframeShell(frame, url);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "新窗口打开 ↗";
      link.className = "iframe-link";
      const expand = document.createElement("button");
      expand.className = "iframe-expand";
      expand.textContent = "展开预览";
      expand.addEventListener("click", preview.open);
      body.append(preview.shell, expand, link);
      body.dataset.iframeUrl = url;
      return;
    }
  }
  if (body.dataset.iframeUrl) delete body.dataset.iframeUrl;
  if (role === "assistant") {
    body.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["src", "width", "height", "title", "loading", "sandbox"],
    });
    for (const frame of [...body.querySelectorAll("iframe")]) {
      const raw = frame.getAttribute("src") ?? "";
      const encoded = raw.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      const url = iframeUrl(`<iframe src="${encoded}"></iframe>`);
      if (!url) { frame.remove(); continue; }
      frame.src = url;
      frame.title = frame.title || "RealCode 页面预览";
      frame.loading = "lazy";
      configurePreviewFrame(frame, url);
      frame.className = "message-iframe";
      const preview = createIframeShell(frame, url);
      const expand = document.createElement("button");
      expand.className = "iframe-expand";
      expand.textContent = "展开预览";
      expand.addEventListener("click", preview.open);
      const link = document.createElement("a");
      link.className = "iframe-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "新窗口打开 ↗";
      preview.shell.after(expand, link);
    }
    for (const node of body.querySelectorAll("img[src], a[href]")) {
      const attr = node.tagName === "IMG" ? "src" : "href";
      const value = node.getAttribute(attr);
      if (/^(?:\.\/|\/)?user\//.test(value ?? "") && !value.split("/").includes("..")) node.setAttribute(attr, `/fs/${value.replace(/^(?:\.\/|\/)/, "").split("/").map(encodeURIComponent).join("/")}`);
      if (node.tagName === "A") { node.target = "_blank"; node.rel = "noopener noreferrer"; }
    }
    for (const code of body.querySelectorAll("pre code")) hljs.highlightElement(code);
  } else if (role === "user" && text.includes("<system-reminder>")) {
    body.replaceChildren();
    for (const segment of splitSystemReminderBlocks(text)) {
      if (segment.kind === "system") {
        const details = document.createElement("details");
        details.className = "system-reminder";
        const summary = document.createElement("summary");
        summary.textContent = "系统消息";
        const pre = document.createElement("pre");
        pre.textContent = segment.text;
        details.append(summary, pre);
        body.append(details);
      } else {
        const part = document.createElement("div");
        part.textContent = segment.text;
        body.append(part);
      }
    }
  } else body.textContent = text;
}

function narrateTool(title, details = {}) {
  const input = details.rawInput ?? {};
  const shortPath = (value) => String(value ?? "").split(/[\\/]/).at(-1) || String(value ?? "");
  const kind = String(details.kind ?? "").toLowerCase();
  if (kind === "read") return `读取 ${shortPath(input.filePath ?? input.path ?? title)}`;
  if (kind === "edit") return `编辑 ${shortPath(input.filePath ?? input.path ?? title)}`;
  if (kind === "write") return `写入 ${shortPath(input.filePath ?? input.path ?? title)}`;
  if (kind === "execute") return `执行 $ ${String(input.command ?? title).slice(0, 120)}`;
  if (kind === "search") return `搜索 ${String(input.pattern ?? input.query ?? title).slice(0, 100)}`;
  if (/^hindsight_/i.test(title)) return `记忆 · ${title.replace(/^hindsight_/i, "").replaceAll("_", " ")}`;
  if (kind === "agent" || /^(task|subagent)/i.test(title)) return `子 Agent · ${String(input.description ?? input.prompt ?? title).slice(0, 100)}`;
  return title;
}

function toolStatusLabel(status) {
  switch (status) {
    case "completed": case "complete": return "已完成";
    case "failed": case "error": return "失败";
    case "in_progress": case "running": return "进行中";
    case "pending": case "waiting_for_confirmation": return "待确认";
    case "cancelled": case "canceled": case "rejected": return "已取消";
    default: return status ?? "进行中";
  }
}

function upsertMessage({ id, role, text, images, details }) {
  const followBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150;
  let row = state.messages.get(id);
  if (!row) {
    const welcome = list.querySelector(".welcome");
    if (welcome) welcome.remove();
    row = document.createElement(role === "thought" ? "details" : "article");
    row.className = `message ${role}`;
    const head = document.createElement(role === "thought" ? "summary" : "div");
    head.className = "message-header";
    head.textContent = role === "user" ? "你" : role === "assistant" ? "RealCode" : role === "thought" ? "思考过程" : "工具调用";
    const body = document.createElement("div");
    body.className = "message-body";
    row.append(head, body);
    if (role === "thought") {
      head.innerHTML = `${BRAIN_ICON}<span class="thought-label"></span>${CHEVRON_DOWN_ICON}`;
      if (state.busy && state.snapshotMessages.at(-1)?.id === id) { row.open = true; row.dataset.autoOpened = "true"; }
      head.addEventListener("click", () => {
        row.dataset.manualToggle = "true";
        clearTimeout(thoughtCloseTimers.get(row));
        thoughtCloseTimers.delete(row);
      });
    }
    if (role === "tool") {
      const icon = document.createElement("span");
      icon.className = "tool-icon";
      icon.setAttribute("aria-hidden", "true");
      row.insertBefore(icon, head);
    }
    list.append(row);
    state.messages.set(id, row);
  }
  renderContent(row.querySelector(".message-body"), role, role === "tool" ? narrateTool(text, details) : text);
  if (role === "thought") {
    const isStreamingThought = state.busy && state.snapshotMessages.at(-1)?.id === id;
    row.querySelector(".thought-label").textContent = isStreamingThought ? "思考中..." : "思考了一会";
    if (!isStreamingThought && row.dataset.autoOpened === "true" && row.dataset.manualToggle !== "true" && !thoughtCloseTimers.has(row)) {
      thoughtCloseTimers.set(row, setTimeout(() => {
        row.open = false;
        row.dataset.autoOpened = "done";
        thoughtCloseTimers.delete(row);
      }, 1000));
    }
    if (isStreamingThought && row.dataset.autoOpened === "true") row.querySelector(".message-body").scrollTop = row.querySelector(".message-body").scrollHeight;
  }
  if (role === "user") {
    let imagesNode = row.querySelector(".message-images");
    if (images?.length) {
      if (!imagesNode) { imagesNode = document.createElement("div"); imagesNode.className = "message-images"; row.insertBefore(imagesNode, row.querySelector(".message-body")); }
      imagesNode.replaceChildren();
      for (const image of images) {
        const thumbnail = document.createElement("img");
        thumbnail.src = `data:${image.mimeType};base64,${image.data}`;
        thumbnail.alt = "已附加图片";
        thumbnail.addEventListener("click", () => { $("#image-expanded").src = thumbnail.src; $("#image-modal").hidden = false; });
        imagesNode.append(thumbnail);
      }
    } else imagesNode?.remove();
    const body = row.querySelector(".message-body");
    let expand = row.querySelector(".message-expand");
    if (text.length > 500) {
      if (!expand) {
        expand = document.createElement("button");
        expand.className = "message-expand";
        expand.textContent = "展开消息";
        expand.addEventListener("click", () => { row.classList.toggle("expanded"); expand.textContent = row.classList.contains("expanded") ? "收起消息" : "展开消息"; });
        row.append(expand);
      }
      body.classList.toggle("collapsed", !row.classList.contains("expanded"));
    } else { expand?.remove(); body.classList.remove("collapsed"); }
  }
  if (role === "tool" && details) {
    row.classList.toggle("hindsight", /^hindsight_/i.test(text));
    row.classList.toggle("subagent", details.kind === "agent" || /^(task|subagent)/i.test(text));
    const kind = String(details.kind ?? "").toLowerCase();
    if (row.dataset.toolKind !== kind) {
      row.dataset.toolKind = kind;
      row.querySelector(".tool-icon").innerHTML = toolIcon(kind);
    }
    row.dataset.toolStatus = String(details.status ?? "running").toLowerCase();
    row.querySelector(".message-header").textContent = toolStatusLabel(details.status);
    let detailButton = row.querySelector(".tool-details-toggle");
    if (!detailButton) {
      detailButton = document.createElement("button");
      detailButton.type = "button";
      detailButton.className = "tool-details-toggle";
      detailButton.innerHTML = `${CODE_XML_ICON}<span class="sr-only">查看输入与输出</span>`;
      detailButton.title = "查看输入与输出";
      detailButton.setAttribute("aria-expanded", "false");
      const pre = document.createElement("pre");
      pre.className = "tool-details-content";
      pre.hidden = true;
      pre.id = `tool-details-${crypto.randomUUID()}`;
      detailButton.setAttribute("aria-controls", pre.id);
      detailButton.addEventListener("click", () => {
        const scrollTop = list.scrollTop;
        pre.hidden = !pre.hidden;
        list.scrollTop = scrollTop;
        const label = pre.hidden ? "查看输入与输出" : "收起输入与输出";
        detailButton.setAttribute("aria-expanded", String(!pre.hidden));
        detailButton.title = label;
        detailButton.querySelector(".sr-only").textContent = label;
      });
      row.append(detailButton, pre);
    }
    row.querySelector(".tool-details-content").textContent = JSON.stringify(details, null, 2);
    let files = row.querySelector(".tool-files");
    if (!files) { files = document.createElement("div"); files.className = "tool-files"; row.append(files); }
    files.replaceChildren();
    for (const location of details.locations ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `预览 ${location.path.split(/[\\/]/).at(-1)}`;
      button.addEventListener("click", async () => {
        try {
          const result = await api(`/api/file?path=${encodeURIComponent(location.path)}`);
          $("#file-title").textContent = result.path;
          $("#file-content").textContent = result.content;
          $("#file-modal").hidden = false;
        } catch (error) { toast(error.message); }
      });
      files.append(button);
    }
    const nested = details.rawOutput?.subEntries ?? details.rawOutput?.messages;
    let nestedPanel = row.querySelector(".subagent-panel");
    if (Array.isArray(nested) && nested.length) {
      if (!nestedPanel) { nestedPanel = document.createElement("div"); nestedPanel.className = "subagent-panel"; row.append(nestedPanel); }
      nestedPanel.replaceChildren();
      for (const entry of nested.slice(0, 100)) {
        const item = document.createElement("div");
        item.textContent = typeof entry === "string" ? entry : String(entry.text ?? entry.content ?? entry.title ?? JSON.stringify(entry));
        nestedPanel.append(item);
      }
    } else nestedPanel?.remove();
  }
  if (followBottom) list.scrollTop = list.scrollHeight;
  updateScrollButton();
}

function updateScrollButton() {
  $("#scroll-bottom").hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 180;
}

async function performSyncMessages() {
  if (!state.sessionId) return;
  const snapshot = await api("/api/session/messages");
  if (snapshot.sessionId !== state.sessionId) return;
  state.snapshotMessages = snapshot.messages;
  const ids = new Set();
  for (const message of snapshot.messages) { ids.add(message.id); upsertMessage(message); }
  for (const [id, row] of state.messages) if (!ids.has(id)) { row.remove(); state.messages.delete(id); }
  if (snapshot.messages.length) {
    const followBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150;
    const oldScrollTop = list.scrollTop;
    const ordered = [];
    let group = null;
    for (const message of snapshot.messages) {
      const row = state.messages.get(message.id);
      if (!row) continue;
      if (message.role === "tool") {
        if (!group) {
          group = document.createElement("section");
          group.className = "tool-group";
          ordered.push(group);
        }
        group.append(row);
      } else {
        group = null;
        ordered.push(row);
      }
    }
    list.replaceChildren(...ordered);
    if (followBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = oldScrollTop;
  }
  updateScrollButton();
  renderActivity(snapshot.messages);
  renderContext(snapshot.messages);
}

function syncMessages() {
  if (syncPromise) { syncAgain = true; return syncPromise; }
  syncPromise = (async () => {
    do {
      syncAgain = false;
      await performSyncMessages();
    } while (syncAgain);
  })().finally(() => { syncPromise = undefined; });
  return syncPromise;
}

function resetMessages() {
  state.messages.clear();
  state.snapshotMessages = [];
  list.replaceChildren(welcomeTemplate.cloneNode(true));
}


return { upsertMessage, syncMessages, resetMessages, updateScrollButton };
}
