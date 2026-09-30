import { createInterface } from "node:readline";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = requiredEnvironment("REALCODE_BROWSER_API");
const secret = requiredEnvironment("REALCODE_BROWSER_SECRET");
const toolsUrl = process.env.REALCODE_BROWSER_TOOLS_API ?? apiUrl.replace(/\/command$/, "/tools");
const eventsUrl = process.env.REALCODE_BROWSER_TOOLS_EVENTS ?? apiUrl.replace(/\/command$/, "/tools/events");

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const frame = { type: "string", minLength: 1, description: "页面特征观察返回的 frameId；顶层控制面可省略" };
const tools: Tool[] = [
  {
    name: "browser_observe",
    description: "当前页面没有适用的 WebMCP 工具时，读取页面特征、可见文本和动态操作空间，不截屏。优先观察展开预览 iframe；未展开或站点拒绝嵌入时返回新标签页回退地址。返回的 fingerprint 与 actionId 必须一起交给 browser_act。",
    inputSchema: { type: "object", properties: { frameId: frame, maxActions: { type: "integer", minimum: 1, maximum: 500 }, maxTextLength: { type: "integer", minimum: 0, maximum: 50000 }, includeStructure: { type: "boolean", description: "需要查看 accessibility 树时设为 true；默认不生成快照" } }, additionalProperties: false },
  },
  {
    name: "browser_act",
    description: "页面没有适用的 WebMCP 工具时，执行 browser_observe 返回的一项操作。传入该次观察的 fingerprint、actionId 和 frameId。执行前检查目标身份和遮挡；executed 仅表示输入已发送，须检查返回内容确认业务结果。点击链接会返回 needsObservation=true，必须再次观察导航后的页面。若用户要求在会话中可见地浏览网页，不能用 webfetch 代替浏览器操作；浏览器失败时应如实报告。",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", pattern: "^e[1-9][0-9]*$", description: "browser_observe 返回的操作 ID" },
        fingerprint: { type: "string", minLength: 1, description: "与 actionId 同次返回的页面指纹" },
        frameId: frame,
        text: { type: "string", description: "fill 操作要填写的文本；其他操作省略" },
      },
      required: ["actionId", "fingerprint"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "仅在用户明确需要视觉诊断时截取当前可见区域。常规状态识别必须使用 browser_observe。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open_tab",
    description: "仅当 browser_observe 返回 controlMode=new-tab-fallback 时，使用该次观察返回的 fallbackUrl 在受控 Chrome 的顶层标签页打开。站点拒绝 iframe 嵌入时也可使用。",
    inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false },
  },
];

const methodByTool: Record<string, string> = {
  browser_observe: "browser.observe",
  browser_act: "browser.act",
  browser_screenshot: "browser.screenshot",
  browser_open_tab: "browser.openTab",
};

let initialized = false;
let eventsAbort: AbortController | undefined;
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

function notifyToolsChanged(): void {
  if (!initialized) return;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 250);
}

async function watchTools(): Promise<void> {
  eventsAbort = new AbortController();
  while (!eventsAbort.signal.aborted) {
    try {
      const response = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${secret}` }, signal: eventsAbort.signal });
      if (!response.ok || !response.body) throw new Error(`Tool event stream returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      let buffer = "";
      while (!eventsAbort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (lines.some(line => line.startsWith("data:"))) notifyToolsChanged();
      }
    } catch (error) {
      if (!eventsAbort.signal.aborted) console.error("[realcode-browser-mcp] tool event stream:", error instanceof Error ? error.message : String(error));
    }
    if (!eventsAbort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function listTools(): Promise<Tool[]> {
  try {
    const response = await fetch(toolsUrl, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`Tool list returned HTTP ${response.status}`);
    const payload = await response.json() as { tools?: Tool[] };
    const dynamic = Array.isArray(payload.tools) ? payload.tools.filter(tool =>
      typeof tool.name === "string" && tool.name.length > 0 && !Object.hasOwn(methodByTool, tool.name) &&
      typeof tool.description === "string" && tool.inputSchema?.type === "object") : [];
    return dynamic.length ? dynamic : tools;
  } catch (error) {
    console.error("[realcode-browser-mcp] tool list:", error instanceof Error ? error.message : String(error));
    return tools;
  }
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callBrowser(name: string, args: unknown): Promise<unknown> {
  const method = methodByTool[name] ?? "browser.site";
  if (!methodByTool[name] && !(await listTools()).some(tool => tool.name === name)) throw new Error(`当前页面没有工具：${name}`);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ method, args: method === "browser.site"
      ? { operation: "call", name, args: args && typeof args === "object" ? args : {} }
      : args && typeof args === "object" ? args : {} }),
    signal: AbortSignal.timeout(name === "realcode.bilibili.searchAndPlay" ? 50_000 : 20_000),
  });
  const payload = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error || `RealCode browser returned HTTP ${response.status}`);
  return payload.result;
}

async function handle(request: Record<string, unknown>): Promise<void> {
  if (!("id" in request)) return;
  const id = request.id;
  try {
    let result: unknown;
    if (request.method === "initialize") {
      const params = request.params as { protocolVersion?: string } | undefined;
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "realcode-browser", version: "0.4.0" },
      };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools: await listTools() };
    } else if (request.method === "tools/call") {
      const params = request.params as { name?: string; arguments?: unknown } | undefined;
      const toolName = String(params?.name ?? "");
      const value = await callBrowser(toolName, params?.arguments);
      const screenshot = toolName === "browser_screenshot" && value && typeof value === "object"
        ? (value as { dataUrl?: unknown }).dataUrl
        : undefined;
      if (typeof screenshot === "string" && /^data:image\/[-\w.+]+;base64,/.test(screenshot)) {
        const separator = screenshot.indexOf(",");
        const mimeType = screenshot.slice(5, screenshot.indexOf(";"));
        result = {
          content: [{ type: "image", data: screenshot.slice(separator + 1), mimeType }],
          structuredContent: { captured: true },
        };
      } else {
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value && typeof value === "object" ? value : { value },
        };
      }
    } else {
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } });
      return;
    }
    write({ jsonrpc: "2.0", id, result });
    if (request.method === "initialize" && !initialized) { initialized = true; void watchTools(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.method === "tools/call") {
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
    } else {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
    }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const request = JSON.parse(line) as Record<string, unknown>;
    await handle(request);
  } catch (error) {
    console.error("[realcode-browser-mcp]", error instanceof Error ? error.message : String(error));
  }
}
eventsAbort?.abort();
clearTimeout(notificationTimer);
