import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pythonEnvironment } from "./python-env";

test("OpenCode uses the workspace Python before the inherited Python", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "myopencode-python-"));
  const bin = join(workspace, ".venv", process.platform === "win32" ? "Scripts" : "bin");
  try {
    const original = pythonEnvironment(workspace, { Path: "other-python", PYTHONHOME: "old-home" });
    expect(original.Path).toBe("other-python");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === "win32" ? "python.exe" : "python"), "");
    const configured = pythonEnvironment(workspace, { Path: "other-python", PYTHONHOME: "old-home" });
    expect(configured.Path).toBe(`${bin}${delimiter}other-python`);
    expect(configured.VIRTUAL_ENV).toBe(join(workspace, ".venv"));
    expect(configured.PYTHONHOME).toBeUndefined();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
