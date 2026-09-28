/**
 * Atomically extracts visible page features and an indexed action space.
 * This function is serialized into an isolated browser world, so all helpers stay local.
 */
export function observePage(options = {}) {
  if (!document.body) return null;
  const maxActions = Math.max(1, Math.min(Number(options.maxActions) || 250, 500));
  const maxTextLength = Math.max(0, Math.min(Number(options.maxTextLength) || 6000, 50000));
  const cache = globalThis.__realcodeAutomation ||= {
    ids: new WeakMap(),
    nodes: new Map(),
    nextNodeId: 1,
    actions: new Map(),
    fingerprint: null
  };
  const identity = (element) => {
    if (!cache.ids.has(element)) cache.ids.set(element, cache.nextNodeId++);
    const id = cache.ids.get(element);
    cache.nodes.set(id, element);
    return id;
  };
  for (const [id, element] of cache.nodes) if (!element.isConnected) cache.nodes.delete(id);

  const safe = (element) => !["password", "file", "hidden"].includes(String(element.type || "").toLowerCase());
  const visible = (element) => {
    if (element.closest('[aria-hidden="true"],[inert]')) return false;
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
  };
  const accessibleName = (element, seen = new Set()) => {
    if (!element || seen.has(element)) return "";
    seen.add(element);
    const labelled = String(element.getAttribute("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean)
      .map((id) => accessibleName(document.getElementById(id), seen)).filter(Boolean).join(" ");
    return labelled || element.getAttribute("aria-label") ||
      [...(element.labels || [])].map((label) => accessibleName(label, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(element.type) ? element.value : "") ||
      element.getAttribute("alt") ||
      (element.tagName === "INPUT" ? "" : [...element.childNodes].map((node) =>
        node.nodeType === Node.TEXT_NODE ? node.textContent :
          node.nodeType === Node.ELEMENT_NODE && node.getAttribute("aria-hidden") !== "true"
            ? accessibleName(node, seen) : "").join(" ").trim()) ||
      element.getAttribute("title") || element.getAttribute("placeholder") || "";
  };
  const supportedRoles = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
    "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (supportedRoles.includes(explicit)) return explicit;
    if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return "button";
    if (element.tagName === "A") return "link";
    if (element.tagName === "SELECT") return "combobox";
    if (element.tagName === "TEXTAREA" || element.isContentEditable) return "textbox";
    if (element.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(element.type)) return element.type;
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button";
      if (element.type === "search") return "searchbox";
      if (element.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel"].includes(element.type)) return "textbox";
    }
    return null;
  };
  const guard = (element) => {
    if (!element?.isConnected || !visible(element)) return null;
    const scope = element.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || element.parentElement;
    return [
      identity(element), roleOf(element), accessibleName(element), element.value ?? null,
      element.checked ?? null, element.selectedIndex ?? null, element.readOnly ?? null,
      element.matches(":disabled"), element.getAttribute("aria-disabled"),
      element.getAttribute("aria-expanded"), element.getAttribute("aria-checked"),
      element.getAttribute("aria-selected"), element.getAttribute("href"),
      scope?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2000) || ""
    ];
  };

  const selector = [
    "a[href]", "button", "input", "textarea", "select", "summary", '[contenteditable="true"]',
    ...supportedRoles.map((role) => `[role="${role}"]`)
  ].join(",");
  const candidates = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!safe(element) || !visible(element) || element.matches(":disabled") ||
        element.closest('[aria-disabled="true"]')) continue;
    const role = roleOf(element);
    if (!role || (role === "gridcell" && element.querySelector('button,[role="button"]'))) continue;
    const node = identity(element);
    const rect = element.getBoundingClientRect();
    const base = {
      node,
      role,
      label: accessibleName(element).replace(/\s+/g, " ").trim().slice(0, 240) || role,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    for (const key of ["checked", "selected", "expanded"]) {
      const value = element.getAttribute(`aria-${key}`);
      if (value !== null) base[key] = value;
    }
    if (["checkbox", "radio"].includes(element.type)) base.checked = String(element.checked);
    if (element.tagName === "SELECT") {
      for (const option of element.options) {
        if (option.selected || option.disabled || option.closest("optgroup[disabled]")) continue;
        candidates.push({
          ...base,
          kind: "select",
          value: option.value,
          currentValue: [...element.selectedOptions].map((item) => item.label).join(", "),
          label: `${base.label} → ${option.label}`
        });
      }
      continue;
    }
    const editable = !element.readOnly && element.getAttribute("aria-readonly") !== "true" &&
      (["textbox", "searchbox", "spinbutton"].includes(role) ||
        (role === "combobox" && ["INPUT", "TEXTAREA"].includes(element.tagName)));
    const value = "value" in element ? String(element.value) :
      element.isContentEditable || role === "combobox" ? element.innerText.trim() : "";
    const anchor = element.closest("a[href]");
    const link = anchor ? { href: anchor.href, target: anchor.target || "", download: anchor.hasAttribute("download") } : {};
    candidates.push({ ...base, ...link, kind: editable ? "fill" : "click", value: value.slice(0, 500) });
    if (editable) candidates.push({ ...base, kind: "click", value: value.slice(0, 500), label: `Open ${base.label}` });
  }

  const availableActions = candidates.slice(0, 500);
  if (scrollY + innerHeight < document.documentElement.scrollHeight - 2) {
    availableActions.push({ kind: "scroll", label: "Scroll down", delta: Math.round(innerHeight * 0.72) });
  }
  if (scrollY > 0) availableActions.push({ kind: "scroll", label: "Scroll up", delta: -Math.round(innerHeight * 0.72) });
  availableActions.forEach((action, index) => { action.id = `e${index + 1}`; });
  const actions = [
    ...availableActions.filter((action) => action.kind !== "scroll").slice(0, maxActions),
    ...availableActions.filter((action) => action.kind === "scroll")
  ];
  const omittedActions = Math.max(0, candidates.length - maxActions);
  cache.actions = new Map(actions.map((action) => [action.id, action]));

  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let textLength = 0;
  let textNode;
  while ((textNode = walker.nextNode()) && textLength < 50000) {
    const value = textNode.textContent.trim();
    const parent = textNode.parentElement;
    if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight) {
      words.push(value);
      textLength += value.length;
    }
  }
  const fullText = words.join("\n").slice(0, 50000);
  const text = fullText.slice(0, maxTextLength);
  const controlState = [...document.querySelectorAll("input,textarea,select")].filter(safe)
    .map((element) => [identity(element), element.value, element.checked, element.selectedIndex, element.disabled, element.readOnly]);
  const pageKey = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight, controlState];
  const guards = {};
  for (const action of actions) {
    if (Number.isInteger(action.node) && guards[action.node] === undefined) guards[action.node] = guard(cache.nodes.get(action.node));
  }
  const semantics = availableActions.map(({ rect, ...action }) => action);
  const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, fullText, semantics, controlState];
  const serialized = JSON.stringify(marker);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = `${performance.timeOrigin.toString(36)}-${(hash >>> 0).toString(36)}`;
  cache.fingerprint = fingerprint;
  cache.pageKey = pageKey;
  cache.guards = guards;

  return {
    url: location.href,
    title: document.title,
    text,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY, height: document.documentElement.scrollHeight },
    fingerprint,
    pageKey,
    guards,
    actions,
    omittedActions
  };
}
