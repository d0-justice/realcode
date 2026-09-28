export function createAttachments({ $, state, api }) {
function renderAttachments() {
  const container = $("#attachments");
  container.replaceChildren();
  for (const [kind, items] of [["file", state.files], ["image", state.images]]) {
    items.forEach((item, index) => {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.textContent = `${kind === "image" ? "图片" : "文件"} · ${item.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除 ${item.name}`);
      remove.addEventListener("click", () => { items.splice(index, 1); renderAttachments(); });
      chip.append(remove);
      container.append(chip);
    });
  }
}

function renderCommands() {
  const input = $("#prompt-input");
  const menu = $("#command-menu");
  const match = input.value.match(/^\/([^\s]*)$/);
  const commands = match ? state.commands.filter((item) => item.name.toLowerCase().includes(match[1].toLowerCase())).slice(0, 12) : [];
  menu.hidden = commands.length === 0;
  menu.replaceChildren();
  for (const command of commands) {
    const button = document.createElement("button");
    button.type = "button";
    const name = document.createElement("strong");
    name.textContent = `/${command.name}`;
    const description = document.createElement("small");
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("click", () => { input.value = `/${command.name} `; menu.hidden = true; input.focus(); });
    menu.append(button);
  }
}

async function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (state.files.length >= 5) throw new Error("一次最多附加 5 个文件");
    if (file.size > 10_000_000) throw new Error(`${file.name} 超过 10 MB`);
    const uploaded = await api("/api/upload", { name: file.name, data: await readBase64(file) });
    state.files.push(uploaded);
  }
  renderAttachments();
}

async function addImages(files) {
  if (!state.supportsImages) throw new Error("当前 RealCode 不支持图片输入");
  for (const file of files) {
    if (state.images.length >= 5) throw new Error("一次最多添加 5 张图片");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5_000_000) throw new Error(`${file.name} 格式无效或超过 5 MB`);
    state.images.push({ name: file.name, mimeType: file.type, data: await readBase64(file) });
  }
  renderAttachments();
}


return { renderAttachments, renderCommands, addFiles, addImages };
}
