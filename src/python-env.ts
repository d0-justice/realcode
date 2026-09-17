import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Put the workspace virtual environment first for OpenCode and its tools. */
export function pythonEnvironment(workspace: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  const virtualEnv = join(workspace, ".venv");
  const bin = join(virtualEnv, process.platform === "win32" ? "Scripts" : "bin");
  const executable = join(bin, process.platform === "win32" ? "python.exe" : "python");
  if (!existsSync(executable)) return environment;

  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  environment[pathKey] = [bin, environment[pathKey]].filter(Boolean).join(delimiter);
  environment.VIRTUAL_ENV = virtualEnv;
  delete environment.PYTHONHOME;
  return environment;
}
