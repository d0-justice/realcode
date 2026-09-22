import { timingSafeEqual } from "node:crypto";

export const BROWSER_BRIDGE_PROTOCOL = "realcode-browser-bridge/2";

export const BROWSER_METHODS = [
  "browser.snapshot",
  "browser.click",
  "browser.fill",
  "browser.select",
  "browser.scroll",
  "browser.screenshot",
  "browser.navigate",
  "browser.openTab",
  "browser.switchTab",
  "browser.wait",
] as const;

export type BrowserMethod = (typeof BROWSER_METHODS)[number];

interface BrowserSocket {
  send(data: string): number | void;
  close(code?: number, reason?: string): void;
}

interface ExtensionHello {
  type: "hello";
  protocol: string;
  clientId: string;
  token: string;
  extensionVersion?: string;
  selectedTabId?: number | null;
}

interface ExtensionResult {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserBridgeStatus {
  connected: boolean;
  authenticated: boolean;
  clientId: string | null;
  extensionVersion: string | null;
  selectedTabId: number | null;
  connectedAt: string | null;
  pendingCommands: number;
}

type BridgeListener = (event: { type: "browser_bridge"; at: string; data: BrowserBridgeStatus }) => void;

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseMessage(raw: string | Buffer | ArrayBuffer): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw));
  return JSON.parse(raw.toString("utf8"));
}

export class BrowserBridge {
  private socket: BrowserSocket | null = null;
  private authenticated = false;
  private clientId: string | null = null;
  private extensionVersion: string | null = null;
  private selectedTabId: number | null = null;
  private connectedAt: string | null = null;
  private sequence = 0;
  private pending = new Map<string, PendingCommand>();
  private listeners = new Set<BridgeListener>();
  private pairingToken: string;
  readonly internalSecret: string;

  constructor(options: { pairingToken?: string; internalSecret?: string } = {}) {
    this.pairingToken = options.pairingToken ?? crypto.randomUUID();
    this.internalSecret = options.internalSecret ?? crypto.randomUUID();
  }

  subscribe(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const event = { type: "browser_bridge" as const, at: new Date().toISOString(), data: this.status() };
    for (const listener of this.listeners) listener(event);
  }

  status(): BrowserBridgeStatus {
    return {
      connected: this.socket !== null,
      authenticated: this.authenticated,
      clientId: this.clientId,
      extensionVersion: this.extensionVersion,
      selectedTabId: this.selectedTabId,
      connectedAt: this.connectedAt,
      pendingCommands: this.pending.size,
    };
  }

  pairing() {
    return { token: this.pairingToken, protocol: BROWSER_BRIDGE_PROTOCOL, status: this.status() };
  }

  rotatePairingToken(): ReturnType<BrowserBridge["pairing"]> {
    this.pairingToken = crypto.randomUUID();
    this.socket?.close(4001, "Pairing token rotated");
    this.resetConnection(new Error("浏览器扩展配对令牌已更新"));
    return this.pairing();
  }

  open(socket: BrowserSocket): void {
    if (this.socket && this.socket !== socket) this.socket.close(4002, "A newer extension connection replaced this one");
    this.resetConnection(new Error("浏览器扩展连接已替换"), false);
    this.socket = socket;
    this.emit();
  }

  close(socket: BrowserSocket): void {
    if (this.socket !== socket) return;
    this.resetConnection(new Error("浏览器扩展连接已断开"));
  }

  message(socket: BrowserSocket, raw: string | Buffer | ArrayBuffer): void {
    if (socket !== this.socket) return;
    let parsed: unknown;
    try {
      parsed = parseMessage(raw);
    } catch {
      socket.close(4000, "Invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;

    if (message.type === "hello") {
      this.authenticate(socket, message as unknown as ExtensionHello);
      return;
    }
    if (!this.authenticated) {
      socket.close(4003, "Authenticate first");
      return;
    }
    if (message.type === "result") this.resolveResult(message as unknown as ExtensionResult);
    if (message.type === "state") {
      this.selectedTabId = Number.isInteger(message.selectedTabId) ? Number(message.selectedTabId) : null;
      this.emit();
    }
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  private authenticate(socket: BrowserSocket, hello: ExtensionHello): void {
    if (
      hello.protocol !== BROWSER_BRIDGE_PROTOCOL ||
      typeof hello.clientId !== "string" ||
      !hello.clientId ||
      typeof hello.token !== "string" ||
      !secureEqual(hello.token, this.pairingToken)
    ) {
      socket.close(4003, "Invalid pairing token or protocol");
      this.resetConnection(new Error("浏览器扩展认证失败"));
      return;
    }
    this.authenticated = true;
    this.clientId = hello.clientId.slice(0, 128);
    this.extensionVersion = typeof hello.extensionVersion === "string" ? hello.extensionVersion.slice(0, 32) : null;
    this.selectedTabId = Number.isInteger(hello.selectedTabId) ? Number(hello.selectedTabId) : null;
    this.connectedAt = new Date().toISOString();
    socket.send(JSON.stringify({ type: "ready", protocol: BROWSER_BRIDGE_PROTOCOL }));
    this.emit();
  }

  async command(method: BrowserMethod, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (!BROWSER_METHODS.includes(method)) throw new Error(`不支持的浏览器工具：${method}`);
    if (!this.socket || !this.authenticated) throw new Error("Chrome 扩展尚未连接 RealCode");
    const id = `browser-${Date.now()}-${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器工具执行超时：${method}`));
        this.emit();
      }, Math.min(Math.max(timeoutMs, 1_000), 120_000));
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ type: "command", id, method, args }));
    this.emit();
    return result;
  }

  private resolveResult(message: ExtensionResult): void {
    if (typeof message.id !== "string") return;
    const item = this.pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(message.id);
    if (message.ok) item.resolve(message.result);
    else item.reject(new Error(message.error?.message || "浏览器工具执行失败"));
    this.emit();
  }

  private resetConnection(error: Error, emit = true): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.socket = null;
    this.authenticated = false;
    this.clientId = null;
    this.extensionVersion = null;
    this.selectedTabId = null;
    this.connectedAt = null;
    if (emit) this.emit();
  }

  shutdown(): void {
    this.socket?.close(1001, "RealCode is shutting down");
    this.resetConnection(new Error("RealCode 已停止"));
  }
}

export function isBrowserMethod(value: unknown): value is BrowserMethod {
  return typeof value === "string" && BROWSER_METHODS.includes(value as BrowserMethod);
}
