/** Validates an observed action against the live DOM immediately before input. */
export function prepareObservedAction(args) {
  const cache = globalThis.__realcodeAutomation;
  if (!cache || cache.fingerprint !== args.fingerprint) {
    return { stale: true, reason: "Page features changed since observation" };
  }
  const action = cache.actions.get(args.actionId);
  if (!action) return { stale: true, reason: "Observed action is no longer available" };
  if (action.kind === "scroll") return { kind: "scroll", delta: action.delta, action };
  const element = cache.nodes.get(action.node);
  if (!element?.isConnected || element.matches(":disabled") ||
      element.closest('[aria-disabled="true"],[inert]') ||
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return { stale: true, reason: "Target changed, became disabled, or is no longer visible" };
  }
  if (action.kind === "fill" && (element.readOnly || element.getAttribute("aria-readonly") === "true")) {
    return { stale: true, reason: "Target is read-only" };
  }
  if (action.kind === "select") {
    if (element.tagName !== "SELECT") return { stale: true, reason: "Target is no longer a select control" };
    const option = [...element.options].find((item) =>
      item.value === action.value && !item.disabled && !item.closest("optgroup[disabled]"));
    if (!option) return { stale: true, reason: "Observed option is no longer available" };
    element.value = action.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { kind: "select", action, selected: action.value };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
      !element.contains(document.elementFromPoint(x, y))) {
    return { stale: true, reason: "Target is outside the viewport or covered" };
  }
  if (args.keepLinksInFrame) {
    const anchor = element.closest("a[href]");
    if (anchor && String(anchor.target || "").toLowerCase() !== "_self") anchor.target = "_self";
  }
  element.focus();
  return {
    kind: action.kind,
    action,
    x,
    y,
    link: action.href ? { href: action.href, target: action.target, download: action.download } : null,
    autocomplete: action.kind === "fill" && element.getAttribute("role") === "combobox"
  };
}

/** Waits only for the useful browser state associated with the action. */
export function settleAfterObservedAction(args) {
  return new Promise((resolve) => {
    const cache = globalThis.__realcodeAutomation;
    const action = cache?.actions.get(args.actionId);
    const field = action?.node ? cache.nodes.get(action.node) : null;
    const autocomplete = args.autocomplete === true;
    const deadlineMs = autocomplete ? 200 : 50;
    const startedAt = performance.now();
    let frames = 0;
    const finish = (reason) => resolve({ reason, waitedMs: Math.round(performance.now() - startedAt) });
    const ready = () => {
      frames += 1;
      if (autocomplete && field) {
        const ids = String(field.getAttribute("aria-controls") || field.getAttribute("aria-owns") || "")
          .split(/\s+/).filter(Boolean);
        const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
        const visibleOption = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]).some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
            element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        });
        if (frames >= 2 && visibleOption) return finish("autocomplete-options-visible");
      } else if (frames >= 2) {
        return finish("two-animation-frames");
      }
      if (performance.now() - startedAt >= deadlineMs) return finish("bounded-timeout");
      requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });
}
