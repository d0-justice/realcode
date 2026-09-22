import { describe, expect, test } from "bun:test";
import { BrowserBridge } from "./browser-bridge";

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
}

describe("BrowserBridge", () => {
  test("authenticates an extension and resolves a browser command", async () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({
      type: "hello",
      protocol: "realcode-browser-bridge/2",
      clientId: "client-1",
      token: "pair-token",
      extensionVersion: "0.1.0",
      selectedTabId: 7,
    }));
    expect(bridge.status()).toMatchObject({ connected: true, authenticated: true, selectedTabId: 7 });

    const pending = bridge.command("browser.snapshot", { maxElements: 3 });
    const command = socket.sent.find((message) => message.type === "command")!;
    bridge.message(socket, JSON.stringify({ type: "result", id: command.id, ok: true, result: { frames: [] } }));
    expect(await pending).toEqual({ frames: [] });
    expect(bridge.status().pendingCommands).toBe(0);
  });

  test("rejects an invalid pairing token", () => {
    const bridge = new BrowserBridge({ pairingToken: "correct", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/2", clientId: "x", token: "wrong" }));
    expect(socket.closed?.code).toBe(4003);
    expect(bridge.status().authenticated).toBe(false);
  });

  test("lets the extension recover the RealCode tab when selection is empty", async () => {
    const bridge = new BrowserBridge({ pairingToken: "pair-token", internalSecret: "internal" });
    const socket = new FakeSocket();
    bridge.open(socket);
    bridge.message(socket, JSON.stringify({ type: "hello", protocol: "realcode-browser-bridge/2", clientId: "x", token: "pair-token" }));
    const pending = bridge.command("browser.snapshot", { maxElements: 3 });
    const command = socket.sent.find((message) => message.type === "command")!;
    expect(command.method).toBe("browser.snapshot");
    bridge.message(socket, JSON.stringify({ type: "result", id: command.id, ok: true, result: { tabId: 9, frames: [] } }));
    expect(await pending).toEqual({ tabId: 9, frames: [] });
  });
});
