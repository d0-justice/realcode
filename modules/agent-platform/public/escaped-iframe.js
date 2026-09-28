// Ported from FenixAgent/web/src/lib/escaped-iframe.ts.
const ESCAPED_IFRAME_PATTERN = /^(&lt;iframe\b[^<>]*?&gt;)\s*&lt;\/iframe&gt;$/i;
const ESCAPED_SRC_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|&quot;([\s\S]*?)&quot;)/i;

function decodeUrlEntities(value) {
  return value
    .replace(/&#x26;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&amp;/gi, "&")
    .replace(/&#x22;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&quot;/gi, '"');
}

export function parseEscapedIframeSrc(input) {
  const value = input?.trim();
  if (!value || /[\r\n]/.test(value)) return null;
  const openingTag = value.match(ESCAPED_IFRAME_PATTERN)?.[1];
  if (!openingTag) return null;
  const match = openingTag.match(ESCAPED_SRC_PATTERN);
  const encodedSrc = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!encodedSrc) return null;
  const src = decodeUrlEntities(encodedSrc).trim();
  if ([...src].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) return null;
  try {
    const url = new URL(src);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

/** Resolve FenixAgent-style user/ previews inside the isolated workspace. */
export function parseLocalIframeSrc(input) {
  const value = input?.trim();
  if (!value || /[\r\n]/.test(value)) return null;
  const match = value.match(/^&lt;iframe\b[^<>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|&quot;([\s\S]*?)&quot;)[^<>]*?&gt;\s*&lt;\/iframe&gt;$/i);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!raw) return null;
  const relative = raw.replace(/^\.\//, "").replace(/^\//, "");
  if (!relative.startsWith("user/") || relative.split("/").includes("..") || relative.includes("\\") || relative.includes("?") || relative.includes("#")) return null;
  return `/fs/${relative.split("/").map(encodeURIComponent).join("/")}`;
}
