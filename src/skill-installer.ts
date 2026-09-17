import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SkillSource { name: string; url: string }

function safeName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) && name !== "." && name !== "..";
}

function checkArchiveEntries(entries: string, targetDir: string): void {
  const root = resolve(targetDir) + sep;
  for (const raw of entries.split(/\r?\n/).filter(Boolean)) {
    const path = raw.replaceAll("\\", "/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
      throw new Error(`Skill 归档包含不安全路径: ${raw}`);
    }
    if (!resolve(targetDir, path).startsWith(root) && resolve(targetDir, path) !== resolve(targetDir)) {
      throw new Error(`Skill 归档路径越界: ${raw}`);
    }
  }
}

/** Stage all skill archives, then swap the complete skills directory into place. */
export async function installSkills(workspace: string, skills: SkillSource[]): Promise<void> {
  const skillsDir = join(workspace, ".opencode", "skills");
  await mkdir(skillsDir, { recursive: true });
  const stagingRoot = await mkdtemp(join(dirname(skillsDir), ".skills-stage-"));
  const staged = join(stagingRoot, "skills");
  await mkdir(staged);
  try {
    for (const skill of skills) {
      if (!safeName(skill.name)) throw new Error(`无效的 Skill 名称: ${skill.name}`);
      const source = new URL(skill.url);
      if (source.protocol !== "https:" && source.protocol !== "http:") throw new Error(`Skill URL 必须是 HTTP(S): ${skill.name}`);
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`下载 Skill ${skill.name} 失败: HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get("content-length") ?? 0);
      if (declaredSize > 50 * 1024 * 1024) throw new Error(`Skill 归档过大: ${skill.name}`);
      const archive = join(stagingRoot, `${skill.name}.zip`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 50 * 1024 * 1024) throw new Error(`Skill 归档过大: ${skill.name}`);
      await writeFile(archive, bytes);
      const target = join(staged, skill.name);
      await mkdir(target);
      const { stdout } = await execFileAsync("tar", ["-tf", archive]);
      checkArchiveEntries(stdout, target);
      const { stdout: detailed } = await execFileAsync("tar", ["-tvf", archive]);
      if (detailed.split(/\r?\n/).some((line) => /^[lh]/.test(line) || line.includes(" -> "))) {
        throw new Error(`Skill 归档包含链接: ${skill.name}`);
      }
      await execFileAsync("tar", ["-xf", archive, "-C", target]);
    }
    const backup = `${skillsDir}.backup-${randomUUID()}`;
    await rename(skillsDir, backup);
    try {
      await rename(staged, skillsDir);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(skillsDir, { recursive: true, force: true });
      await rename(backup, skillsDir);
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
