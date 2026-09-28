import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installSkills } from "./skill-installer";

const execFileAsync = promisify(execFile);

// 验证 Skills 下载和暂存替换后的文件确实能在工作区被读取。
test("installs a ZIP skill into the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "myopencode-skill-"));
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const archive = join(root, "skill.zip");
  await mkdir(source);
  await mkdir(workspace);
  await writeFile(join(source, "SKILL.md"), "# Test skill\n");
  await execFileAsync("tar", ["-a", "-cf", archive, "-C", source, "SKILL.md"]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(archive)) });
  try {
    await installSkills(workspace, [{ name: "test-skill", url: `http://127.0.0.1:${server.port}/skill.zip` }]);
    expect(await readFile(join(workspace, ".opencode", "skills", "test-skill", "SKILL.md"), "utf8")).toBe("# Test skill\n");
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
