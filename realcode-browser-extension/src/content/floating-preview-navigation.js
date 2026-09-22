(() => {
  if (window.top === window) return;

  const nonce = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let enabled = false;
  let lastTrustedClickAt = 0;

  window.addEventListener("message", (event) => {
    if (
      event.source === window.parent &&
      event.data?.type === "realcode-floating-preview-ack" &&
      event.data?.nonce === nonce
    ) enabled = true;
  });

  window.parent.postMessage({ type: "realcode-floating-preview-probe", nonce }, "*");

  document.addEventListener("click", (event) => {
    if (!enabled || event.defaultPrevented || event.button !== 0) return;
    if (event.isTrusted) lastTrustedClickAt = performance.now();
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.href);
    if (!anchor) return;
    const target = String(anchor.target || "").toLowerCase();
    const opensAnotherContext = Boolean(target && target !== "_self") || event.ctrlKey || event.metaKey || event.shiftKey;
    if (!opensAnotherContext) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(anchor.href);
  }, true);

  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const normalizedTarget = String(target || "_blank").toLowerCase();
    const hasUserActivation = navigator.userActivation?.isActive === true;
    const followsCurrentDocumentClick = performance.now() - lastTrustedClickAt < 1000;
    const destination = url ? new URL(String(url), location.href).href : "";
    if (
      enabled &&
      hasUserActivation &&
      followsCurrentDocumentClick &&
      destination &&
      destination !== location.href &&
      normalizedTarget !== "_self"
    ) {
      lastTrustedClickAt = 0;
      location.assign(destination);
      return window;
    }
    return nativeOpen(url, target, features);
  };
})();
