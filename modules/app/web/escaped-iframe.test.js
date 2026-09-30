import { expect, test } from "bun:test";
import { parseEscapedIframeSrc, parseLocalIframeSrc } from "./escaped-iframe.js";

test("renders only safe standalone iframe URLs", () => {
  expect(parseEscapedIframeSrc('&lt;iframe src="https://example.com/a?b=1&amp;c=2"&gt;&lt;/iframe&gt;')).toBe("https://example.com/a?b=1&c=2");
  expect(parseEscapedIframeSrc('&lt;iframe src="javascript:alert(1)"&gt;&lt;/iframe&gt;')).toBeNull();
  expect(parseEscapedIframeSrc('&lt;iframe src="https://user:pass@example.com"&gt;&lt;/iframe&gt;')).toBeNull();
  expect(parseLocalIframeSrc('&lt;iframe src="user/report.html"&gt;&lt;/iframe&gt;')).toBe("/fs/user/report.html");
  expect(parseLocalIframeSrc('&lt;iframe src="user/../secret.html"&gt;&lt;/iframe&gt;')).toBeNull();
});
