import { createInterface } from "node:readline";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = requiredEnvironment("REALCODE_BROWSER_API");
const secret = requiredEnvironment("REALCODE_BROWSER_SECRET");

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const frame = { type: "string", minLength: 1, description: "最近一次 snapshot 返回的 CDP frameId；iframe 导航后编号会变化，应重新 snapshot；顶层页面可省略" };
const selector = { type: "string", minLength: 1, description: "snapshot 返回的 CSS selector" };
const tools: Tool[] = [
  {
    name: "browser_snapshot",
    description: "读取浏览器控制目标。RealCode 页面存在‘展开预览’悬浮窗口时，只返回该窗口中的 iframe，并标记 controlMode=floating-preview；没有悬浮窗口时返回 controlMode=new-tab-fallback 和 fallbackUrl，此时才可调用 browser_open_tab。一次失败不能据此判断 iframe 被阻止。frameId 仅对当前文档有效。",
    inputSchema: { type: "object", properties: { frameId: frame, maxElements: { type: "integer", minimum: 1, maximum: 500 }, maxTextLength: { type: "integer", minimum: 0, maximum: 50000 } }, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: "点击 snapshot 返回的页面或 iframe 元素。",
    inputSchema: { type: "object", properties: { selector, frameId: frame }, required: ["selector"], additionalProperties: false },
  },
  {
    name: "browser_fill",
    description: "填写 snapshot 返回的 input 或 textarea。不会读取密码框内容。",
    inputSchema: { type: "object", properties: { selector, value: { type: "string" }, frameId: frame }, required: ["selector", "value"], additionalProperties: false },
  },
  {
    name: "browser_select",
    description: "按 option value 选择 snapshot 返回的下拉框。",
    inputSchema: { type: "object", properties: { selector, value: { type: "string" }, frameId: frame }, required: ["selector", "value"], additionalProperties: false },
  },
  {
    name: "browser_scroll",
    description: "滚动所选标签页或指定 iframe。",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, frameId: frame }, additionalProperties: false },
  },
  {
    name: "browser_screenshot",
    description: "截取所选标签页当前可见区域。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open_tab",
    description: "仅当 browser_snapshot 返回 controlMode=new-tab-fallback 时，使用同一次快照返回的 fallbackUrl 打开新标签页。存在展开预览悬浮窗口时禁止调用。",
    inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_wait",
    description: "等待页面异步更新，最长 30 秒。",
    inputSchema: { type: "object", properties: { milliseconds: { type: "integer", minimum: 0, maximum: 30000 } }, required: ["milliseconds"], additionalProperties: false },
  },
];

const methodByTool: Record<string, string> = {
  browser_snapshot: "browser.snapshot",
  browser_click: "browser.click",
  browser_fill: "browser.fill",
  browser_select: "browser.select",
  browser_scroll: "browser.scroll",
  browser_screenshot: "browser.screenshot",
  browser_open_tab: "browser.openTab",
  browser_wait: "browser.wait",
};

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callBrowser(name: string, args: unknown): Promise<unknown> {
  const method = methodByTool[name];
  if (!method) throw new Error(`Unknown browser tool: ${name}`);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ method, args: args && typeof args === "object" ? args : {} }),
    signal: AbortSignal.timeout(125_000),
  });
  const payload = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error || `RealCode browser bridge returned HTTP ${response.status}`);
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
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "realcode-browser", version: "0.3.0" },
      };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools };
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
