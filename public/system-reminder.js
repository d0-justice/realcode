// Ported from FenixAgent/web/src/lib/strip-html-tags.ts.
const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

export function splitSystemReminderBlocks(text) {
  if (!text) return [];
  const segments = [];
  let rest = text.trim();
  while (rest) {
    const openIndex = rest.indexOf(OPEN);
    if (openIndex < 0) { segments.push({ kind: "text", text: rest }); break; }
    const closeIndex = rest.indexOf(CLOSE, openIndex + OPEN.length);
    if (closeIndex < 0) { segments.push({ kind: openIndex === 0 ? "system" : "text", text: rest }); break; }
    const before = rest.slice(0, openIndex).trim();
    if (before) segments.push({ kind: "text", text: before });
    segments.push({ kind: "system", text: rest.slice(openIndex, closeIndex + CLOSE.length) });
    rest = rest.slice(closeIndex + CLOSE.length).trim();
  }
  return segments;
}
