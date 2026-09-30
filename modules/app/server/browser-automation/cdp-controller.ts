import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserMethod } from './browser-method';
import { activityLog } from './activity-log';
import { availableChromePort, closeChromeGracefully } from './chrome-lifecycle';
import { CdpClient, type CdpEvent } from './cdp-client';
import { findChromeExecutable } from './page-handoff';

interface PageRef { targetId: string; sessionId: string }
interface Surface { page: PageRef; framed: boolean; mode: 'floating-preview' | 'top-level' | 'new-tab-fallback'; fallbackUrl: string | null }
interface Identity { documentId: string; url: string }
interface Action { id: string; kind: 'fill' | 'click'; label: string; navigates: boolean }
interface Observation { fingerprint: string; frameId: string; targetId: string; mode: string; actions: Action[] }
interface WebMcpTool { name: string; description: string; inputSchema?: unknown; frameId: string; annotations?: Record<string, unknown> }
interface NativeTool extends WebMcpTool { sessionId: string }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Chrome CDP driver for the RealCode-controlled browser. No automation SDK or extension is required. */
export class CdpController {
  private client: CdpClient | null = null;
  private chrome: ChildProcess | null = null;
  private chromePort: number | null = null;
  private owner: PageRef | null = null;
  private fallback: PageRef | null = null;
  private observation: Observation | null = null;
  private blockedFrameUrl: string | null = null;
  private nonce = crypto.randomUUID();
  private initScript = '';
  private sessions = new Map<string, Promise<void>>();
  private nativeTools = new Map<string, NativeTool>();
  private executionFrames = new Map<string, string>();
  private invocations = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly origin: string, private readonly workspace: string, private readonly headless = false,
    private readonly onToolsChanged?: (change: { frameId: string; added: string[]; removed: string[] }) => void,
    private readonly onSiteStateChanged?: (change: { frameId: string | null; state: string; loginState: string; url: string }) => void) {}

  async start(url = this.origin): Promise<void> {
    if (this.client && this.owner) { await this.client.send('Target.activateTarget', { targetId: this.owner.targetId }); return; }
    const executable = findChromeExecutable();
    if (!executable) throw new Error('未找到 Chrome，请配置 CHROME_PATH');
    const profile = resolve(this.workspace, '.realcode/cdp/profile');
    await mkdir(profile, { recursive: true });
    const port = await availableChromePort();
    const guards = await readFile(resolve(import.meta.dir, 'page-guards.js'), 'utf8');
    const bilibili = await readFile(resolve(import.meta.dir, 'site-hooks/bilibili-site-hook.js'), 'utf8');
    const navigation = await readFile(resolve(import.meta.dir, 'floating-preview-navigation.js'), 'utf8');
    const videoPause = await readFile(resolve(import.meta.dir, 'embedded-video-pause.js'), 'utf8');
    this.initScript = `${guards}\ninstallPageGuards(${JSON.stringify(this.nonce)});\n${bilibili}\ninstallBilibiliSiteHook(${JSON.stringify(this.nonce)}, ${JSON.stringify(this.origin)});\n${navigation}\n${videoPause}`;
    this.chrome = spawn(executable, [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--start-maximized', '--enable-features=WebMCP',
      ...(this.headless ? ['--headless=new', '--disable-gpu'] : []), 'about:blank',
    ], { stdio: 'ignore', windowsHide: this.headless });
    this.chromePort = port;
    try {
      let endpoint = '';
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
          if (response.ok) { endpoint = (await response.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl; break; }
        } catch { /* Chrome may still be starting. */ }
        if (this.chrome.exitCode !== null) throw new Error('Chrome 在连接前退出');
        await delay(100);
      }
      if (!endpoint) throw new Error('等待 Chrome 调试端口超时');
      this.client = await CdpClient.connect(endpoint);
      this.client.on(event => this.onEvent(event));
      await this.client.send('Target.setDiscoverTargets', { discover: true });
      const targets = await this.targets();
      const blank = targets.find(target => target.url === 'about:blank');
      const targetId = blank?.targetId ?? (await this.client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
      this.owner = await this.attachPage(targetId);
      await this.navigate(this.owner, url);
      await this.waitForUrl(this.owner, url);
      await this.client.send('Target.activateTarget', { targetId });
      for (const target of await this.targets()) {
        if (target.targetId !== targetId && target.url === 'about:blank') await this.client.send('Target.closeTarget', { targetId: target.targetId });
      }
    } catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    const client = this.client;
    const chrome = this.chrome;
    const port = this.chromePort;
    this.client = null; this.chrome = null; this.chromePort = null;
    this.owner = null; this.fallback = null; this.observation = null; this.blockedFrameUrl = null;
    this.sessions.clear();
    this.nativeTools.clear();
    this.executionFrames.clear();
    for (const invocation of this.invocations.values()) { clearTimeout(invocation.timer); invocation.reject(new Error('受控浏览器已关闭')); }
    this.invocations.clear();
    if (client && port !== null) {
      const graceful = await closeChromeGracefully(port);
      activityLog('cdp', 'browser.graceful_close', { successful: graceful });
      client.close();
      if (graceful) await delay(400);
    }
    if (chrome && chrome.exitCode === null && port !== null) {
      try { chrome.kill(); } catch { /* Browser.close may have already exited. */ }
    }
  }

  private onEvent(event: CdpEvent): void {
    if (event.method === 'Page.frameNavigated' && event.sessionId && event.params.frame?.id) {
      const frameId = event.params.frame.id as string;
      for (const [key, tool] of this.nativeTools) {
        if (tool.sessionId !== event.sessionId || tool.frameId !== frameId) continue;
        this.nativeTools.delete(key);
        this.onToolsChanged?.({ frameId, added: [], removed: [tool.name] });
      }
    }
    if (event.method === 'Runtime.executionContextCreated' && event.sessionId) {
      const context = event.params.context;
      if (context?.auxData?.frameId) this.executionFrames.set(`${event.sessionId}:${context.id}`, context.auxData.frameId);
    }
    if (event.method === 'Runtime.executionContextDestroyed' && event.sessionId) this.executionFrames.delete(`${event.sessionId}:${event.params.executionContextId}`);
    if (event.method === 'Runtime.executionContextsCleared' && event.sessionId) {
      for (const key of this.executionFrames.keys()) if (key.startsWith(`${event.sessionId}:`)) this.executionFrames.delete(key);
    }
    if (event.method === 'Runtime.bindingCalled' && event.params.name === '__realcodeSiteStateChanged' && event.sessionId) {
      try {
        const state = JSON.parse(event.params.payload) as { nonce?: string; state?: string; loginState?: string; url?: string };
        if (state.nonce === this.nonce && typeof state.state === 'string' && typeof state.loginState === 'string' &&
          typeof state.url === 'string' && /(^|\.)bilibili\.com$/i.test(new URL(state.url).hostname)) {
          this.onSiteStateChanged?.({ frameId: this.executionFrames.get(`${event.sessionId}:${event.params.executionContextId}`) ?? null,
            state: state.state, loginState: state.loginState, url: state.url });
        }
      } catch { /* Ignore invalid page messages. */ }
    }
    if (event.method === 'WebMCP.toolsAdded' && event.sessionId) {
      for (const tool of (event.params.tools ?? []) as WebMcpTool[]) {
        this.nativeTools.set(`${event.sessionId}:${tool.frameId}:${tool.name}`, { ...tool, sessionId: event.sessionId });
        this.onToolsChanged?.({ frameId: tool.frameId, added: [tool.name], removed: [] });
      }
    }
    if (event.method === 'WebMCP.toolsRemoved' && event.sessionId) {
      for (const tool of (event.params.tools ?? []) as Array<{ frameId: string; name: string }>) {
        this.nativeTools.delete(`${event.sessionId}:${tool.frameId}:${tool.name}`);
        this.onToolsChanged?.({ frameId: tool.frameId, added: [], removed: [tool.name] });
      }
    }
    if (event.method === 'WebMCP.toolResponded') {
      const pending = this.invocations.get(event.params.invocationId);
      if (pending) {
        this.invocations.delete(event.params.invocationId);
        clearTimeout(pending.timer);
        if (event.params.status === 'Completed') pending.resolve(event.params.output);
        else pending.reject(new Error(event.params.errorText ?? `WebMCP 调用${event.params.status}`));
      }
    }
    if (event.method === 'Target.detachedFromTarget' && event.params.sessionId) {
      this.sessions.delete(event.params.sessionId);
      for (const key of this.executionFrames.keys()) if (key.startsWith(`${event.params.sessionId}:`)) this.executionFrames.delete(key);
      for (const [key, tool] of this.nativeTools) if (key.startsWith(`${event.params.sessionId}:`)) {
        this.nativeTools.delete(key);
        this.onToolsChanged?.({ frameId: tool.frameId, added: [], removed: [tool.name] });
      }
    }
    if (event.method === 'Target.attachedToTarget' && event.params.sessionId) {
      const { sessionId, targetInfo, waitingForDebugger } = event.params;
      if (targetInfo?.type === 'iframe') {
        void this.setupSession(sessionId, waitingForDebugger === true).catch(error => {
          activityLog('cdp', 'frame.setup_failed', { reason: error instanceof Error ? error.message : String(error) });
        });
      }
    }
    if (event.method === 'Target.targetDestroyed' && event.params.targetId === this.fallback?.targetId) this.fallback = null;
  }

  private setupSession(sessionId: string, paused = false): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const setup = (async () => {
      const client = this.requiredClient();
      await client.send('Page.enable', {}, sessionId);
      await client.send('Runtime.enable', {}, sessionId);
      await client.send('Runtime.addBinding', { name: '__realcodeSiteStateChanged' }, sessionId);
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: this.initScript, runImmediately: true }, sessionId);
      if (paused) await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      try { await client.send('WebMCP.enable', {}, sessionId); }
      catch (error) { activityLog('cdp', 'webmcp.unavailable', { reason: error instanceof Error ? error.message : String(error) }); }
    })();
    this.sessions.set(sessionId, setup);
    return setup;
  }

  private async attachPage(targetId: string): Promise<PageRef> {
    const client = this.requiredClient();
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await this.setupSession(sessionId);
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    return { targetId, sessionId };
  }

  private requiredClient(): CdpClient {
    if (!this.client) throw new Error('受控浏览器未启动');
    return this.client;
  }

  private async targets(): Promise<Array<{ targetId: string; type: string; url: string }>> {
    const result = await this.requiredClient().send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
    return result.targetInfos.filter(target => target.type === 'page');
  }

  private async navigate(page: PageRef, url: string): Promise<void> {
    const result = await this.requiredClient().send<{ errorText?: string }>('Page.navigate', { url }, page.sessionId);
    if (result.errorText) throw new Error(result.errorText);
  }

  private async waitForUrl(page: PageRef, expectedUrl: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const current = await this.evaluate<string>(page, 'location.href', 1000);
        if (current === expectedUrl || current.replace(/\/$/, '') === expectedUrl.replace(/\/$/, '')) return;
      } catch { /* The previous execution context may have been destroyed by navigation. */ }
      await delay(100);
    }
    throw new Error(`页面导航未完成：${expectedUrl}`);
  }

  private async evaluate<T>(page: PageRef, expression: string, timeoutMs = 10000): Promise<T> {
    const result = await this.requiredClient().send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本执行失败');
    return result.result.value as T;
  }

  async command(method: BrowserMethod, args: Record<string, unknown>): Promise<unknown> {
    const surface = await this.surface();
    if (method === 'browser.openTab') {
      if (surface.mode !== 'new-tab-fallback' || !surface.fallbackUrl || args.url !== surface.fallbackUrl) throw new Error('只能打开观察返回的 fallbackUrl');
      const url = new URL(surface.fallbackUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 页面');
      const created = await this.requiredClient().send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      this.fallback = await this.attachPage(created.targetId);
      await this.navigate(this.fallback, url.href);
      await this.requiredClient().send('Target.activateTarget', { targetId: created.targetId });
      return await this.observe(await this.surface(), args);
    }
    if (method === 'browser.screenshot') {
      const result = await this.requiredClient().send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, surface.page.sessionId);
      return { provider: 'cdp', dataUrl: `data:image/png;base64,${result.data}` };
    }
    if (method === 'browser.site') return await this.site(surface, args);
    if (method === 'browser.observe') return await this.observe(surface, args);
    return await this.act(surface, args);
  }

  private async surface(): Promise<Surface> {
    const owner = this.owner;
    if (!owner) throw new Error('请先启动受控模式');
    const targets = await this.targets();
    if (!targets.some(target => target.targetId === owner.targetId)) throw new Error('受控模式会话标签页已关闭，请重新启动');
    const ownerUrl = targets.find(target => target.targetId === owner.targetId)?.url ?? '';
    if (new URL(ownerUrl).origin !== this.origin) throw new Error('受控标签页已离开 RealCode，请重新启动');
    const control = await this.evaluate<{ open: boolean; frameUrl: string; fallbackUrl: string | null }>(owner, `(() => {
      const modal = document.querySelector('#iframe-modal');
      const frame = document.querySelector('#iframe-expanded');
      if (!modal || !frame) throw new Error('受控标签页已离开 RealCode');
      const frames = Array.from(document.querySelectorAll('iframe.message-iframe'));
      return { open: !modal.hidden && !frame.hidden && Boolean(frame.getAttribute('src')),
        frameUrl: frame.src, fallbackUrl: frames.at(-1)?.src || null };
    })()`);
    if (this.blockedFrameUrl && this.blockedFrameUrl !== control.frameUrl) this.blockedFrameUrl = null;
    const fallback = this.fallback && targets.some(target => target.targetId === this.fallback?.targetId) ? this.fallback : null;
    if (this.blockedFrameUrl && fallback) return { page: fallback, framed: false, mode: 'top-level', fallbackUrl: null };
    if (control.open && this.blockedFrameUrl) return { page: owner, framed: false, mode: 'new-tab-fallback', fallbackUrl: this.blockedFrameUrl };
    if (control.open) return { page: owner, framed: true, mode: 'floating-preview', fallbackUrl: null };
    if (fallback) return { page: fallback, framed: false, mode: 'top-level', fallbackUrl: null };
    return { page: owner, framed: false, mode: 'new-tab-fallback', fallbackUrl: control.fallbackUrl };
  }

  private async probe<T>(surface: Surface, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const expression = `(${async ({ nonce, framed, method, args }: { nonce: string; framed: boolean; method: string; args: Record<string, unknown> }) => {
      const frame = framed ? document.querySelector<HTMLIFrameElement>('#iframe-expanded') : null;
      const target = frame ? frame.contentWindow : window;
      if (!target) throw new Error('浮窗文档尚未加载');
      return await new Promise<unknown>((resolve, reject) => {
        const id = crypto.randomUUID();
        const listener = (event: MessageEvent) => {
          if (event.source !== target || event.data?.nonce !== nonce || event.data?.id !== id || !Object.hasOwn(event.data, 'result')) return;
          clearTimeout(timer); removeEventListener('message', listener);
          event.data.result?.error ? reject(new Error(event.data.result.error)) : resolve(event.data.result);
        };
        const timer = setTimeout(() => { removeEventListener('message', listener); reject(new Error('浮窗文档未就绪或不支持脚本执行，请重新观察')); }, 2500);
        addEventListener('message', listener);
        target.postMessage({ nonce, id, method, ...args }, '*');
      });
    }})(${JSON.stringify({ nonce: this.nonce, framed: surface.framed, method, args })})`;
    return await this.evaluate<T>(surface.page, expression, 5000);
  }

  private async currentFrameId(surface: Surface): Promise<string> {
    const client = this.requiredClient();
    if (!surface.framed) {
      const tree = await client.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, surface.page.sessionId);
      return tree.frameTree.frame.id;
    }
    const document = await client.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 }, surface.page.sessionId);
    const element = await client.send<{ nodeId: number }>('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#iframe-expanded' }, surface.page.sessionId);
    if (!element.nodeId) throw new Error('浮窗 iframe 已关闭');
    const described = await client.send<{ node: { frameId?: string } }>('DOM.describeNode', { nodeId: element.nodeId }, surface.page.sessionId);
    if (!described.node.frameId) throw new Error('浮窗 iframe 尚未加载');
    return described.node.frameId;
  }

  private async nativeForSurface(surface: Surface): Promise<NativeTool[]> {
    const frameId = await this.currentFrameId(surface);
    return [...this.nativeTools.values()].filter(tool => tool.frameId === frameId);
  }

  /** Fast catalog for MCP discovery; retain the hook fallback when Chrome lacks WebMCP. */
  async listSiteTools(): Promise<unknown[]> {
    const surface = await this.surface();
    if (surface.mode === 'new-tab-fallback') return [];
    const result = await this.site(surface, { operation: 'tools' }) as { tools?: unknown[] };
    return result.tools ?? [];
  }

  private async invokeNative(tool: NativeTool, input: Record<string, unknown>): Promise<unknown> {
    const client = this.requiredClient();
    const { invocationId } = await client.send<{ invocationId: string }>('WebMCP.invokeTool',
      { frameId: tool.frameId, toolName: tool.name, input }, tool.sessionId);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.invocations.delete(invocationId);
        void client.send('WebMCP.cancelInvocation', { invocationId }, tool.sessionId).catch(() => {});
        reject(new Error('WebMCP 工具调用超时'));
      }, 12000);
      this.invocations.set(invocationId, { resolve, reject, timer });
    });
  }

  private async waitForSiteTool(name: string, timeoutMs = 12000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const surface = await this.surface();
        if (surface.mode !== 'new-tab-fallback') {
          const listed = await this.site(surface, { operation: 'tools' }) as { tools?: Array<{ name: string }> };
          if (listed.tools?.some(tool => tool.name === name)) return;
        }
      } catch { /* Navigation may temporarily remove the execution context. */ }
      await delay(150);
    }
    throw new Error(`页面未进入可操作状态：${name}。请检查搜索结果或验证码。`);
  }

  private async callSiteTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.site(await this.surface(), { operation: 'call', name, args }) as Record<string, unknown>;
    return (response.output && typeof response.output === 'object' ? response.output : response) as Record<string, unknown>;
  }

  private async playWithGesture(surface: Surface, output: unknown): Promise<unknown> {
    if (!output || typeof output !== 'object') return output;
    if ((output as { status?: string }).status === 'playing') {
      await delay(250);
      const checked = await this.probe<{ paused: boolean }>(surface, 'site.playTarget');
      return { status: checked.paused ? 'playback_failed' : 'playing', state: 'video' };
    }
    if ((output as { status?: string }).status !== 'user_gesture_required') return output;
    const target = await this.probe<{ paused: boolean; rect: { x: number; y: number; width: number; height: number } }>(surface, 'site.playTarget');
    let offset = { x: 0, y: 0 };
    if (surface.framed) {
      offset = await this.evaluate(surface.page, `(() => {
        const frame = document.querySelector('#iframe-expanded');
        if (!frame) throw new Error('浮窗已关闭');
        const rect = frame.getBoundingClientRect();
        return { x: rect.x + frame.clientLeft, y: rect.y + frame.clientTop };
      })()`);
    }
    const x = Math.round(offset.x + target.rect.x + target.rect.width / 2);
    const y = Math.round(offset.y + target.rect.y + target.rect.height / 2);
    const client = this.requiredClient();
    const sessionId = surface.page.sessionId;
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    await delay(250);
    const after = await this.probe<{ paused: boolean }>(surface, 'site.playTarget');
    return { status: after.paused ? 'playback_failed' : 'playing', state: 'video' };
  }

  private async finishSearchAndPlay(query: string, initial: unknown): Promise<unknown> {
    if (!initial || typeof initial !== 'object' || (initial as { status?: string }).status !== 'navigation_started') {
      throw new Error('视频搜索未能发起');
    }
    await this.waitForSiteTool('realcode.bilibili.listResults');
    let listing: { status?: string; results?: Array<{ resultId: string; title: string; url: string }> } = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      listing = await this.callSiteTool('realcode.bilibili.listResults', { limit: 10 }) as typeof listing;
      if (listing.status === 'layout_unrecognized') throw new Error('搜索结果页面结构无法识别');
      if (listing.status === 'arrived' && listing.results?.length) break;
      await delay(250);
    }
    if (!listing.results?.length) throw new Error('搜索结果尚未就绪或没有可播放视频');
    const first = listing.results[0]!;
    await this.waitForSiteTool('realcode.bilibili.openResult');
    const opening = await this.callSiteTool('realcode.bilibili.openResult', { resultId: first.resultId }) as { status?: string };
    if (opening.status !== 'navigation_started') throw new Error('未能打开搜索结果');
    await this.waitForSiteTool('realcode.bilibili.getVideoInfo');
    let info: { status?: string; title?: string; url?: string; resultId?: string } = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      info = await this.callSiteTool('realcode.bilibili.getVideoInfo') as typeof info;
      if (info.status === 'arrived') break;
      await delay(250);
    }
    if (info.status !== 'arrived' || info.resultId !== first.resultId) throw new Error('视频页未到达目标结果');
    await this.waitForSiteTool('realcode.bilibili.playVideo');
    let playback: { status?: string } = {};
    for (let attempt = 0; attempt < 40; attempt++) {
      playback = await this.callSiteTool('realcode.bilibili.playVideo') as { status?: string };
      if (playback.status === 'playing') break;
      if (playback.status !== 'player_unavailable' && playback.status !== 'player_loading') break;
      await delay(250);
    }
    if (playback.status === 'player_loading') throw new Error('已打开视频，但播放器尚未载入媒体，无法确认播放。可在顶层标签页打开视频重试。');
    if (playback.status !== 'playing') throw new Error(`已打开视频，但播放未成功：${playback.status ?? 'unknown'}`);
    return { status: 'playing', query, resultId: first.resultId, title: info.title ?? first.title, url: info.url ?? first.url };
  }

  private async site(surface: Surface, args: Record<string, unknown>): Promise<unknown> {
    if (surface.mode === 'new-tab-fallback') return { controlMode: surface.mode, fallbackUrl: surface.fallbackUrl, tools: [] };
    if (args.operation !== 'tools' && args.operation !== 'call') throw new Error('operation 必须是 tools 或 call');
    const native = await this.nativeForSurface(surface);
    const siteUrl = surface.framed
      ? await this.evaluate<string>(surface.page, `document.querySelector('#iframe-expanded')?.src ?? ''`)
      : (await this.targets()).find(target => target.targetId === surface.page.targetId)?.url ?? '';
    const isBilibili = (() => { try { return /(^|\.)bilibili\.com$/i.test(new URL(siteUrl).hostname); } catch { return false; } })();
    const name = typeof args.name === 'string' ? args.name : '';
    if (args.operation === 'call') {
      const owned = native.find(tool => tool.name === name);
      if (owned) {
        const input = (args.args ?? {}) as Record<string, unknown>;
        const invoked = await this.invokeNative(owned, input);
        const output = name === 'realcode.bilibili.searchAndPlay'
          ? await this.finishSearchAndPlay(String(input.query ?? ''), invoked)
          : name === 'realcode.bilibili.playVideo' ? await this.playWithGesture(surface, invoked) : invoked;
        return { provider: 'webmcp', source: name.startsWith('realcode.') ? 'third-party-hook' : 'site', name, output };
      }
      if (!isBilibili || !/^(realcode\.)?bilibili\./.test(name)) throw new Error('当前页面没有该站点工具');
    }
    if (!isBilibili) {
      if (args.operation === 'call') throw new Error('当前页面没有该站点工具');
      return { provider: 'webmcp', site: new URL(siteUrl).hostname, tools: native.map(tool => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations,
        source: tool.name.startsWith('realcode.') ? 'third-party-hook' : 'site',
      })) };
    }
    const adapterName = name.startsWith('realcode.') ? name.slice('realcode.'.length) : name;
    const result = await this.probe<{ site?: string; source?: string; state?: string; loginState?: string; tools?: unknown[]; navigationUrl?: string }>(
      surface, args.operation === 'tools' ? 'site.tools' : 'site.call',
      args.operation === 'tools' ? {} : { name: adapterName, args: args.args ?? {} });
    if (args.operation === 'tools') {
      const names = new Set(native.map(tool => tool.name));
      const hookTools = (result.tools ?? []).filter(tool => !names.has((tool as { name: string }).name))
        .map(tool => ({ ...(tool as Record<string, unknown>), source: 'third-party-hook' }));
      return { provider: 'webmcp', site: result.site, state: result.state, loginState: result.loginState, tools: [
        ...native.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          annotations: tool.annotations, source: tool.name.startsWith('realcode.') ? 'third-party-hook' : 'site' })),
        ...hookTools,
      ] };
    }
    if (!result.navigationUrl) {
      const output = name === 'realcode.bilibili.playVideo' ? await this.playWithGesture(surface, result) : result;
      return { provider: 'realcode-site-adapter', source: 'third-party-hook', name, output };
    }
    const target = new URL(result.navigationUrl);
    if (target.protocol !== 'https:' || !/(^|\.)bilibili\.com$/i.test(target.hostname)) throw new Error('站点适配器返回了无效导航地址');
    this.observation = null;
    if (surface.framed) await this.evaluate(surface.page, `(() => { const frame = document.querySelector('#iframe-expanded'); if (!frame) throw new Error('浮窗已关闭'); frame.src = ${JSON.stringify(target.href)}; })()`);
    else await this.navigate(surface.page, target.href);
    if (name === 'realcode.bilibili.searchAndPlay') return { provider: 'realcode-site-adapter', source: 'third-party-hook', name,
      output: await this.finishSearchAndPlay(String((args.args as Record<string, unknown> | undefined)?.query ?? ''), result) };
    return { provider: 'realcode-site-adapter', source: 'third-party-hook', name, site: 'bilibili.com', navigationUrl: target.href,
      navigationExpected: true, needsObservation: true, output: { ...result, status: 'navigation_started' } };
  }

  private async observe(surface: Surface, args: Record<string, unknown>): Promise<unknown> {
    if (surface.mode === 'new-tab-fallback') {
      this.observation = null;
      return { provider: 'cdp', controlMode: surface.mode, fallbackUrl: surface.fallbackUrl, frames: [], hint: '请展开受控 Chrome 中的网页预览，或打开 fallbackUrl。' };
    }
    try { return await this.observeReady(surface, args); }
    catch (error) {
      if (!surface.framed || !/浮窗文档未就绪或不支持脚本执行/.test(error instanceof Error ? error.message : String(error))) throw error;
      const url = await this.evaluate<string | null>(surface.page, `document.querySelector('#iframe-expanded')?.src ?? null`);
      if (!url) throw error;
      this.blockedFrameUrl = url;
      this.observation = null;
      return { provider: 'cdp', controlMode: 'new-tab-fallback', fallbackUrl: url, frames: [], hint: '嵌入页未提供可操作文档，请在受控 Chrome 顶层标签页打开 fallbackUrl。' };
    }
  }

  private async observeReady(surface: Surface, args: Record<string, unknown>): Promise<unknown> {
    const maxActions = typeof args.maxActions === 'number' ? Math.min(500, Math.max(1, args.maxActions)) : 120;
    const maxTextLength = typeof args.maxTextLength === 'number' ? Math.min(50000, Math.max(0, args.maxTextLength)) : 6000;
    const fingerprint = crypto.randomUUID();
    const observe = () => this.probe<Identity & { text: string; actions: Action[] }>(surface, 'observe', { fingerprint, maxActions, maxTextLength });
    let observed = await observe();
    for (let attempt = 0; attempt < 3 && !observed.actions.length && !observed.text.trim(); attempt++) { await delay(200); observed = await observe(); }
    const frameId = `${surface.page.targetId}:${observed.documentId}`;
    this.observation = { fingerprint, frameId, targetId: surface.page.targetId, mode: surface.mode, actions: observed.actions };
    const state: Record<string, unknown> = { url: observed.url, fingerprint, text: observed.text, actions: observed.actions };
    if (args.includeStructure === true) {
      try {
        const snapshot = await this.requiredClient().send<{ nodes: Array<{ nodeId: string; role?: { value?: string }; name?: { value?: string } }> }>('Accessibility.getFullAXTree', {}, surface.page.sessionId);
        state.structure = snapshot.nodes.filter(node => node.role?.value && node.name?.value).slice(0, 80)
          .map(node => `${node.role?.value}: ${node.name?.value}`).join('\n').slice(0, maxTextLength);
      } catch (error) { activityLog('cdp', 'snapshot.unavailable', { reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { provider: 'cdp', controlMode: surface.mode, fallbackUrl: null, frames: [{ frameId, state }],
      limitations: '仅支持当前文档或单层浮窗的填写和点击；操作后需检查返回内容确认业务结果。' };
  }

  private async act(surface: Surface, args: Record<string, unknown>): Promise<unknown> {
    const observed = this.observation;
    if (!observed || observed.fingerprint !== args.fingerprint || observed.targetId !== surface.page.targetId || observed.mode !== surface.mode || (args.frameId && args.frameId !== observed.frameId)) throw new Error('STALE_PAGE: 控制目标或观察已变化，请重新观察');
    const action = observed.actions.find(item => item.id === args.actionId);
    if (!action) throw new Error('无效 actionId');
    if (action.kind === 'fill' && typeof args.text !== 'string') throw new Error('填写操作需要 text');
    const prepared = await this.probe<{ documentId: string; rect: { x: number; y: number; width: number; height: number } }>(surface, 'prepare', { fingerprint: observed.fingerprint, actionId: action.id });
    if (`${surface.page.targetId}:${prepared.documentId}` !== observed.frameId) throw new Error('STALE_PAGE: 文档已更换');
    let offset = { x: 0, y: 0 };
    if (surface.framed) {
      offset = await this.evaluate<{ x: number; y: number }>(surface.page, `(() => {
        const frame = document.querySelector('#iframe-expanded');
        if (!frame) throw new Error('浮窗已关闭');
        const rect = frame.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        if (document.elementFromPoint(x, y) !== frame) throw new Error('浮窗被会话弹层遮挡，请先关闭弹层');
        return { x: rect.x + frame.clientLeft, y: rect.y + frame.clientTop };
      })()`);
    }
    const x = Math.round(offset.x + prepared.rect.x + prepared.rect.width / 2);
    const y = Math.round(offset.y + prepared.rect.y + prepared.rect.height / 2);
    const client = this.requiredClient();
    const sessionId = surface.page.sessionId;
    const previousTargets = action.navigates ? new Set((await this.targets()).map(target => target.targetId)) : null;
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    if (action.kind === 'fill') {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 }, sessionId);
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, sessionId);
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, sessionId);
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 }, sessionId);
      await client.send('Input.insertText', { text: args.text }, sessionId);
    }
    this.observation = null;
    await delay(150);
    if (previousTargets) {
      const opened = (await this.targets()).filter(target => !previousTargets.has(target.targetId));
      if (opened.length === 1) this.fallback = await this.attachPage(opened[0]!.targetId);
    }
    if (action.navigates) return { provider: 'cdp', executed: true, actionId: action.id, needsObservation: true, navigationExpected: true };
    try { return { executed: true, actionId: action.id, ...await this.observe(await this.surface(), {}) as Record<string, unknown> }; }
    catch (error) { return { provider: 'cdp', executed: true, actionId: action.id, needsObservation: true, observationError: error instanceof Error ? error.message : String(error) }; }
  }

}
