const elements = {
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  permissionBadge: document.querySelector("#permissionBadge"),
  tabTitle: document.querySelector("#tabTitle"),
  tabUrl: document.querySelector("#tabUrl"),
  serverUrl: document.querySelector("#serverUrl"),
  autoConnect: document.querySelector("#autoConnect"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  selectTabButton: document.querySelector("#selectTabButton"),
  saveButton: document.querySelector("#saveButton"),
  testButton: document.querySelector("#testButton"),
  connectButton: document.querySelector("#connectButton"),
  testOutput: document.querySelector("#testOutput"),
  feedback: document.querySelector("#feedback")
};

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error?.message || "扩展请求失败");
  return response.result;
}

function feedback(message, error = false) {
  elements.feedback.textContent = message;
  elements.feedback.classList.toggle("error", error);
}

function renderConnection(state) {
  elements.statusDot.dataset.status = state.status;
  elements.statusText.textContent = state.message;
  elements.connectButton.textContent = state.status === "connected" ? "断开连接" : "连接 RealCode";
}

async function renderPermission() {
  const allowed = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  elements.permissionBadge.textContent = allowed ? "安装时已授权" : "权限缺失";
  elements.permissionBadge.classList.toggle("allowed", allowed);
}

async function renderSelectedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    elements.tabTitle.textContent = tab.title || "未命名页面";
    elements.tabUrl.textContent = tab.url || "";
  } catch {
    elements.tabTitle.textContent = "所选标签页已关闭";
    elements.tabUrl.textContent = "请重新选择当前页面";
  }
}

async function initialize() {
  const { settings, connectionState } = await request({ type: "get-state" });
  elements.serverUrl.value = settings.serverUrl;
  elements.autoConnect.checked = settings.autoConnect;
  renderConnection(connectionState);
  elements.selectTabButton.title = "重新定位 RealCode 会话页";
  elements.selectTabButton.setAttribute("aria-label", "重新定位 RealCode 会话页");
  await Promise.all([renderPermission(), renderSelectedTab(settings.selectedTabId)]);
}

elements.settingsToggle.addEventListener("click", () => {
  const expanded = elements.settingsToggle.getAttribute("aria-expanded") !== "true";
  elements.settingsToggle.setAttribute("aria-expanded", String(expanded));
  elements.settingsPanel.hidden = !expanded;
});

elements.selectTabButton.addEventListener("click", async () => {
  try {
    const { tab } = await request({ type: "select-active-tab" });
    await renderSelectedTab(tab.id);
    feedback("已重新定位 RealCode 会话页");
  } catch (error) {
    feedback(error.message, true);
  }
});

elements.saveButton.addEventListener("click", async () => {
  try {
    await request({
      type: "save-settings",
      settings: {
        serverUrl: elements.serverUrl.value.trim(),
        autoConnect: elements.autoConnect.checked
      }
    });
    feedback("连接设置已保存");
  } catch (error) {
    feedback(error.message, true);
  }
});

elements.connectButton.addEventListener("click", async () => {
  try {
    const state = await request({ type: "get-state" });
    if (state.connectionState.status === "connected") {
      const result = await request({ type: "disconnect" });
      elements.autoConnect.checked = false;
      renderConnection(result.connectionState);
    } else {
      await request({
        type: "save-settings",
        settings: {
          serverUrl: elements.serverUrl.value.trim(),
          autoConnect: elements.autoConnect.checked
        }
      });
      const result = await request({ type: "connect" });
      elements.autoConnect.checked = true;
      renderConnection(result.connectionState);
    }
  } catch (error) {
    feedback(error.message, true);
  }
});

elements.testButton.addEventListener("click", async () => {
  elements.testButton.disabled = true;
  elements.testOutput.hidden = true;
  try {
    const snapshot = await request({ type: "test-snapshot" });
    const summary = snapshot.frames.map(({ frameId, result }) => ({
      frameId,
      url: result?.url,
      title: result?.title,
      elements: result?.elements?.length || 0,
      text: result?.text?.slice(0, 120)
    }));
    elements.testOutput.textContent = JSON.stringify(summary, null, 2);
    elements.testOutput.hidden = false;
    feedback(`成功读取 ${summary.length} 个页面框架`);
  } catch (error) {
    feedback(error.message, true);
  } finally {
    elements.testButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge-state") renderConnection(message.state);
});

initialize().catch((error) => feedback(error.message, true));
