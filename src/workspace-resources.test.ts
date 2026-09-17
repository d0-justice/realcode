import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResource, deleteResource, listResources, renameResource, resourceFile, uploadResource } from "./workspace-resources";

// 验证资源浏览器仅操作工作区内可见文件，并支持文件树、上传、重命名和删除。
test("workspace resource operations stay inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "myopencode-resources-"));
  try {
    await createResource(root, "user", true);
    await createResource(root, "user/preview.html", false);
    expect((await listResources(root)).map((item) => item.path)).toEqual(["user", "user/preview.html"]);
    await renameResource(root, "user/preview.html", "page.html");
    expect((await resourceFile(root, "user/page.html")).size).toBe(0);
    const uploaded = await uploadResource(root, "user", "note.txt", Buffer.from("hello").toString("base64"));
    expect(uploaded).toBe("user/note.txt");
    expect(await readFile(join(root, uploaded), "utf8")).toBe("hello");
    await deleteResource(root, "user/page.html");
    expect((await listResources(root)).map((item) => item.path)).toEqual(["user", "user/note.txt"]);
    await expect(createResource(root, "../outside", false)).rejects.toThrow("资源路径无效");
    await expect(deleteResource(root, ".opencode/config.json")).rejects.toThrow("资源路径无效");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
