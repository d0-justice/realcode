import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDefaultModelConfig, prepareLaunchConfig } from "./launch-config";

const previousConfig = process.env.MYOPENCODE_LAUNCH_CONFIG;
const previousKey = process.env.MYOPENCODE_TEST_KEY;

afterEach(() => {
  if (previousConfig === undefined) delete process.env.MYOPENCODE_LAUNCH_CONFIG;
  else process.env.MYOPENCODE_LAUNCH_CONFIG = previousConfig;
  if (previousKey === undefined) delete process.env.MYOPENCODE_TEST_KEY;
  else process.env.MYOPENCODE_TEST_KEY = previousKey;
});

// 验证默认模型只在首次创建工作区配置时写入，保留用户自己的模型设置。
test("prepares Codex model without overwriting workspace config", async () => {
  const root = await mkdtemp(join(tmpdir(), "myopencode-default-test-"));
  try {
    expect(await prepareDefaultModelConfig(root)).toBe(true);
    const target = join(root, ".opencode", "opencode.json");
    expect(JSON.parse(await readFile(target, "utf8")).model).toBe("openai/gpt-5.6-sol");
    await writeFile(target, JSON.stringify({ model: "opencode/big-pickle" }));
    expect(await prepareDefaultModelConfig(root)).toBe(false);
    expect(JSON.parse(await readFile(target, "utf8")).model).toBe("opencode/big-pickle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 验证平台风格配置会把模型、密钥引用和两种 MCP 服务转换为 OpenCode 工作区配置。
test("prepares OpenCode workspace config from launch spec", async () => {
  const root = await mkdtemp(join(tmpdir(), "myopencode-test-"));
  try {
    const launchFile = join(root, "launch.json");
    process.env.MYOPENCODE_LAUNCH_CONFIG = launchFile;
    process.env.MYOPENCODE_TEST_KEY = "test-key";
    await writeFile(launchFile, JSON.stringify({
      model: { provider: "test", model: "sample", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9999/v1", apiKeyEnv: "MYOPENCODE_TEST_KEY" },
      agent: { name: "build", steps: 8 },
      mcpServers: [
        { name: "local", type: "stdio", command: "node", args: ["server.js"] },
        { name: "remote", type: "remote", url: "http://127.0.0.1:8000/mcp" },
        { name: "hindsight", type: "remote", url: "http://127.0.0.1:9000/mcp" },
      ],
    }));
    expect(await prepareLaunchConfig(root)).toBe(true);
    const config = JSON.parse(await readFile(join(root, ".opencode", "opencode.json"), "utf8"));
    expect(config.model).toBe("test/sample");
    expect(config.provider.test.options.apiKey).toBe("test-key");
    expect(config.agent.build.steps).toBe(8);
    expect(config.mcp.local.command).toEqual(["node", "server.js"]);
    expect(config.mcp.remote.url).toBe("http://127.0.0.1:8000/mcp");
    expect(config.mcp.hindsight.url).toBe("http://127.0.0.1:9000/mcp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
