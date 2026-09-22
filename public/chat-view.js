import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { parseEscapedIframeSrc, parseLocalIframeSrc } from "./escaped-iframe.js";
import { splitSystemReminderBlocks } from "./system-reminder.js";

export function createChatView({ $, state, list, api, toast, renderActivity, renderContext }) {
const welcomeTemplate = list.querySelector(".welcome").cloneNode(true);
let syncPromise;
let syncAgain = false;
const LOCAL_FRAME_SANDBOX = "allow-scripts allow-forms allow-downloads";
const EXTERNAL_FRAME_SANDBOX = `${LOCAL_FRAME_SANDBOX} allow-same-origin allow-modals allow-presentation`;

function configurePreviewFrame(frame, url) {
  const external = /^https?:\/\//i.test(url);
  frame.setAttribute("sandbox", external ? EXTERNAL_FRAME_SANDBOX : LOCAL_FRAME_SANDBOX);
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  if (external) {
    frame.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write");
    frame.setAttribute("allowfullscreen", "");
  } else {
    frame.removeAttribute("allow");
    frame.removeAttribute("allowfullscreen");
  }
}

function openFloatingPreview(url) {
  const expanded = $("#iframe-expanded");
  configurePreviewFrame(expanded, url);
  expanded.name = "realcode-floating-preview";
  expanded.dataset.realcodeControlTarget = "true";
  expanded.src = url;
  $("#iframe-modal").hidden = false;
}

function iframeUrl(text) {
  const value = text.trim();
  const escaped = value.startsWith("<iframe") ? value.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : value;
  return parseEscapedIframeSrc(escaped) ?? parseLocalIframeSrc(escaped);
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
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "新窗口打开 ↗";
      link.className = "iframe-link";
      const expand = document.createElement("button");
      expand.className = "iframe-expand";
      expand.textContent = "展开预览";
      expand.addEventListener("click", () => openFloatingPreview(url));
      body.append(frame, expand, link);
      body.dataset.iframeUrl = url;
      return;
    }
  }
  if (body.dataset.iframeUrl) delete body.dataset.iframeUrl;
  if (role === "assistant" || role === "thought") {
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
      const expand = document.createElement("button");
      expand.className = "iframe-expand";
      expand.textContent = "展开预览";
      expand.addEventListener("click", () => openFloatingPreview(url));
      const link = document.createElement("a");
      link.className = "iframe-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "新窗口打开 ↗";
      frame.after(expand, link);
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
    list.append(row);
    state.messages.set(id, row);
  }
  renderContent(row.querySelector(".message-body"), role, role === "tool" ? narrateTool(text, details) : text);
  if (role === "thought") row.querySelector(".message-header").textContent = state.busy ? "思考中…" : "思考过程";
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
    row.querySelector(".message-header").textContent = `工具调用 · ${details.status ?? "进行中"}`;
    let detailNode = row.querySelector(".tool-details");
    if (!detailNode) {
      detailNode = document.createElement("details");
      detailNode.className = "tool-details";
      const summary = document.createElement("summary");
      summary.textContent = "查看输入与输出";
      const pre = document.createElement("pre");
      detailNode.append(summary, pre);
      row.append(detailNode);
    }
    detailNode.querySelector("pre").textContent = JSON.stringify(details, null, 2);
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
