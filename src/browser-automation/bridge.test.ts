import { describe, expect, test } from "bun:test";
import { BROWSER_METHODS, BrowserBridge } from "./bridge";

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
}

describe("BrowserBridge", () => {
  // 验证扩展认证、命令完成和最新页面状态缓存形成一个完整链路。
  test("authenticates an extension and resolves a browser command", async () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({
      type: "hello",
      protocol: "realcode-browser-bridge/3",
      clientId: "client-1",
      token: "pair-token",
      extensionVersion: "0.1.0",
      selectedTabId: 7,
    }));
    expect(bridge.status()).toMatchObject({ connected: true, authenticated: true, selectedTabId: 7 });

    const pending = bridge.command("browser.observe", { maxActions: 3 });
    await Promise.resolve();
    const command = socket.sent.find((message) => message.type === "command")!;
    const state = { fingerprint: "page-1", actions: [] };
    bridge.message(socket, JSON.stringify({ type: "page_state", sequence: 1, commandId: command.id, state }));
    bridge.message(socket, JSON.stringify({ type: "result", id: command.id, ok: true, result: state }));
    expect(await pending).toEqual(state);
    expect(bridge.latestPageState()).toMatchObject({ sequence: 1, commandId: command.id, state });
    expect(bridge.status().pendingCommands).toBe(0);
  });

  // 验证 Agent 只能看到特征观察、受保护操作、诊断截图和新标签页回退。
  test("exposes only the compact browser automation protocol", () => {
    expect(BROWSER_METHODS).toEqual([
      "browser.observe",
      "browser.act",
      "browser.screenshot",
      "browser.openTab",
    ]);
  });

  // 验证乱序到达的旧页面状态不会覆盖服务端缓存中的较新状态。
  test("keeps the newest streamed page state", () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/3", clientId: "x", token: "pair-token" }));
    bridge.message(socket, JSON.stringify({ type: "page_state", sequence: 2, commandId: "new", state: { fingerprint: "new" } }));
    bridge.message(socket, JSON.stringify({ type: "page_state", sequence: 1, commandId: "old", state: { fingerprint: "old" } }));
    expect(bridge.latestPageState()).toMatchObject({ sequence: 2, commandId: "new", state: { fingerprint: "new" } });
  });

  // 验证服务端只向扩展发送一个在途命令，防止重试与旧操作重叠执行。
  test("serializes browser commands before sending them to the extension", async () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/3", clientId: "x", token: "pair-token" }));
    const first = bridge.command("browser.observe");
    const second = bridge.command("browser.screenshot");
    await Promise.resolve();
    let commands = socket.sent.filter((message) => message.type === "command");
    expect(commands).toHaveLength(1);
    bridge.message(socket, JSON.stringify({ type: "result", id: commands[0]!.id, ok: true, result: { frames: [] } }));
    await first;
    await Promise.resolve();
    commands = socket.sent.filter((message) => message.type === "command");
    expect(commands).toHaveLength(2);
    bridge.message(socket, JSON.stringify({ type: "result", id: commands[1]!.id, ok: true, result: { captured: true } }));
    await second;
    expect(bridge.status()).toMatchObject({ pendingCommands: 0, queuedCommands: 0 });
  });

  // 验证错误配对令牌会立即关闭连接。
  test("rejects an invalid pairing token", () => {
    const bridge = new BrowserBridge({ pairingToken: "correct", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/3", clientId: "x", token: "wrong" }));
    expect(socket.closed?.code).toBe(4003);
    expect(bridge.status().authenticated).toBe(false);
  });

  // 验证未选择标签页时扩展仍可恢复 RealCode 控制目标。
  test("lets the extension recover the RealCode tab when selection is empty", async () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/3", clientId: "x", token: "pair-token" }));
    const pending = bridge.command("browser.observe", { maxActions: 3 });
    await Promise.resolve();
    const command = socket.sent.find((message) => message.type === "command")!;
    expect(command.method).toBe("browser.observe");
    bridge.message(socket, JSON.stringify({ type: "result", id: command.id, ok: true, result: { tabId: 9, frames: [] } }));
    expect(await pending).toEqual({ tabId: 9, frames: [] });
  });
});
