const BLOCKED_SCHEMES = /^(chrome|edge|about|devtools|chrome-extension):/i;
const CDP_VERSION = "1.3";
const WORLD_NAME = "realcode-browser-bridge";

let attachedTabId = null;
const childSessions = new Set();

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function debuggee(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

function send(tabId, method, params = {}, sessionId) {
  return chrome.debugger.sendCommand(debuggee(tabId, sessionId), method, params);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  if (method === "Target.attachedToTarget" && params?.sessionId) {
    childSessions.add(params.sessionId);
    const target = debuggee(attachedTabId, params.sessionId);
    void chrome.debugger.sendCommand(target, "Runtime.enable").catch(() => {});
    void chrome.debugger.sendCommand(target, "Page.enable").catch(() => {});
    void chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }).catch(() => {});
  }
  if (method === "Target.detachedFromTarget" && params?.sessionId) childSessions.delete(params.sessionId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  childSessions.clear();
});

async function detachCurrent() {
  const tabId = attachedTabId;
  attachedTabId = null;
  childSessions.clear();
  if (!Number.isInteger(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export async function disconnectBrowserDebugger() {
  await detachCurrent();
}

async function resolveTab(selectedTabId) {
  if (!Number.isInteger(selectedTabId)) throw new Error("Select a browser tab in the extension first");
  const tab = await chrome.tabs.get(selectedTabId);
  if (BLOCKED_SCHEMES.test(tab.url || "")) throw new Error("This browser page cannot be controlled");
  return tab;
}

async function ensureDebugger(tabId) {
  if (attachedTabId === tabId) return;
  await detachCurrent();
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot attach Chrome debugger to tab ${tabId}: ${message}`);
  }
  attachedTabId = tabId;
  await Promise.all([
    send(tabId, "Runtime.enable"),
    send(tabId, "Page.enable"),
    send(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  ]);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function flattenFrameTree(frameTree, result = []) {
  if (!frameTree?.frame?.id) return result;
  result.push({ frameId: frameTree.frame.id, url: frameTree.frame.url, name: frameTree.frame.name || "" });
  for (const child of frameTree.childFrames || []) flattenFrameTree(child, result);
  return result;
}

async function collectFrameContexts(tabId) {
  const targets = [{ sessionId: undefined }, ...[...childSessions].map((sessionId) => ({ sessionId }))];
  const contexts = [];
  const seen = new Set();
  for (const target of targets) {
    let tree;
    try {
      tree = await send(tabId, "Page.getFrameTree", {}, target.sessionId);
    } catch {
      continue;
    }
    for (const frame of flattenFrameTree(tree.frameTree)) {
      if (seen.has(frame.frameId)) continue;
      try {
        const world = await send(tabId, "Page.createIsolatedWorld", {
          frameId: frame.frameId,
          worldName: WORLD_NAME,
          grantUniveralAccess: false
        }, target.sessionId);
        seen.add(frame.frameId);
        contexts.push({ ...frame, sessionId: target.sessionId, executionContextId: world.executionContextId });
      } catch {
        // OOPIF placeholders are collected from their attached child target.
      }
    }
  }
  return contexts;
}

function inspectControlSurface() {
  const modal = document.querySelector("#iframe-modal");
  const floatingFrame = document.querySelector("#iframe-expanded[data-realcode-control-target='true']");
  if (!modal || !floatingFrame) return { isRealCode: false };
  const inlineFrames = [...document.querySelectorAll("iframe.message-iframe")]
    .map((frame) => frame.src)
    .filter(Boolean);
  return {
    isRealCode: true,
    floatingOpen: !modal.hidden && Boolean(floatingFrame.src),
    floatingUrl: floatingFrame.src || null,
    fallbackUrl: inlineFrames.at(-1) || null
  };
}

async function resolveControlSurface(tabId, contexts) {
  const root = contexts[0];
  if (!root) throw new Error("No controllable document was found in the selected tab");
  let surface;
  try {
    surface = await evaluate(tabId, root, inspectControlSurface, null);
  } catch {
    return { mode: "top-level", contexts };
  }
  if (!surface?.isRealCode) return { mode: "top-level", contexts };
  if (!surface.floatingOpen) {
    return { mode: "new-tab-fallback", contexts: [root], fallbackUrl: surface.fallbackUrl };
  }
  const floating = contexts.filter((context) => context.name === "realcode-floating-preview");
  if (!floating.length) throw new Error("The expanded preview is still loading. Wait briefly and run browser_snapshot again.");
  return { mode: "floating-preview", contexts: floating, floatingUrl: surface.floatingUrl };
}

function snapshotDocument(options) {
  const clean = (value, limit = 240) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const selectorFor = (element) => {
    if (element.id) return `#${CSS.escape(String(element.id))}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((node) => node.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(" > ");
  };
  const selector = ["a[href]", "button", "input:not([type='hidden'])", "textarea", "select", "[contenteditable='true']", "[role='button']", "[role='link']", "[role='checkbox']", "[role='radio']", "[role='textbox']", "[tabindex]:not([tabindex='-1'])"].join(",");
  const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, options.maxElements).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const inputType = element.localName === "input" ? element.type : undefined;
    return {
      ref: `e${index + 1}`,
      selector: selectorFor(element),
      tag: element.localName,
      role: element.getAttribute("role") || undefined,
      type: inputType,
      name: clean(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("name")),
      value: inputType === "password" ? undefined : clean(element.value, 500),
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  });
  return {
    url: location.href,
    title: document.title,
    text: clean(document.body?.innerText, options.maxTextLength),
    iframes: [...document.querySelectorAll("iframe")].map((frame) => ({ src: frame.src, title: clean(frame.title), name: clean(frame.name) })),
    elements
  };
}

function operateDocument(args) {
  const element = document.querySelector(args.selector);
  if (!element) return { matched: false };
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (args.operation === "fill") {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("Selected element does not accept text input");
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, String(args.value ?? ""));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(args.value ?? "") }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (args.operation === "select") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("Selected element is not a select control");
    element.value = String(args.value ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  element.focus();
  return { matched: true, tag: element.localName };
}

async function clickInContext(tabId, context, selector) {
  const expression = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return element; })()`;
  const evaluated = await send(tabId, "Runtime.evaluate", {
    expression,
    contextId: context.executionContextId,
    returnByValue: false,
    awaitPromise: true
  }, context.sessionId);
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || "Page evaluation failed");
  const objectId = evaluated.result?.objectId;
  if (!objectId) return false;
  try {
    const geometry = await send(tabId, "DOM.getContentQuads", { objectId }, context.sessionId);
    const quad = geometry.quads?.[0];
    if (!quad || quad.length < 8) throw new Error("Element has no clickable area");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, context.sessionId);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, context.sessionId);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, context.sessionId);
    return true;
  } finally {
    await send(tabId, "Runtime.releaseObject", { objectId }, context.sessionId).catch(() => {});
  }
}

async function evaluate(tabId, context, func, argument) {
  const expression = `(${func.toString()})(${JSON.stringify(argument)})`;
  const response = await send(tabId, "Runtime.evaluate", { expression, contextId: context.executionContextId, returnByValue: true, awaitPromise: true }, context.sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Page evaluation failed");
  return response.result?.value;
}

function matchingContexts(contexts, frameId) {
  if (frameId === undefined || frameId === null || frameId === "") return contexts;
  const matches = contexts.filter((context) => context.frameId === String(frameId));
  if (!matches.length) throw new Error("The iframe document changed and its frameId expired. Run browser_snapshot again.");
  return matches;
}

async function operate(tabId, args, operation) {
  if (typeof args.selector !== "string" || !args.selector.trim()) throw new Error("selector is required");
  const surface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
  if (surface.mode === "new-tab-fallback") {
    const suffix = surface.fallbackUrl ? ` Open it with browser_open_tab: ${surface.fallbackUrl}` : "";
    throw new Error(`NO_FLOATING_PREVIEW: Open an iframe with 展开预览 before controlling it.${suffix}`);
  }
  const contexts = matchingContexts(surface.contexts, args.frameId);
  for (const context of contexts) {
    if (operation === "click") {
      if (await clickInContext(tabId, context, args.selector)) return { frameId: context.frameId, result: { matched: true, input: "cdp" } };
      continue;
    }
    const result = await evaluate(tabId, context, operateDocument, { operation, selector: args.selector, value: args.value ?? null });
    if (result?.matched) return { frameId: context.frameId, result };
  }
  throw new Error(`Element not found: ${args.selector}`);
}

export async function executeBrowserCommand(method, args = {}, selectedTabId = null) {
  if (method === "browser.wait") {
    const milliseconds = clamp(args.milliseconds, 0, 30_000, 500);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { waited: milliseconds };
  }
  if (method === "browser.openTab") {
    const url = new URL(args.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS navigation is allowed");
    const selected = await resolveTab(selectedTabId);
    await ensureDebugger(selected.id);
    const surface = await resolveControlSurface(selected.id, await collectFrameContexts(selected.id));
    if (surface.mode === "floating-preview") throw new Error("The expanded preview is active. Control that window instead of opening a new tab.");
    if (surface.mode !== "new-tab-fallback" || !surface.fallbackUrl) throw new Error("A new tab is allowed only when the RealCode page has no expanded preview and browser_snapshot returned a fallbackUrl.");
    if (new URL(surface.fallbackUrl).href !== url.href) throw new Error("Open only the fallbackUrl returned by the latest browser_snapshot.");
    await detachCurrent();
    const tab = await chrome.tabs.create({ url: url.href, active: true });
    return { tabId: tab.id, title: tab.title, url: url.href };
  }
  if (method === "browser.switchTab") {
    const urlContains = String(args.urlContains ?? "").trim().toLowerCase();
    const titleContains = String(args.titleContains ?? "").trim().toLowerCase();
    if (!urlContains && !titleContains) throw new Error("urlContains or titleContains is required");
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => (!urlContains || String(item.url ?? "").toLowerCase().includes(urlContains)) && (!titleContains || String(item.title ?? "").toLowerCase().includes(titleContains)));
    if (!tab?.id) throw new Error("No matching browser tab found");
    await detachCurrent();
    await chrome.tabs.update(tab.id, { active: true });
    return { tabId: tab.id, title: tab.title, url: tab.url };
  }
  const tab = await resolveTab(selectedTabId);
  const tabId = tab.id;
  await ensureDebugger(tabId);
  switch (method) {
    case "browser.snapshot": {
      const options = { maxElements: clamp(args.maxElements, 1, 500, 200), maxTextLength: clamp(args.maxTextLength, 0, 50_000, 12_000) };
      const surface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
      const contexts = matchingContexts(surface.contexts, args.frameId);
      const frames = [];
      for (const context of contexts) {
        try {
          frames.push({ frameId: context.frameId, sessionId: context.sessionId ?? null, result: await evaluate(tabId, context, snapshotDocument, options) });
        } catch (error) {
          frames.push({ frameId: context.frameId, sessionId: context.sessionId ?? null, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        tabId,
        transport: "cdp",
        controlMode: surface.mode,
        fallbackUrl: surface.mode === "new-tab-fallback" ? surface.fallbackUrl ?? null : null,
        frames
      };
    }
    case "browser.click": return operate(tabId, args, "click");
    case "browser.fill": return operate(tabId, args, "fill");
    case "browser.select": return operate(tabId, args, "select");
    case "browser.scroll": {
      const surface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
      if (surface.mode === "new-tab-fallback") throw new Error("NO_FLOATING_PREVIEW: Open the returned fallbackUrl with browser_open_tab.");
      const contexts = matchingContexts(surface.contexts, args.frameId);
      const frame = contexts[0];
      const result = await evaluate(tabId, frame, ({ x, y }) => {
        window.scrollBy({ left: x, top: y, behavior: "smooth" });
        return { x: window.scrollX, y: window.scrollY };
      }, { x: clamp(args.x, -100_000, 100_000, 0), y: clamp(args.y, -100_000, 100_000, 600) });
      return { tabId, frameId: frame.frameId, result };
    }
    case "browser.screenshot": {
      const captured = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true });
      return { tabId, dataUrl: `data:image/jpeg;base64,${captured.data}` };
    }
    case "browser.navigate": {
      const url = new URL(args.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS navigation is allowed");
      await send(tabId, "Page.navigate", { url: url.href });
      return { tabId, url: url.href };
    }
    default: throw new Error(`Unsupported command: ${method}`);
  }
}
