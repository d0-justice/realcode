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
});
