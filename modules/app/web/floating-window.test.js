import { describe, expect, test } from "bun:test";
import { configurePreviewFrame } from "./floating-window.js";

function createFrame() {
  const attributes = new Map();
  return {
    attributes,
    referrerPolicy: "",
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function sandboxTokens(frame) {
  return new Set((frame.attributes.get("sandbox") ?? "").split(/\s+/).filter(Boolean));
}

describe("floating preview frame permissions", () => {
  // 外部页面需要在用户点击链接时支持 target=_blank 与 window.open 导航。
  test("allows external pages to navigate links without dropping preview capabilities", () => {
    const frame = createFrame();

    configurePreviewFrame(frame, "https://example.com/page");

    const tokens = sandboxTokens(frame);
    for (const permission of [
      "allow-scripts",
      "allow-forms",
      "allow-downloads",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-modals",
      "allow-presentation",
    ]) expect(tokens.has(permission)).toBeTrue();
    expect(frame.attributes.get("allow")).toContain("fullscreen");
    expect(frame.attributes.get("allow")).toContain("tools");
    expect(frame.attributes.get("allow")).not.toContain("autoplay");
    expect(frame.attributes.has("allowfullscreen")).toBeTrue();
    expect(frame.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  // 本地文件可打开链接，但仍保持唯一来源隔离，不授予 allow-same-origin。
  test("keeps local previews isolated while allowing user initiated links", () => {
    const frame = createFrame();

    configurePreviewFrame(frame, "/fs/user/report.html");

    const tokens = sandboxTokens(frame);
    expect(tokens.has("allow-popups")).toBeTrue();
    expect(tokens.has("allow-popups-to-escape-sandbox")).toBeTrue();
    expect(tokens.has("allow-same-origin")).toBeFalse();
    expect(frame.attributes.has("allow")).toBeFalse();
    expect(frame.attributes.has("allowfullscreen")).toBeFalse();
  });

  // 同一个浮窗从外站切回本地文件时必须撤销外站专属权限。
  test("removes external-only attributes when reusing the frame for a local file", () => {
    const frame = createFrame();

    configurePreviewFrame(frame, "https://example.com/page");
    configurePreviewFrame(frame, "/fs/user/report.html");

    expect(sandboxTokens(frame).has("allow-same-origin")).toBeFalse();
    expect(frame.attributes.has("allow")).toBeFalse();
    expect(frame.attributes.has("allowfullscreen")).toBeFalse();
  });
});
