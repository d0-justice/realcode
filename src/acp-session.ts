import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { prepareDefaultModelConfig, prepareLaunchConfig } from "./launch-config";
import { pythonEnvironment } from "./python-env";

const execFileAsync = promisify(execFile);

export interface LabEvent {
  type: string;
  at: string;
  data: unknown;
}

type Listener = (event: LabEvent) => void;

interface PendingPermission {
  options: Array<{ optionId: string; name: string; kind: string }>;
  resolve: (value: acp.RequestPermissionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  message: string;
  schema: acp.ElicitationSchema;
  resolve: (value: acp.CreateElicitationResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function executablePath(): string {
  const configured = process.env.OPENCODE_BIN;
  if (configured) return configured;
  const packageBinary = resolve(import.meta.dir, "../node_modules/opencode-ai/bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  if (existsSync(packageBinary)) return packageBinary;
  const local = resolve(import.meta.dir, "../node_modules/.bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  return existsSync(local) ? local : "opencode";
}

export class AcpSessionLab {
  readonly workspace: string;
  readonly binary: string;
  private process: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private busy = false;
  private listeners = new Set<Listener>();
  private pending = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private sequence = 0;
  private messages: Array<{ id: string; role: "user" | "assistant" | "thought" | "tool"; text: string; images?: Array<{ data: string; mimeType: string }>; details?: Record<string, unknown> }> = [];
  private messageSequence = 0;
  private configOptions: acp.SessionConfigOption[] = [];
  private supportsImages = false;
  private availableCommands: acp.AvailableCommand[] = [];
  private planEntries: acp.PlanEntry[] = [];
  private lastUsage: acp.PromptResponse["usage"] | null = null;
  private sessionTitles = new Map<string, string>();
  private readonly browserMcp: BrowserMcpConfig | null;

  constructor(workspace: string, options: { browserMcp?: BrowserMcpConfig } = {}) {
    this.workspace = resolve(workspace);
    this.binary = executablePath();
    this.browserMcp = options.browserMcp ?? null;
    mkdirSync(this.workspace, { recursive: true });
    const titlesPath = join(this.workspace, ".myopencode", "session-titles.json");
    if (existsSync(titlesPath)) {
      const stored = JSON.parse(readFileSync(titlesPath, "utf8")) as Record<string, string>;
      this.sessionTitles = new Map(Object.entries(stored));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: string, data: unknown): void {
    const event = { type, at: new Date().toISOString(), data };
    for (const listener of this.listeners) listener(event);
  }

  status() {
    return {
      connected: this.connection !== null,
      sessionId: this.sessionId,
      busy: this.busy,
      workspace: this.workspace,
      binary: this.binary,
      permissions: [...this.pending.entries()].map(([requestId, item]) => ({ requestId, options: item.options })),
      questions: [...this.pendingQuestions.entries()].map(([requestId, item]) => ({ requestId, message: item.message, schema: item.schema })),
      configOptions: this.configOptions,
      supportsImages: this.imageAllowed(),
      promptSupportsImages: this.supportsImages,
      availableCommands: this.availableCommands,
      planEntries: this.planEntries,
      lastUsage: this.lastUsage,
    };
  }

  private imageAllowed(): boolean {
    const model = this.configOptions.find((option) => option.category === "model" || option.id === "model")?.currentValue;
    // OpenCode ACP advertises image support for the agent, while Big Pickle itself is text-only.
    return this.supportsImages && model !== "opencode/big-pickle";
  }

  messageSnapshot() {
    return { sessionId: this.sessionId, messages: this.messages.map((message) => ({ ...message })) };
  }

  private receiveUpdate(params: acp.SessionNotification) {
    const update = params.update;
    if (params.sessionId === this.sessionId && update.sessionUpdate === "available_commands_update") this.availableCommands = update.availableCommands;
    if (params.sessionId === this.sessionId && update.sessionUpdate === "config_option_update") this.configOptions = update.configOptions;
    if (params.sessionId === this.sessionId && update.sessionUpdate === "plan") this.planEntries = update.entries;
    if (params.sessionId === this.sessionId && update.sessionUpdate === "plan_update" && update.plan.type === "items") this.planEntries = update.plan.entries;
    if (params.sessionId === this.sessionId && update.sessionUpdate === "plan_removed") this.planEntries = [];
    if (params.sessionId === this.sessionId && update.sessionUpdate === "user_message_chunk" && (update.content.type === "text" || update.content.type === "image")) {
      const id = `user-${update.messageId ?? this.messageSequence++}`;
      let message = this.messages.find((item) => item.id === id);
      if (!message) {
        message = { id, role: "user", text: "" };
        this.messages.push(message);
      }
      if (update.content.type === "text") message.text += update.content.text;
      else message.images = [...(message.images ?? []), { data: update.content.data, mimeType: update.content.mimeType }];
    }
    if (params.sessionId === this.sessionId && (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
      const role = update.sessionUpdate === "agent_thought_chunk" ? "thought" : "assistant";
      const id = `${role}-${update.messageId ?? this.messageSequence}`;
      let message = this.messages.find((item) => item.id === id);
      if (!message) {
        message = { id, role, text: "" };
        this.messages.push(message);
      }
      message.text += update.content.text;
    }
    if (params.sessionId === this.sessionId && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
      const id = `tool-${update.toolCallId}`;
      let message = this.messages.find((item) => item.id === id);
      if (!message) {
        message = { id, role: "tool", text: update.title ?? "工具调用" };
        this.messages.push(message);
      } else if (update.title) message.text = update.title;
      message.details = {
        ...message.details,
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.kind !== undefined ? { kind: update.kind } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.content !== undefined ? { content: update.content } : {}),
        ...(update.locations !== undefined ? { locations: update.locations } : {}),
      };
    }
    this.emit("update", params);
  }

  async connect() {
    if (this.connection) return this.status();
    const configured = await prepareLaunchConfig(this.workspace);
    if (configured) this.emit("configuration", { source: "launch.json", workspace: this.workspace });
    else await prepareDefaultModelConfig(this.workspace);
    // Keep the lab independent from globally installed OpenCode plugins while retaining
    // credentials in the normal data directory. Set MYOPENCODE_USE_GLOBAL_CONFIG=1 to opt in.
    const configHome = join(this.workspace, ".myopencode", "config");
    if (process.env.MYOPENCODE_USE_GLOBAL_CONFIG !== "1") mkdirSync(configHome, { recursive: true });
    const proc = spawn(this.binary, ["acp"], {
      cwd: this.workspace,
      env: {
        ...pythonEnvironment(this.workspace),
        ...(process.env.MYOPENCODE_USE_GLOBAL_CONFIG === "1" ? {} : { XDG_CONFIG_HOME: configHome }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;
    const startupError = new Promise<never>((_resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`OpenCode 在初始化前退出，退出码 ${code ?? "未知"}`)));
    });
    proc.stderr?.on("data", (chunk: Buffer) => this.emit("diagnostic", String(chunk).trim()));
    proc.on("exit", (code, signal) => {
      this.connection = null;
      this.process = null;
      this.sessionId = null;
      this.busy = false;
      this.messages = [];
      this.configOptions = [];
      this.planEntries = [];
      this.cancelPendingPermissions();
      this.emit("connection", { connected: false, code, signal });
      this.emit("session_reset", { sessionId: null });
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: async (params) => {
          const requestId = `permission-${++this.sequence}`;
          const options = params.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind,
          }));
          const outcome = await new Promise<acp.RequestPermissionOutcome>((resolveOutcome) => {
            const timer = setTimeout(() => {
              this.pending.delete(requestId);
              resolveOutcome({ outcome: "cancelled" });
              this.emit("permission_expired", { requestId });
            }, 60_000);
            this.pending.set(requestId, { options, resolve: resolveOutcome, timer });
            this.emit("permission", { requestId, toolCall: params.toolCall, options });
          });
          return { outcome };
        },
        unstable_createElicitation: async (params) => {
          if (params.mode !== "form" || !("requestedSchema" in params)) return { action: "decline" };
          const requestId = `question-${++this.sequence}`;
          const outcome = await new Promise<acp.CreateElicitationResponse>((resolveOutcome) => {
            const timer = setTimeout(() => {
              this.pendingQuestions.delete(requestId);
              resolveOutcome({ action: "cancel" });
              this.emit("question_expired", { requestId });
            }, 120_000);
            this.pendingQuestions.set(requestId, { message: params.message, schema: params.requestedSchema, resolve: resolveOutcome, timer });
            this.emit("question", { requestId, message: params.message, schema: params.requestedSchema });
          });
          return outcome;
        },
        sessionUpdate: async (params) => this.receiveUpdate(params),
        readTextFile: async () => { throw new Error("Client file reads are disabled in this lab"); },
        writeTextFile: async () => { throw new Error("Client file writes are disabled in this lab"); },
      }),
      stream,
    );
    try {
      const result = await Promise.race([
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "RealCode", version: "0.1.0" },
          clientCapabilities: { elicitation: { form: {} } },
        }),
        startupError,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("OpenCode ACP 初始化超时（20 秒）")), 20_000)),
      ]);
      this.connection = connection;
      this.supportsImages = result.agentCapabilities?.promptCapabilities?.image === true;
      this.emit("connection", { connected: true, protocolVersion: result.protocolVersion, capabilities: result.agentCapabilities });
      return this.status();
    } catch (error) {
      proc.kill();
      this.process = null;
      throw error;
    }
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) throw new Error("请先连接 RealCode");
    return this.connection;
  }

  private mcpServers(): acp.McpServer[] {
    if (!this.browserMcp) return [];
    return [{
      name: "realcode-browser",
      command: this.browserMcp.command,
      args: this.browserMcp.args,
      env: Object.entries(this.browserMcp.env).map(([name, value]) => ({ name, value })),
    }];
  }

  async newSession() {
    const result = await this.requireConnection().newSession({ cwd: this.workspace, mcpServers: this.mcpServers() });
    this.sessionId = result.sessionId;
    this.configOptions = result.configOptions ?? [];
    this.messages = [];
    this.messageSequence = 0;
    this.planEntries = [];
    this.lastUsage = null;
    this.emit("session", { action: "new", sessionId: result.sessionId, result });
    return result;
  }

  async listSessions() {
    const result = await this.requireConnection().listSessions({ cwd: this.workspace });
    return { ...result, sessions: result.sessions.map((session) => ({ ...session, title: this.sessionTitles.get(session.sessionId) ?? session.title })) };
  }

  renameSession(sessionId: string, title: string) {
    if (!sessionId.trim() || !title.trim()) throw new Error("会话 ID 和标题不能为空");
    this.sessionTitles.set(sessionId, title.trim());
    this.saveSessionTitles();
    return { ok: true };
  }

  private saveSessionTitles() {
    const directory = join(this.workspace, ".myopencode");
    mkdirSync(directory, { recursive: true });
    const target = join(directory, "session-titles.json");
    const pending = `${target}.tmp`;
    writeFileSync(pending, JSON.stringify(Object.fromEntries(this.sessionTitles), null, 2), "utf8");
    renameSync(pending, target);
  }

  async loadSession(sessionId: string) {
    if (!sessionId.trim()) throw new Error("缺少会话 ID");
    this.emit("session_reset", { sessionId });
    this.sessionId = sessionId;
    this.messages = [];
    this.messageSequence = 0;
    this.planEntries = [];
    this.lastUsage = null;
    const result = await this.requireConnection().loadSession({ sessionId, cwd: this.workspace, mcpServers: this.mcpServers() });
    this.sessionId = sessionId;
    this.configOptions = result.configOptions ?? [];
    this.emit("session", { action: "load", sessionId, result });
    return result;
  }

  async prompt(text: string, images: Array<{ data: string; mimeType: string }> = []) {
    if (!this.sessionId) throw new Error("请先新建或载入会话");
    if (!text.trim() && images.length === 0) throw new Error("消息不能为空");
    if (this.busy) throw new Error("当前会话仍在响应");
    if (images.length && !this.imageAllowed()) throw new Error("当前模型不支持图片输入");
    for (const image of images) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length > 7_000_000) {
        throw new Error("图片格式无效或超过 5 MB");
      }
    }
    this.busy = true;
    this.messageSequence++;
    this.messages.push({ id: `user-${this.messageSequence}`, role: "user", text, ...(images.length ? { images } : {}) });
    this.emit("user_message", { sessionId: this.sessionId, text });
    try {
      const result = await this.requireConnection().prompt({
        sessionId: this.sessionId,
        prompt: [...(text.trim() ? [{ type: "text" as const, text }] : []), ...images.map((image) => ({ type: "image" as const, ...image }))],
      });
      this.lastUsage = result.usage ?? null;
      this.emit("prompt_complete", result);
      return result;
    } finally {
      this.busy = false;
      this.emit("idle", {});
    }
  }

  async cancel() {
    if (!this.sessionId) return;
    await this.requireConnection().cancel({ sessionId: this.sessionId });
    this.emit("cancel", { sessionId: this.sessionId });
  }

  async setConfigOption(configId: string, value: string) {
    if (!this.sessionId) throw new Error("请先新建或载入会话");
    const result = await this.requireConnection().setSessionConfigOption({ sessionId: this.sessionId, configId, value });
    this.configOptions = result.configOptions;
    this.emit("configuration", { sessionId: this.sessionId, configOptions: this.configOptions });
    return result;
  }

  async deleteSession(sessionId: string) {
    if (!sessionId.trim()) throw new Error("缺少会话 ID");
    try {
      await this.requireConnection().deleteSession({ sessionId });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Method not found")) throw error;
      const configHome = join(this.workspace, ".myopencode", "config");
      await execFileAsync(this.binary, ["session", "delete", sessionId], {
        cwd: this.workspace,
        env: { ...pythonEnvironment(this.workspace), ...(process.env.MYOPENCODE_USE_GLOBAL_CONFIG === "1" ? {} : { XDG_CONFIG_HOME: configHome }) },
        timeout: 20_000,
      });
    }
    if (this.sessionTitles.delete(sessionId)) this.saveSessionTitles();
    if (this.sessionId === sessionId) {
      this.sessionId = null;
      this.messages = [];
      this.configOptions = [];
      this.emit("session_reset", { sessionId: null });
    }
    return { ok: true };
  }

  answerPermission(requestId: string, optionId?: string) {
    const item = this.pending.get(requestId);
    if (!item) throw new Error("权限请求已过期");
    if (optionId && !item.options.some((option) => option.optionId === optionId)) throw new Error("无效的权限选项");
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    item.resolve(optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" });
    this.emit("permission_answered", { requestId, optionId: optionId ?? null });
  }

  answerQuestion(requestId: string, content?: Record<string, string | number | boolean | string[]>) {
    const item = this.pendingQuestions.get(requestId);
    if (!item) throw new Error("问题请求已过期");
    clearTimeout(item.timer);
    this.pendingQuestions.delete(requestId);
    item.resolve(content ? { action: "accept", content } : { action: "decline" });
    this.emit("question_answered", { requestId });
  }

  private cancelPendingPermissions() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ outcome: "cancelled" });
    }
    this.pending.clear();
    for (const item of this.pendingQuestions.values()) {
      clearTimeout(item.timer);
      item.resolve({ action: "cancel" });
    }
    this.pendingQuestions.clear();
  }

  close() {
    this.cancelPendingPermissions();
    this.process?.kill();
    this.connection = null;
    this.process = null;
  }
}
