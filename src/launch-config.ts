import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { installSkills, type SkillSource } from "./skill-installer";

interface LaunchConfig {
  model: {
    provider: string;
    model: string;
    modelName?: string;
    protocol: "anthropic" | "openai-compatible";
    baseUrl: string;
    apiKeyEnv: string;
  };
  agent: { name: string; prompt?: string; steps?: number };
  mcpServers?: Array<
    | { name: string; type: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeout?: number }
    | { name: string; type: "remote"; url: string; headers?: Record<string, string>; timeout?: number }
  >;
  skills?: SkillSource[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`launch.json: ${field} 必须是非空字符串`);
  return value;
}

/** Select the Codex model without copying Codex's private login tokens into this workspace. */
export async function prepareDefaultModelConfig(workspace: string): Promise<boolean> {
  const target = join(workspace, ".opencode", "opencode.json");
  await mkdir(dirname(target), { recursive: true });
  const model = process.env.MYOPENCODE_DEFAULT_MODEL ?? "openai/gpt-5.6-sol";
  if (!/^[-\w.]+\/[-\w.]+$/.test(model)) throw new Error("MYOPENCODE_DEFAULT_MODEL 格式应为 provider/model");
  try {
    await writeFile(target, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Convert the platform-style launch fields from FenixAgent into an OpenCode workspace config. */
export async function prepareLaunchConfig(workspace: string): Promise<boolean> {
  const path = resolve(process.env.MYOPENCODE_LAUNCH_CONFIG ?? resolve(import.meta.dir, "../launch.json"));
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!record(parsed) || !record(parsed.model) || !record(parsed.agent)) throw new Error("launch.json: 缺少 model 或 agent");
  const launch = parsed as unknown as LaunchConfig;
  const providerId = requiredString(launch.model.provider, "model.provider");
  const modelName = requiredString(launch.model.model, "model.model");
  const modelId = requiredString(launch.model.modelName ?? launch.model.model, "model.model");
  const agentName = requiredString(launch.agent.name, "agent.name");
  if (launch.model.protocol !== "anthropic" && launch.model.protocol !== "openai-compatible") throw new Error("launch.json: model.protocol 无效");
  if (launch.agent.steps !== undefined && (!Number.isInteger(launch.agent.steps) || launch.agent.steps < 1)) throw new Error("launch.json: agent.steps 必须是正整数");
  if (launch.mcpServers !== undefined && !Array.isArray(launch.mcpServers)) throw new Error("launch.json: mcpServers 必须是数组");
  if (launch.skills !== undefined && !Array.isArray(launch.skills)) throw new Error("launch.json: skills 必须是数组");
  for (const server of launch.mcpServers ?? []) {
    requiredString(server.name, "mcpServers.name");
    if (server.type === "stdio") requiredString(server.command, `mcpServers.${server.name}.command`);
    else if (server.type === "remote") requiredString(server.url, `mcpServers.${server.name}.url`);
    else throw new Error("launch.json: MCP 类型无效");
  }
  const apiKeyEnv = requiredString(launch.model.apiKeyEnv, "model.apiKeyEnv");
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`launch.json: 环境变量 ${apiKeyEnv} 未设置`);
  const providerModel = `${providerId}/${modelId}`;
  const mcp = Object.fromEntries((launch.mcpServers ?? []).map((item) => [
    item.name,
    item.type === "stdio"
      ? { type: "local", command: [item.command, ...(item.args ?? [])], cwd: item.cwd, environment: item.env, timeout: item.timeout }
      : { type: "remote", url: item.url, headers: item.headers, timeout: item.timeout },
  ]));
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    default_agent: agentName,
    enabled_providers: [providerId],
    provider: {
      [providerId]: {
        npm: launch.model.protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        options: { baseURL: requiredString(launch.model.baseUrl, "model.baseUrl"), apiKey, setCacheKey: true },
        models: { [modelId]: { name: modelName } },
      },
    },
    model: providerModel,
    agent: { [agentName]: { model: providerModel, mode: "primary", steps: launch.agent.steps ?? 1000, ...(launch.agent.prompt ? { prompt: launch.agent.prompt } : {}), hidden: false, disable: false } },
    mcp,
  };
  const target = join(workspace, ".opencode", "opencode.json");
  await mkdir(dirname(target), { recursive: true });
  if (launch.skills) await installSkills(workspace, launch.skills);
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return true;
}
