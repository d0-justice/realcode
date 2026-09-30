import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("browser MCP server", () => {
  // 验证 Agent 工具面只暴露特征观察、受保护操作、新标签页回退和显式诊断截图。
  test("lists the compact feature based tools", async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "mcp-server.ts")], {
      env: {
        ...Bun.env,
        REALCODE_BROWSER_API: "http://127.0.0.1:1/api/browser/command",
        REALCODE_BROWSER_SECRET: "test-secret",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const response = JSON.parse(output.trim()) as { result: { tools: Array<{ name: string }> } };
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      "browser_observe",
      "browser_act",
      "browser_screenshot",
      "browser_open_tab",
    ]);
  });

  test("exposes page tools by their WebMCP names and calls the matching page tool", async () => {
    const calls: unknown[] = [];
    const api = Bun.serve({ port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (request.headers.get("authorization") !== "Bearer test-secret") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path === "/api/browser/tools") return Response.json({ tools: [{
        name: "realcode.bilibili.searchVideos", description: "搜索视频",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }] });
      if (path === "/api/browser/command") {
        calls.push(await request.json());
        return Response.json({ result: { status: "navigation_started" } });
      }
      return new Response(null, { status: 404 });
    } });
    try {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "mcp-server.ts")], {
        env: { ...Bun.env, REALCODE_BROWSER_API: `http://127.0.0.1:${api.port}/api/browser/command`, REALCODE_BROWSER_SECRET: "test-secret" },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "realcode.bilibili.searchVideos", arguments: { query: "亚索" } } })}\n`);
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      const [listing, invocation] = output.trim().split("\n").map(line => JSON.parse(line));
      expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["realcode.bilibili.searchVideos"]);
      expect(listing.result.tools.at(-1)).toEqual({ name: "realcode.bilibili.searchVideos", description: "搜索视频",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } });
      expect(invocation.result.structuredContent).toEqual({ status: "navigation_started" });
      expect(calls).toEqual([{ method: "browser.site", args: { operation: "call", name: "realcode.bilibili.searchVideos", args: { query: "亚索" } } }]);
    } finally { api.stop(true); }
  });

  test("notifies OpenCode when the page tool list changes", async () => {
    let events: ReadableStreamDefaultController<Uint8Array> | undefined;
    const api = Bun.serve({ port: 0, fetch: request => {
      if (new URL(request.url).pathname === "/api/browser/tools/events") return new Response(new ReadableStream<Uint8Array>({
        start(controller) { events = controller; },
      }), { headers: { "Content-Type": "text/event-stream" } });
      return Response.json({ tools: [] });
    } });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "mcp-server.ts")], {
      env: { ...Bun.env, REALCODE_BROWSER_API: `http://127.0.0.1:${api.port}/api/browser/command`, REALCODE_BROWSER_SECRET: "test-secret" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
      for (let attempt = 0; !events && attempt < 100; attempt++) await Bun.sleep(10);
      expect(events).toBeDefined();
      events!.enqueue(new TextEncoder().encode('data: {"type":"browser_tools_changed"}\n\n'));
      await Bun.sleep(400);
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      const messages = output.trim().split("\n").map(line => JSON.parse(line));
      expect(messages[0].result.capabilities.tools.listChanged).toBe(true);
      expect(messages[1].method).toBe("notifications/tools/list_changed");
    } finally { child.kill(); api.stop(true); }
  });
});
