const ICON_PATHS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3z"/>',
  file: '<path d="M6 3h8l5 5v13H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v6h5"/>',
  filePlus: '<path d="M6 3h8l5 5v13H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v6h5M9 15h6m-3-3v6"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3z"/><path d="M12 11v6m-3-3h6"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L4 8m0-4v4h4M4 13a8 8 0 0 0 14 5l2-2m0 4v-4h-4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};

function icon(name, className = "") {
  const span = document.createElement("span");
  span.className = `resource-icon ${className}`.trim();
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
  return span;
}

function fileKind(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return ["IMG", "image"];
  if (["ts", "tsx", "js", "jsx", "mjs"].includes(extension)) return [extension.toUpperCase(), "code"];
  if (["html", "htm", "css", "scss", "vue"].includes(extension)) return [extension.toUpperCase(), "web"];
  if (["json", "yaml", "yml", "toml", "xml"].includes(extension)) return [extension.toUpperCase(), "data"];
  if (["md", "mdx"].includes(extension)) return ["MD", "markdown"];
  if (extension === "pdf") return ["PDF", "pdf"];
  return ["", "file"];
}

function entryButton(entry, expanded, action) {
  const button = makeButton("", entry.path || "选择工作区根目录", action, "resource-name");
  if (entry.path) {
    const chevron = icon("chevron", `resource-chevron${expanded ? " expanded" : ""}`);
    if (!entry.isDir) chevron.classList.add("placeholder");
    button.append(chevron);
  }
  const visual = document.createElement("span");
  const [badge, kind] = entry.isDir ? ["", "folder"] : fileKind(entry.name);
  visual.className = `resource-file-icon ${kind}`;
  if (entry.isDir) visual.append(icon("folder"));
  else if (badge) visual.textContent = badge;
  else visual.append(icon("file"));
  const label = document.createElement("span");
  label.className = "resource-filename";
  label.textContent = entry.name;
  button.append(visual, label);
  return button;
}

function fileUrl(path, download = false) {
  return `/api/workspace/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

function makeButton(text, title, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.className = className;
  button.addEventListener("click", action);
  return button;
}

/** Local workspace file tree adapted from FenixAgent's FileTreeTab and PreviewTab flow. */
export function createResourceBrowser({ $, api, toast, openFile }) {
  const tree = $("#resource-tree");
  const status = $("#resource-status");
  const count = $("#resource-count");
  const uploadInput = $("#resource-upload-input");
  const expanded = new Set();
  let entries = [];
  let selectedDir = "";
  let loaded = false;
  let stale = false;

  function setStatus(message) {
    status.textContent = message;
    status.title = message;
  }

  function closeMenus() {
    document.querySelectorAll(".resource-menu").forEach((menu) => { menu.hidden = true; menu.remove(); });
  }

  async function refresh() {
    setStatus("正在读取工作区…");
    try {
      const result = await api("/api/workspace/resources");
      entries = result.entries ?? [];
      stale = false;
      loaded = true;
      render();
    } catch (error) {
      stale = true;
      setStatus(`读取失败：${error.message}`);
      toast(error.message);
    }
  }

  async function mutate(path, action, data = {}) {
    try {
      await api(`/api/workspace/${action}`, { path, ...data });
      await refresh();
    } catch (error) { toast(error.message); }
  }

  async function preview(path) {
    try {
      openFile(path, fileUrl(path));
    } catch (error) { toast(error.message); }
  }

  function reference(path) {
    const input = $("#prompt-input");
    input.value += `${input.value && !/\s$/.test(input.value) ? " " : ""}@./${path} `;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    toast(`已引用 ${path}`);
  }

  function addMenuItem(menu, label, action, danger = false) {
    const button = makeButton(label, label, () => { closeMenus(); action(); }, danger ? "danger" : "");
    menu.append(button);
  }

  function rowMenu(entry) {
    const menu = document.createElement("div");
    menu.className = "resource-menu";
    menu.hidden = true;
    if (entry.isDir) {
      addMenuItem(menu, "上传到这里", () => { selectedDir = entry.path; uploadInput.click(); });
      addMenuItem(menu, "新建文件", () => create(entry.path, false));
      addMenuItem(menu, "新建文件夹", () => create(entry.path, true));
    } else {
      addMenuItem(menu, "预览", () => preview(entry.path));
      addMenuItem(menu, "引用到聊天", () => reference(entry.path));
      addMenuItem(menu, "下载", () => { const link = document.createElement("a"); link.href = fileUrl(entry.path, true); link.click(); });
    }
    if (entry.path) {
      addMenuItem(menu, "重命名", () => {
        const name = prompt(`重命名 ${entry.name}`, entry.name)?.trim();
        if (name && name !== entry.name) void mutate(entry.path, "rename", { name });
      });
      addMenuItem(menu, "删除", () => {
        if (confirm(`确定删除“${entry.path}”${entry.isDir ? "及其全部内容" : ""}？`)) void mutate(entry.path, "delete");
      }, true);
    }
    return menu;
  }

  function rowMore(entry) {
    const menu = rowMenu(entry);
    const more = makeButton("", `${entry.name} 操作`, (event) => {
      event.stopPropagation();
      const open = !menu.hidden;
      closeMenus();
      if (!open) {
        document.body.append(menu);
        menu.hidden = false;
        const rect = more.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.right - 126, window.innerWidth - 134))}px`;
        menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight > window.innerHeight - 8 ? rect.top - menu.offsetHeight : rect.bottom)}px`;
      }
    }, "resource-more");
    more.append(icon("more"));
    return more;
  }

  function create(directory, isDir) {
    const name = prompt(isDir ? "新文件夹名称" : "新文件名称")?.trim();
    if (!name) return;
    const path = directory ? `${directory}/${name}` : name;
    void mutate(path, "create", { isDir });
    if (directory) expanded.add(directory);
  }

  function render() {
    closeMenus();
    if (selectedDir && !entries.some((entry) => entry.path === selectedDir && entry.isDir)) selectedDir = "";
    tree.replaceChildren();
    const children = new Map();
    for (const entry of entries) {
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(entry);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN"));
    const rootRow = document.createElement("div");
    rootRow.className = `resource-row root${selectedDir ? "" : " selected"}`;
    rootRow.style.setProperty("--depth", "0");
    const rootEntry = { isDir: true, name: "工作区", path: "" };
    rootRow.append(entryButton(rootEntry, true, () => { selectedDir = ""; render(); }), rowMore(rootEntry));
    tree.append(rootRow);
    function append(parent, depth) {
      for (const entry of children.get(parent) ?? []) {
        const row = document.createElement("div");
        row.className = `resource-row${selectedDir === entry.path && entry.isDir ? " selected" : ""}`;
        row.style.setProperty("--depth", depth);
        const name = entryButton(entry, expanded.has(entry.path), () => {
          closeMenus();
          if (entry.isDir) {
            selectedDir = entry.path;
            if (expanded.has(entry.path)) expanded.delete(entry.path);
            else expanded.add(entry.path);
            render();
          } else void preview(entry.path);
        }, "resource-name");
        row.append(name, rowMore(entry));
        tree.append(row);
        if (entry.isDir && expanded.has(entry.path)) append(entry.path, depth + 1);
      }
    }
    append("", 1);
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "resource-empty";
      empty.textContent = "工作区暂无文件";
      tree.append(empty);
    }
    count.textContent = `${entries.length} 项`;
    setStatus(`${stale ? "列表可能已过期 · " : ""}${selectedDir ? `工作区 / ${selectedDir}` : "工作区根目录"}`);
  }

  for (const [id, name] of [["resource-new-file", "filePlus"], ["resource-new-folder", "folderPlus"], ["resource-upload", "upload"], ["resource-refresh", "refresh"]]) {
    $("#" + id).prepend(icon(name));
  }
  $("#resource-refresh").addEventListener("click", () => void refresh());
  $("#resource-upload").addEventListener("click", () => uploadInput.click());
  $("#resource-new-file").addEventListener("click", () => create(selectedDir, false));
  $("#resource-new-folder").addEventListener("click", () => create(selectedDir, true));
  uploadInput.addEventListener("change", async () => {
    const files = [...uploadInput.files];
    uploadInput.value = "";
    for (const file of files) {
      if (file.size > 10_000_000) { toast(`${file.name} 超过 10 MB`); continue; }
      try {
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        await api("/api/workspace/upload", { directory: selectedDir, name: file.name, data: encoded });
      } catch (error) { toast(`${file.name}: ${error.message}`); }
    }
    await refresh();
  });
  document.addEventListener("click", (event) => { if (!tree.contains(event.target)) closeMenus(); });
  document.addEventListener("realcode:workspace-file-saved", () => void refresh());
  return { refresh, open: () => { if (!loaded) void refresh(); } };
}
