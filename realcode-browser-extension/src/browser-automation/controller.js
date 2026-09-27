import { resolveFloatingLinkNavigation } from "./link-navigation.js";
import { observePage } from "./page-observer.js";
import { prepareObservedAction, settleAfterObservedAction } from "./action-executor.js";

const BLOCKED_SCHEMES = /^(chrome|edge|about|devtools|chrome-extension):/i;
const CDP_VERSION = "1.3";
const WORLD_NAME = "realcode-browser-bridge";
const CDP_COMMAND_TIMEOUT_MS = 8_000;

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
  const command = chrome.debugger.sendCommand(debuggee(tabId, sessionId), method, params);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP command timed out after ${CDP_COMMAND_TIMEOUT_MS}ms: ${method}`)),
      CDP_COMMAND_TIMEOUT_MS
    );
    command.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
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
  if (!floating.length) throw new Error("The expanded preview is still loading. Observe again after it becomes available.");
  return { mode: "floating-preview", contexts: floating, floatingUrl: surface.floatingUrl };
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
  if (!matches.length) throw new Error("The iframe document changed and its frameId expired. Observe again.");
  return matches;
}

async function observeSurface(tabId, args = {}) {
  const options = {
    maxActions: clamp(args.maxActions, 1, 500, 250),
    maxTextLength: clamp(args.maxTextLength, 0, 50_000, 6000)
  };
  const surface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
  const contexts = matchingContexts(surface.contexts, args.frameId);
  const frames = [];
  for (const context of contexts) {
    try {
      const state = await evaluate(tabId, context, observePage, options);
      if (state) frames.push({ frameId: context.frameId, sessionId: context.sessionId ?? null, state });
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

async function executeObservedAction(tabId, args) {
  const startedAt = performance.now();
  const actionId = String(args.actionId ?? "");
  const fingerprint = String(args.fingerprint ?? "");
  if (!actionId || !fingerprint) throw new Error("actionId and fingerprint are required");

  const surface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
  if (surface.mode === "new-tab-fallback") {
    const suffix = surface.fallbackUrl ? ` Open it with browser_open_tab: ${surface.fallbackUrl}` : "";
    throw new Error(`NO_FLOATING_PREVIEW: Open the returned fallbackUrl before acting.${suffix}`);
  }
  const contexts = matchingContexts(surface.contexts, args.frameId);
  let selected = null;
  let prepared = null;
  let staleReason = "Observed action is no longer available";
  const guardStartedAt = performance.now();
  for (const context of contexts) {
    const candidate = await evaluate(tabId, context, prepareObservedAction, {
      actionId,
      fingerprint,
      keepLinksInFrame: surface.mode === "floating-preview"
    });
    if (candidate && !candidate.stale) {
      selected = context;
      prepared = candidate;
      break;
    }
    if (candidate?.reason) staleReason = candidate.reason;
  }
  const guardMs = Math.round(performance.now() - guardStartedAt);
  if (!selected || !prepared) throw new Error(`STALE_PAGE: ${staleReason}`);

  const inputStartedAt = performance.now();
  if (prepared.kind === "scroll") {
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: prepared.delta
    }, selected.sessionId);
  } else if (prepared.kind !== "select") {
    const navigationUrl = surface.mode === "floating-preview" ? resolveFloatingLinkNavigation(prepared.link) : null;
    if (navigationUrl) {
      const navigation = await send(tabId, "Page.navigate", { url: navigationUrl, frameId: selected.frameId }, selected.sessionId);
      if (navigation.errorText) throw new Error(`Floating preview navigation failed: ${navigation.errorText}`);
    } else {
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: prepared.x, y: prepared.y }, selected.sessionId);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: prepared.x, y: prepared.y, button: "left", buttons: 1, clickCount: 1 }, selected.sessionId);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: prepared.x, y: prepared.y, button: "left", buttons: 0, clickCount: 1 }, selected.sessionId);
      if (prepared.kind === "fill") {
        if (typeof args.text !== "string") throw new Error("text is required for a fill action");
        await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }, selected.sessionId);
        await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, selected.sessionId);
        await send(tabId, "Input.insertText", { text: args.text }, selected.sessionId);
      }
    }
  }
  const inputMs = Math.round(performance.now() - inputStartedAt);

  const settleStartedAt = performance.now();
  let settle = { reason: "document-changed", waitedMs: 0 };
  try {
    settle = await evaluate(tabId, selected, settleAfterObservedAction, {
      actionId,
      autocomplete: prepared.autocomplete === true
    }) ?? settle;
  } catch {
    // Navigation destroys the old execution context and is itself a useful state change.
  }
  const settleMs = Math.round(performance.now() - settleStartedAt);

  const observeStartedAt = performance.now();
  let after = null;
  let afterFrameId = selected.frameId;
  for (let attempt = 0; attempt < 10 && !after; attempt += 1) {
    try {
      const nextSurface = await resolveControlSurface(tabId, await collectFrameContexts(tabId));
      const nextContexts = nextSurface.contexts;
      const preferred = nextContexts.find((context) => context.frameId === selected.frameId) ?? nextContexts[0];
      if (preferred) {
        after = await evaluate(tabId, preferred, observePage, { maxActions: 250, maxTextLength: 6000 });
        afterFrameId = preferred.frameId;
      }
    } catch {
      if (attempt === 9) throw new Error("Page did not settle after the action");
    }
    if (!after) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const observeMs = Math.round(performance.now() - observeStartedAt);
  return {
    tabId,
    frameId: afterFrameId,
    actionId,
    kind: prepared.kind,
    executed: true,
    beforeFingerprint: fingerprint,
    afterFingerprint: after?.fingerprint ?? null,
    pageChanged: Boolean(after && after.fingerprint !== fingerprint),
    settle,
    state: after,
    timing: {
      guardMs,
      inputMs,
      settleMs,
      observeMs,
      totalMs: Math.round(performance.now() - startedAt)
    }
  };
}

export async function executeBrowserCommand(method, args = {}, selectedTabId = null) {
  if (method === "browser.openTab") {
    const url = new URL(args.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS navigation is allowed");
    const selected = await resolveTab(selectedTabId);
    await ensureDebugger(selected.id);
    const surface = await resolveControlSurface(selected.id, await collectFrameContexts(selected.id));
    if (surface.mode === "floating-preview") throw new Error("The expanded preview is active. Control that window instead of opening a new tab.");
    if (surface.mode !== "new-tab-fallback" || !surface.fallbackUrl) throw new Error("A new tab is allowed only when the RealCode page has no expanded preview and browser_observe returned a fallbackUrl.");
    if (new URL(surface.fallbackUrl).href !== url.href) throw new Error("Open only the fallbackUrl returned by the latest browser_observe.");
    await detachCurrent();
    const tab = await chrome.tabs.create({ url: url.href, active: true });
    return { tabId: tab.id, title: tab.title, url: url.href };
  }
  const tab = await resolveTab(selectedTabId);
  const tabId = tab.id;
  await ensureDebugger(tabId);
  switch (method) {
    case "browser.observe": return observeSurface(tabId, args);
    case "browser.act": return executeObservedAction(tabId, args);
    case "browser.screenshot": {
      const captured = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true });
      return { tabId, dataUrl: `data:image/jpeg;base64,${captured.data}` };
    }
    default: throw new Error(`Unsupported command: ${method}`);
  }
}
