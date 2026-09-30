import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface ResourceEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

function visibleName(name: string): boolean {
  return !!name && !name.startsWith(".") && !/[\\/<>:"|?*\x00-\x1f]/.test(name) && name !== "..";
}

function segments(path: string): string[] {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) throw new Error("资源路径无效");
  const parts = path ? path.split("/") : [];
  if (parts.some((part) => !visibleName(part))) throw new Error("资源路径无效");
  return parts;
}

async function rootPath(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  return realpath(workspace);
}

function inside(root: string, target: string): boolean {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? target.toLowerCase() : target;
  return b === a || b.startsWith(`${a}${sep}`);
}

async function existing(workspace: string, path: string): Promise<{ root: string; target: string }> {
  const parts = segments(path);
  if (!parts.length) throw new Error("请选择工作区内的资源");
  const root = await rootPath(workspace);
  const candidate = resolve(root, ...parts);
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error("不支持符号链接");
  const target = await realpath(candidate);
  if (!inside(root, target)) throw new Error("资源不在工作区内");
  return { root, target };
}

async function child(workspace: string, path: string): Promise<string> {
  const parts = segments(path);
  if (!parts.length) throw new Error("资源名称不能为空");
  const root = await rootPath(workspace);
  const parent = parts.length === 1 ? root : (await existing(workspace, parts.slice(0, -1).join("/"))).target;
  if (!(await lstat(parent)).isDirectory()) throw new Error("目标目录不存在");
  const target = join(parent, parts.at(-1)!);
  if (!inside(root, target)) throw new Error("资源不在工作区内");
  return target;
}

/** A bounded file tree similar to FenixAgent's fs/tree response. Hidden config files stay private. */
export async function listResources(workspace: string): Promise<ResourceEntry[]> {
  const root = await rootPath(workspace);
  const entries: ResourceEntry[] = [];
  async function scan(directory: string, depth: number): Promise<void> {
    if (depth > 12 || entries.length >= 2500) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"));
    for (const item of children) {
      if (entries.length >= 2500) break;
      if (!visibleName(item.name) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
      const target = join(directory, item.name);
      const info = await lstat(target);
      const path = relative(root, target).split(sep).join("/");
      entries.push({ path, name: item.name, isDir: item.isDirectory(), size: info.size, mtime: info.mtimeMs });
      if (item.isDirectory()) await scan(target, depth + 1);
    }
  }
  await scan(root, 0);
  return entries;
}

export async function resourceFile(workspace: string, path: string): Promise<{ target: string; size: number }> {
  const { target } = await existing(workspace, path);
  const info = await lstat(target);
  if (!info.isFile() || info.size > 20_000_000) throw new Error("仅可打开 20 MB 以内的文件");
  return { target, size: info.size };
}

export async function writeResource(workspace: string, path: string, content: string): Promise<void> {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 1_000_000) throw new Error("仅可保存 1 MB 以内的文本文件");
  const { target } = await existing(workspace, path);
  const info = await lstat(target);
  if (!info.isFile()) throw new Error("仅可编辑工作区文件");
  await writeFile(target, content, "utf8");
}
export async function createResource(workspace: string, path: string, isDir: boolean): Promise<void> {
  const target = await child(workspace, path);
  if (isDir) await mkdir(target);
  else await writeFile(target, "", { flag: "wx" });
}

export async function renameResource(workspace: string, path: string, name: string): Promise<void> {
  if (!visibleName(name)) throw new Error("新名称无效");
  const { target } = await existing(workspace, path);
  const destination = await child(workspace, [...segments(path).slice(0, -1), name].join("/"));
  if (destination === target) return;
  try { await lstat(destination); throw new Error("同名资源已存在"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(target, destination);
}

export async function deleteResource(workspace: string, path: string): Promise<void> {
  const { root, target } = await existing(workspace, path);
  if (target === root) throw new Error("不能删除工作区");
  await rm(target, { recursive: true });
}

export async function uploadResource(workspace: string, directory: string, name: string, encoded: string): Promise<string> {
  if (!visibleName(name) || name.length > 100) throw new Error("文件名无效");
  if (!encoded || encoded.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("文件无效或超过 10 MB");
  const parent = directory ? (await existing(workspace, directory)).target : await rootPath(workspace);
  if (!(await lstat(parent)).isDirectory()) throw new Error("目标目录不存在");
  const root = await rootPath(workspace);
  let target = join(parent, name);
  for (let index = 1; index < 100; index++) {
    if (!inside(root, target)) throw new Error("资源不在工作区内");
    try {
      await writeFile(target, Buffer.from(encoded, "base64"), { flag: "wx" });
      return relative(root, target).split(sep).join("/");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const dot = name.lastIndexOf(".");
      target = join(parent, dot > 0 ? `${name.slice(0, dot)}-${index}${name.slice(dot)}` : `${name}-${index}`);
    }
  }
  throw new Error("同名文件过多");
}

export function resourceDownloadName(path: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
}
