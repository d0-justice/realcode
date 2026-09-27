/**
 * Returns an HTTP(S) destination that should stay inside the floating preview.
 * Downloads and same-document targets keep their native click behavior.
 */
export function resolveFloatingLinkNavigation(link) {
  if (!link || link.download || !link.href) return null;
  const target = String(link.target || "").toLowerCase();
  if (!target || target === "_self") return null;
  try {
    const url = new URL(link.href);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
