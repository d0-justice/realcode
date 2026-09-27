import { describe, expect, test } from "bun:test";
import { resolveFloatingLinkNavigation } from "./link-navigation.js";

describe("resolveFloatingLinkNavigation", () => {
  // 新窗口链接在浮窗中应改为当前 iframe 导航，避免打开新标签页。
  test("keeps blank-target links in the floating frame", () => {
    expect(resolveFloatingLinkNavigation({
      href: "https://www.bilibili.com/bangumi/",
      target: "_blank",
      download: false
    })).toBe("https://www.bilibili.com/bangumi/");
  });

  // 当前窗口链接继续走可信鼠标事件，以保留站点自己的点击逻辑。
  test("leaves self-target links on the native click path", () => {
    expect(resolveFloatingLinkNavigation({
      href: "https://example.com/next",
      target: "_self",
      download: false
    })).toBeNull();
  });

  // 下载和非网页协议不能被转换成 iframe 页面导航。
  test("rejects downloads and non-http destinations", () => {
    expect(resolveFloatingLinkNavigation({ href: "https://example.com/file.zip", target: "_blank", download: true })).toBeNull();
    expect(resolveFloatingLinkNavigation({ href: "javascript:alert(1)", target: "_blank", download: false })).toBeNull();
  });
});
