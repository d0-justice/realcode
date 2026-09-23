const LOCAL_FRAME_SANDBOX = "allow-scripts allow-forms allow-downloads";
const EXTERNAL_FRAME_SANDBOX = `${LOCAL_FRAME_SANDBOX} allow-same-origin allow-modals allow-presentation`;
const EDITABLE_FILE = /\.(?:txt|md|mdx|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|xml|svg|json|jsonc|ya?ml|toml|ini|conf|py|rb|php|java|c|cc|cpp|h|hpp|cs|go|rs|sh|bash|zsh|ps1|sql|vue|svelte)$/i;

export function configurePreviewFrame(frame, url) {
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

export function createFloatingWindow({ $, api, toast }) {
  const conversation = $(".conversation");
  const layer = $("#iframe-modal");
  const card = $("#iframe-modal .iframe-modal-card");
  const dragHandle = $("#iframe-drag-handle");
  const frame = $("#iframe-expanded");
  const editorPane = $("#floating-editor-pane");
  const editor = $("#floating-editor");
  const titleNode = $("#iframe-title");
  const fileActions = $("#floating-file-actions");
  const previewButton = $("#floating-preview-mode");
  const editButton = $("#floating-edit-mode");
  const saveButton = $("#floating-save");
  const closeButton = $("#iframe-close");
  const sizeOutput = $("#iframe-size-value");
  const opacityOutput = $("#iframe-opacity-value");
  const sizeInput = $("#iframe-size");
  const opacityInput = $("#iframe-opacity");
  const opacityModeButton = $("#iframe-opacity-mode");
  const sizePresetButtons = [...document.querySelectorAll(".iframe-size-presets button")];
  const opacityPresetButtons = [...document.querySelectorAll(".iframe-opacity-presets button")];
  let drag;
  let detachedRightGap = 0;
  let currentFile;
  let currentUrl;
  let editorLoaded = false;
  let dirty = false;
  let layoutFrame;

  conversation.append(layer);

  function setTitle(title) {
    titleNode.textContent = title;
    titleNode.title = title;
    frame.title = title;
  }

  function setMode(mode) {
    const editing = mode === "editor";
    frame.hidden = editing;
    editorPane.hidden = !editing;
    previewButton.classList.toggle("active", !editing);
    editButton.classList.toggle("active", editing);
  }

  function updateSaveState() {
    saveButton.disabled = !dirty;
    saveButton.textContent = dirty ? "保存*" : "保存";
  }

  function configureFileActions(path) {
    const editable = EDITABLE_FILE.test(path);
    fileActions.hidden = !editable;
    editButton.disabled = !editable;
    saveButton.hidden = !editable;
  }

  function showFrame(url, title, filePath) {
    currentFile = filePath;
    currentUrl = url;
    editorLoaded = false;
    dirty = false;
    editor.value = "";
    configurePreviewFrame(frame, url);
    frame.name = "realcode-floating-preview";
    frame.dataset.realcodeControlTarget = "true";
    frame.src = url;
    setTitle(title);
    configureFileActions(filePath ?? "");
    setMode("preview");
    updateSaveState();
    card.dataset.detached = "false";
    detachedRightGap = 0;
    layer.hidden = false;
  }

  function openFrame(url, title = "展开预览") { showFrame(url, title); }
  function openFile(path, url) { showFrame(url, path, path); }

  async function showEditor() {
    if (!currentFile || !EDITABLE_FILE.test(currentFile)) return;
    try {
      if (!editorLoaded) {
        const result = await api(`/api/file?path=${encodeURIComponent(currentFile)}`);
        editor.value = result.content;
        editorLoaded = true;
        dirty = false;
        updateSaveState();
      }
      setMode("editor");
      editor.focus();
    } catch (error) { toast(error.message); }
  }

  async function save() {
    if (!currentFile || !editorLoaded || !dirty) return;
    try {
      await api("/api/workspace/write", { path: currentFile, content: editor.value });
      dirty = false;
      updateSaveState();
      currentUrl = `${currentUrl.split("&previewVersion=")[0]}&previewVersion=${Date.now()}`;
      frame.src = currentUrl;
      document.dispatchEvent(new CustomEvent("realcode:workspace-file-saved", { detail: { path: currentFile } }));
      toast(`已保存 ${currentFile}`);
    } catch (error) { toast(error.message); }
  }

  function close() {
    layer.hidden = true;
    frame.removeAttribute("src");
    editor.value = "";
    currentFile = undefined;
    currentUrl = undefined;
    editorLoaded = false;
    dirty = false;
  }

  function relativeTop(element) {
    return element.getBoundingClientRect().top - conversation.getBoundingClientRect().top;
  }

  function alignBottom() {
    if (layer.hidden) return;
    const cardTop = card.offsetTop;
    const composerTop = relativeTop($("#composer"));
    card.style.height = `${Math.max(180, composerTop - cardTop)}px`;
    card.style.maxHeight = `${Math.max(180, conversation.clientHeight - cardTop)}px`;
  }

  function syncOverlapOpacity(shift = Number.parseFloat(conversation.style.getPropertyValue("--preview-content-shift")) || 0) {
    const cardRect = card.getBoundingClientRect();
    const conversationRect = conversation.getBoundingClientRect();
    const messageList = $("#message-list");
    const messageStyle = getComputedStyle(messageList);
    const contentRight = conversationRect.left + messageList.offsetLeft + messageList.offsetWidth
      - (Number.parseFloat(messageStyle.paddingRight) || 0) - shift;
    const overlapWidth = Math.min(cardRect.width, Math.max(0, contentRight - cardRect.left));
    const transitionWidth = Math.min(64, Math.max(24, overlapWidth * 0.16));
    const solidWidth = Math.max(0, overlapWidth - transitionWidth);
    card.style.setProperty("--preview-overlap-solid", solidWidth + "px");
    card.style.setProperty("--preview-overlap-end", overlapWidth + "px");
  }

  function syncConversationLayout() {
    if (layer.hidden) {
      conversation.classList.remove("preview-open");
      conversation.style.removeProperty("--preview-content-shift");
      return;
    }
    const messageList = $("#message-list");
    const composer = $("#composer");
    const messageInset = Number.parseFloat(getComputedStyle(messageList).paddingLeft) || 0;
    const composerInset = composer.offsetLeft;
    const shift = Math.max(0, Math.min(messageInset, composerInset) - 12);
    conversation.style.setProperty("--preview-content-shift", `${shift}px`);
    conversation.classList.add("preview-open");
    syncOverlapOpacity(shift);
  }

  function dock() {
    if (layer.hidden) return;
    card.style.left = "auto";
    card.style.top = `${relativeTop($(".conversation-heading")) + $(".conversation-heading").offsetHeight}px`;
    card.style.right = "0px";
    alignBottom();
    syncConversationLayout();
  }

  function positionDetached() {
    if (layer.hidden) return;
    const maxLeft = Math.max(0, conversation.clientWidth - card.offsetWidth);
    const left = Math.min(maxLeft, Math.max(0, conversation.clientWidth - detachedRightGap - card.offsetWidth));
    const maxTop = Math.max(0, relativeTop($("#composer")) - 180);
    card.style.left = `${left}px`;
    card.style.right = "auto";
    card.style.top = `${Math.min(maxTop, Math.max(0, card.offsetTop))}px`;
    alignBottom();
    syncConversationLayout();
  }

  function scheduleLayoutSync() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      if (layer.hidden) { syncConversationLayout(); return; }
      if (card.dataset.detached === "true") positionDetached();
      else dock();
    });
  }

  function setSize(value) {
    value = Math.min(100, Math.max(20, value));
    card.style.width = `${value}%`;
    sizeInput.value = String(value);
    sizeOutput.value = `${value}%`;
    sizePresetButtons.forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.size) === value);
    });
    scheduleLayoutSync();
  }

  function setOpacity(value) {
    card.style.setProperty("--preview-edge-opacity", String(value / 100));
    opacityInput.value = String(value);
    opacityOutput.value = `${value}%`;
    opacityPresetButtons.forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.opacity) === value);
    });
  }

  function setOpacityMode(edgeOnly) {
    card.classList.toggle("edge-opacity-only", edgeOnly);
    opacityModeButton.setAttribute("aria-pressed", String(edgeOnly));
    opacityModeButton.title = edgeOnly ? "点击切换为整体透明" : "点击切换为左侧局部透明";
    opacityModeButton.textContent = edgeOnly ? "左侧透明度" : "整体透明度";
    if (edgeOnly) syncOverlapOpacity();
  }

  function bindToolbarEvents() {
    closeButton.addEventListener("click", close);
    sizeInput.addEventListener("input", (event) => setSize(Number(event.target.value)));
    sizePresetButtons.forEach((button) => {
      button.addEventListener("click", () => setSize(Number(button.dataset.size)));
    });
    opacityInput.addEventListener("input", (event) => setOpacity(Number(event.target.value)));
    opacityPresetButtons.forEach((button) => {
      button.addEventListener("click", () => setOpacity(Number(button.dataset.opacity)));
    });
    opacityModeButton.addEventListener("click", () => {
      setOpacityMode(!card.classList.contains("edge-opacity-only"));
    });
    previewButton.addEventListener("click", () => setMode("preview"));
    editButton.addEventListener("click", () => void showEditor());
    saveButton.addEventListener("click", () => void save());
  }

  function bindEditorEvents() {
    editor.addEventListener("input", () => {
      dirty = true;
      updateSaveState();
    });
    editor.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void save();
    });
  }

  function bindFrameBridge() {
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== frame.contentWindow || !message || message.type !== "realcode-floating-preview-probe" || typeof message.nonce !== "string") return;
      event.source.postMessage({ type: "realcode-floating-preview-ack", nonce: message.nonce }, "*");
    });
  }

  function bindLayoutObservers() {
    new MutationObserver(() => {
      if (!layer.hidden) {
        card.dataset.detached = "false";
        detachedRightGap = 0;
      }
      scheduleLayoutSync();
    }).observe(layer, { attributes: true, attributeFilter: ["hidden"] });

    window.addEventListener("resize", scheduleLayoutSync);
    if (typeof ResizeObserver !== "undefined") {
      const layoutObserver = new ResizeObserver(scheduleLayoutSync);
      layoutObserver.observe(conversation);
      layoutObserver.observe(card);
    }

    const inspector = $("#inspector");
    if (inspector) {
      new MutationObserver(scheduleLayoutSync).observe(inspector, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }
  }

  function bindDragEvents() {
    function beginDrag(event) {
      if (event.target.closest("button,select,input,label,textarea")) return;
      const rect = card.getBoundingClientRect();
      const parentRect = conversation.getBoundingClientRect();
      card.style.left = rect.left - parentRect.left + "px";
      card.style.top = rect.top - parentRect.top + "px";
      card.style.right = "auto";
      card.dataset.detached = "true";
      detachedRightGap = Math.max(0, parentRect.right - rect.right);
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      dragHandle.setPointerCapture(event.pointerId);
    }

    function moveDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const parentRect = conversation.getBoundingClientRect();
      const maxLeft = Math.max(0, conversation.clientWidth - card.offsetWidth);
      const maxTop = Math.max(0, relativeTop($("#composer")) - 180);
      const left = Math.min(maxLeft, Math.max(0, event.clientX - parentRect.left - drag.offsetX));
      card.style.left = left + "px";
      card.style.top = Math.min(maxTop, Math.max(0, event.clientY - parentRect.top - drag.offsetY)) + "px";
      detachedRightGap = Math.max(0, conversation.clientWidth - left - card.offsetWidth);
      alignBottom();
      syncConversationLayout();
    }

    function endDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = undefined;
      if (dragHandle.hasPointerCapture(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId);
    }

    dragHandle.addEventListener("pointerdown", beginDrag);
    dragHandle.addEventListener("pointermove", moveDrag);
    dragHandle.addEventListener("pointerup", endDrag);
    dragHandle.addEventListener("pointercancel", endDrag);
  }

  bindToolbarEvents();
  bindEditorEvents();
  bindFrameBridge();
  bindLayoutObservers();
  bindDragEvents();

  return { openFrame, openFile, close };
}