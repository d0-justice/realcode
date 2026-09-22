import { resolve, sep } from "node:path";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { AcpSessionLab } from "./acp-session";
import { BrowserBridge, isBrowserMethod } from "./browser-bridge";
import { createResource, deleteResource, listResources, renameResource, resourceDownloadName, resourceFile, uploadResource } from "./workspace-resources";

const port = Number(process.env.MYOPENCODE_PORT ?? 4173);
const workspace = process.env.MYOPENCODE_WORKSPACE ?? resolve(import.meta.dir, "../workspace");
const browserBridge = new BrowserBridge();
const lab = new AcpSessionLab(workspace, {
  browserMcp: {
    command: process.execPath,
    args: [resolve(import.meta.dir, "browser-mcp-server.ts")],
    env: {
      REALCODE_BROWSER_API: `http://127.0.0.1:${port}/api/browser/command`,
      REALCODE_BROWSER_SECRET: browserBridge.internalSecret,
    },
  },
});
const publicDir = resolve(import.meta.dir, "../public");
const clientBuild = await Bun.build({ entrypoints: [resolve(publicDir, "app.js")], target: "browser", minify: false });
if (!clientBuild.success) throw new Error(`浏览器脚本构建失败：${clientBuild.logs.join("; ")}`);
const clientScript = await clientBuild.outputs[0]!.text();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

const server = Bun.serve<{ kind: "extension" }>({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/browser-extension") {
        const origin = request.headers.get("origin");
        if (origin && !origin.startsWith("chrome-extension://")) return json({ error: "仅允许 Chrome 扩展连接" }, 403);
        if (bunServer.upgrade(request, { data: { kind: "extension" } })) return;
        return json({ error: "WebSocket 升级失败" }, 400);
      }
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "仅允许本页面发起请求" }, 403);
      if (request.method === "GET" && url.pathname === "/api/status") return json({ ...lab.status(), browser: browserBridge.status() });
      if (request.method === "GET" && url.pathname === "/api/browser/status") return json(browserBridge.status());
      if (request.method === "GET" && url.pathname === "/api/browser/pairing") return json(browserBridge.pairing());
      if (request.method === "POST" && url.pathname === "/api/browser/rotate-token") return json(browserBridge.rotatePairingToken());
      if (request.method === "POST" && url.pathname === "/api/browser/command") {
        if (request.headers.get("authorization") !== `Bearer ${browserBridge.internalSecret}`) return json({ error: "浏览器工具认证失败" }, 401);
        const data = await body(request);
        if (!isBrowserMethod(data.method)) return json({ error: "浏览器工具无效" }, 400);
        const args = data.args && typeof data.args === "object" && !Array.isArray(data.args) ? data.args as Record<string, unknown> : {};
        return json({ result: await browserBridge.command(data.method, args, 60_000) });
      }
      if (request.method === "GET" && url.pathname === "/api/session/messages") return json(lab.messageSnapshot());
      if (request.method === "GET" && url.pathname === "/api/workspace/resources") return json({ entries: await listResources(workspace) });
      if (request.method === "GET" && url.pathname === "/api/workspace/raw") {
        const path = url.searchParams.get("path") ?? "";
        const { target } = await resourceFile(workspace, path);
        const download = url.searchParams.get("download") === "1";
        return new Response(Bun.file(target), { headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(download ? { "Content-Disposition": resourceDownloadName(path) } : { "Content-Security-Policy": "sandbox allow-scripts allow-forms" }),
        } });
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/create") {
        const data = await body(request);
        await createResource(workspace, String(data.path ?? ""), data.isDir === true);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/rename") {
        const data = await body(request);
        await renameResource(workspace, String(data.path ?? ""), String(data.name ?? ""));
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/delete") {
        const data = await body(request);
        await deleteResource(workspace, String(data.path ?? ""));
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/upload") {
        const data = await body(request);
        return json({ path: await uploadResource(workspace, String(data.directory ?? ""), String(data.name ?? ""), String(data.data ?? "")) });
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        const requested = url.searchParams.get("path") ?? "";
        const base = await realpath(workspace);
        const target = await realpath(resolve(workspace, requested));
        const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
        const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
        if (!normalizedTarget.startsWith(`${normalizedBase}${sep}`)) return json({ error: "文件不在工作区内" }, 403);
        const info = await stat(target);
        if (!info.isFile() || info.size > 512_000) return json({ error: "仅可预览 500 KB 以内的文件" }, 400);
        const content = await readFile(target, "utf8");
        return json({ path: requested, content });
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            send({ type: "status", at: new Date().toISOString(), data: { ...lab.status(), browser: browserBridge.status() } });
            unsubscribe = lab.subscribe(send);
            const unsubscribeBrowser = browserBridge.subscribe(send);
            const unsubscribeAll = unsubscribe;
            unsubscribe = () => { unsubscribeAll(); unsubscribeBrowser(); };
            heartbeat = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
          },
          cancel() { unsubscribe(); clearInterval(heartbeat); },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }
      if (request.method === "POST" && url.pathname === "/api/connect") return json(await lab.connect());
      if (request.method === "POST" && url.pathname === "/api/session/new") return json(await lab.newSession());
      if (request.method === "POST" && url.pathname === "/api/session/config") {
        const data = await body(request);
        return json(await lab.setConfigOption(String(data.configId ?? ""), String(data.value ?? "")));
      }
      if (request.method === "POST" && url.pathname === "/api/session/delete") {
        const data = await body(request);
        return json(await lab.deleteSession(String(data.sessionId ?? "")));
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") return json(await lab.listSessions());
      if (request.method === "POST" && url.pathname === "/api/session/rename") {
        const data = await body(request);
        return json(lab.renameSession(String(data.sessionId ?? ""), String(data.title ?? "")));
      }
      if (request.method === "POST" && url.pathname === "/api/session/load") {
        const data = await body(request);
        return json(await lab.loadSession(String(data.sessionId ?? "")));
      }
      if (request.method === "POST" && url.pathname === "/api/session/prompt") {
        const data = await body(request);
        const images = Array.isArray(data.images) ? data.images : [];
        if (images.length > 5 || images.some((image) => !image || typeof image !== "object" || typeof image.data !== "string" || typeof image.mimeType !== "string")) return json({ error: "图片数据无效" }, 400);
        return json(await lab.prompt(String(data.text ?? ""), images));
      }
      if (request.method === "POST" && url.pathname === "/api/upload") {
        const data = await body(request);
        const name = String(data.name ?? "file").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 100);
        const encoded = String(data.data ?? "");
        if (!encoded || encoded.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return json({ error: "文件无效或超过 10 MB" }, 400);
        const uploadDir = join(workspace, "uploads");
        await mkdir(uploadDir, { recursive: true });
        const fileName = `${crypto.randomUUID()}-${name}`;
        await Bun.write(join(uploadDir, fileName), Buffer.from(encoded, "base64"));
        return json({ path: `uploads/${fileName}`, name });
      }
      if (request.method === "POST" && url.pathname === "/api/session/cancel") {
        await lab.cancel();
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/permission") {
        const data = await body(request);
        lab.answerPermission(String(data.requestId ?? ""), typeof data.optionId === "string" ? data.optionId : undefined);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/question") {
        const data = await body(request);
        lab.answerQuestion(String(data.requestId ?? ""), data.content && typeof data.content === "object" && !Array.isArray(data.content) ? data.content as Record<string, string | number | boolean | string[]> : undefined);
        return json({ ok: true });
      }
      if (request.method !== "GET") return json({ error: "不支持的请求" }, 405);
      if (url.pathname.startsWith("/fs/")) {
        const relative = decodeURIComponent(url.pathname.slice(4));
        if (!relative.startsWith("user/") || relative.split(/[\\/]/).includes("..")) return json({ error: "文件路径无效" }, 400);
        const base = await realpath(workspace);
        const target = await realpath(resolve(workspace, relative));
        const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
        const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
        if (!normalizedTarget.startsWith(`${normalizedBase}${sep}`)) return json({ error: "文件不在工作区内" }, 403);
        const info = await stat(target);
        if (!info.isFile() || info.size > 20_000_000) return json({ error: "文件不可预览" }, 400);
        return new Response(Bun.file(target), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox allow-scripts allow-forms" } });
      }
      const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!["index.html", "app.js", "styles.css", "extras.css", "fenix-theme.css"].includes(fileName)) return json({ error: "页面不存在" }, 404);
      if (fileName === "app.js") return new Response(clientScript, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } });
      return new Response(Bun.file(resolve(publicDir, fileName)), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[RealCode]", message);
      return json({ error: message }, 400);
    }
  },
  websocket: {
    open(socket) { browserBridge.open(socket); },
    message(socket, message) { browserBridge.message(socket, message); },
    close(socket) { browserBridge.close(socket); },
  },
});

console.log(`RealCode: http://127.0.0.1:${server.port}`);
console.log(`workspace: ${lab.workspace}`);
process.on("SIGINT", () => { browserBridge.shutdown(); lab.close(); server.stop(); });
process.on("SIGTERM", () => { browserBridge.shutdown(); lab.close(); server.stop(); });
