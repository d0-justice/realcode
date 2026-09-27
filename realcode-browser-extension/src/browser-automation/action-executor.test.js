import { afterEach, describe, expect, test } from "bun:test";
import { prepareObservedAction } from "./action-executor.js";

const previousDocument = globalThis.document;
const previousWidth = globalThis.innerWidth;
const previousHeight = globalThis.innerHeight;

afterEach(() => {
  globalThis.document = previousDocument;
  globalThis.innerWidth = previousWidth;
  globalThis.innerHeight = previousHeight;
  delete globalThis.__realcodeAutomation;
});

function editableElement() {
  const element = {
    isConnected: true,
    readOnly: false,
    type: "text",
    matches: () => false,
    closest: () => null,
    checkVisibility: () => true,
    getAttribute: (name) => name === "role" ? "combobox" : null,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 }),
    scrollIntoView: () => {},
    contains: (candidate) => candidate === element,
    focus: () => {},
  };
  return element;
}

describe("prepareObservedAction", () => {
  // 验证页面其他区域变化不会使观察缓存中的稳定目标节点失效。
  test("keeps a target actionable while unrelated page content changes", () => {
    const element = editableElement();
    globalThis.document = { elementFromPoint: () => element };
    globalThis.innerWidth = 800;
    globalThis.innerHeight = 600;
    globalThis.__realcodeAutomation = {
      fingerprint: "observation-1",
      actions: new Map([["e9", { id: "e9", kind: "fill", node: 9, label: "搜索" }]]),
      nodes: new Map([[9, element]]),
    };

    const result = prepareObservedAction({ actionId: "e9", fingerprint: "observation-1" });
    expect(result).toMatchObject({ kind: "fill", x: 110, y: 35, autocomplete: true });
  });

  // 验证来自另一轮观察的操作令牌仍会被拒绝。
  test("rejects an action from a superseded observation", () => {
    globalThis.__realcodeAutomation = {
      fingerprint: "observation-2",
      actions: new Map(),
      nodes: new Map(),
    };
    expect(prepareObservedAction({ actionId: "e9", fingerprint: "observation-1" })).toEqual({
      stale: true,
      reason: "Page features changed since observation",
    });
  });
});
