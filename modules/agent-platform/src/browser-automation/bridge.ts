import { timingSafeEqual } from "node:crypto";
import { activityLog } from "./activity-log";

export const BROWSER_BRIDGE_PROTOCOL = "realcode-browser-bridge/3";

export const BROWSER_METHODS = [
  "browser.observe",
  "browser.act",
  "browser.screenshot",
  "browser.openTab",
  "browser.site",
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
  timing?: { startedAt?: string; finishedAt?: string; durationMs?: number };
}

interface ExtensionCommandEvent {
  type: "command_event";
  id: string;
  phase: "accepted" | "executing" | "completed" | "failed";
  at: string;
  queueDepth?: number;
  durationMs?: number;
}

export interface BrowserPageState {
  sequence: number;
  commandId: string | null;
  receivedAt: string;
  state: unknown;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserMethod;
  startedAt: number;
}

export interface BrowserBridgeStatus {
  connected: boolean;
  authenticated: boolean;
  clientId: string | null;
  extensionVersion: string | null;
  selectedTabId: number | null;
  connectedAt: string | null;
  pendingCommands: number;
  queuedCommands: number;
}

type BridgeEvent =
  | { type: "browser_bridge"; at: string; data: BrowserBridgeStatus }
  | { type: "browser_command"; at: string; data: ExtensionCommandEvent }
  | { type: "browser_page_state"; at: string; data: BrowserPageState };

type BridgeListener = (event: BridgeEvent) => void;

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
  private commandTail: Promise<void> = Promise.resolve();
  private queuedCommands = 0;
  private listeners = new Set<BridgeListener>();
  private pageState: BrowserPageState | null = null;
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
      queuedCommands: this.queuedCommands,
    };
  }

  /** Returns the newest structured page state pushed by the extension. */
  latestPageState(): BrowserPageState | null {
    return this.pageState;
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
    if (message.type === "command_event") this.receiveCommandEvent(message as unknown as ExtensionCommandEvent);
    if (message.type === "page_state") this.receivePageState(message);
    if (message.type === "state") {
      const selectedTabId = Number.isInteger(message.selectedTabId) ? Number(message.selectedTabId) : null;
      if (selectedTabId !== this.selectedTabId) this.pageState = null;
      this.selectedTabId = selectedTabId;
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

  async command(method: BrowserMethod, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    if (!BROWSER_METHODS.includes(method)) throw new Error(`不支持的浏览器工具：${method}`);
    const socket = this.socket;
    if (!socket || !this.authenticated) throw new Error("Chrome 扩展尚未连接 RealCode");
    this.queuedCommands += 1;
    activityLog("browser", "command.queued", { method, queueDepth: this.queuedCommands });
    this.emit();
    const task = this.commandTail.then(() => this.dispatchCommand(socket, method, args, timeoutMs));
    this.commandTail = task.then(() => undefined, () => undefined);
    try {
      return await task;
    } finally {
      this.queuedCommands = Math.max(0, this.queuedCommands - 1);
      this.emit();
    }
  }

  private async dispatchCommand(socket: BrowserSocket, method: BrowserMethod, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.socket !== socket || !this.authenticated) throw new Error("浏览器扩展连接已变化，请重新执行操作");
    const id = `browser-${Date.now()}-${++this.sequence}`;
    const startedAt = Date.now();
    activityLog("browser", "command.started", { commandId: id, method, timeoutMs });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        activityLog("browser", "command.timed_out", { commandId: id, method, durationMs: Date.now() - startedAt });
        reject(new Error(`浏览器工具执行超时：${method}`));
        this.emit();
      }, Math.min(Math.max(timeoutMs, 1_000), 120_000));
      this.pending.set(id, { resolve, reject, timer, method, startedAt });
    });
    socket.send(JSON.stringify({ type: "command", id, method, args }));
    this.emit();
    return result;
  }

  private resolveResult(message: ExtensionResult): void {
    if (typeof message.id !== "string") return;
    const item = this.pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(message.id);
    activityLog("browser", message.ok ? "command.completed" : "command.failed", {
      commandId: message.id,
      method: item.method,
      durationMs: Date.now() - item.startedAt,
      extensionDurationMs: message.timing?.durationMs,
      extensionStartedAt: message.timing?.startedAt,
      extensionFinishedAt: message.timing?.finishedAt,
      error: message.ok ? undefined : message.error?.message,
    });
    if (message.ok) item.resolve(message.result);
    else item.reject(new Error(message.error?.message || "浏览器工具执行失败"));
    this.emit();
  }

  private receiveCommandEvent(message: ExtensionCommandEvent): void {
    if (typeof message.id !== "string" || !["accepted", "executing", "completed", "failed"].includes(message.phase)) return;
    const event = { type: "browser_command" as const, at: new Date().toISOString(), data: message };
    activityLog("browser", `extension.${message.phase}`, {
      commandId: message.id,
      queueDepth: message.queueDepth,
      extensionDurationMs: message.durationMs,
    });
    for (const listener of this.listeners) listener(event);
  }

  private receivePageState(message: Record<string, unknown>): void {
    if (!Number.isInteger(message.sequence) || typeof message.state !== "object" || message.state === null) return;
    const next: BrowserPageState = {
      sequence: Number(message.sequence),
      commandId: typeof message.commandId === "string" ? message.commandId : null,
      receivedAt: new Date().toISOString(),
      state: message.state,
    };
    if (this.pageState && next.sequence <= this.pageState.sequence) return;
    this.pageState = next;
    const event = { type: "browser_page_state" as const, at: next.receivedAt, data: next };
    for (const listener of this.listeners) listener(event);
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
    this.pageState = null;
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
