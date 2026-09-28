import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localBrowser, Stagehand, type Page, type StagehandBrowser } from '@browserbasehq/stagehand';
import type { BrowserMethod } from './bridge';
import { activityLog } from './activity-log';
import { availableChromePort, closeChromeGracefully } from './chrome-lifecycle';

interface Surface { page: Page; framePath: string | null; mode: string; fallbackUrl: string | null }
interface Identity { documentId: string; url: string }
interface Action { id: string; kind: 'fill' | 'click'; label: string; navigates: boolean }
interface Observation { fingerprint: string; frameId: string; pageId: string; mode: string; actions: Action[] }

/** Keep the native accessibility tree inside the selected preview, never the surrounding chat. */
function previewTree(tree: string, xpathMap: Record<string, string>, framePath: string | null): string {
  if (!framePath) return tree;
  const lines = tree.split('\n');
  const index = lines.findIndex(line => {
    const match = line.match(/^\s*\[([^\]]+)\] Iframe(?:\b|$)/);
    return !!match && xpathMap[match[1]!] === framePath;
  });
  if (index < 0) return '';
  const indent = lines[index]!.length - lines[index]!.trimStart().length;
  const end = lines.findIndex((line, position) => position > index && line.trim() && line.length - line.trimStart().length <= indent);
  return lines.slice(index + 1, end < 0 ? undefined : end).join('\n');
}

/** Stagehand 的本机实验驱动；仅控制自己创建的浏览器和明确选定的浮窗。 */
export class StagehandDriver {
  private browser: StagehandBrowser | null = null;
  private runtime: Stagehand | null = null;
  private owner: Page | null = null;
  private fallback: Page | null = null;
  private observation: Observation | null = null;
  private nonce = crypto.randomUUID();
  private chromePort: number | null = null;
  private blockedFrameUrl: string | null = null;

  constructor(private readonly origin: string, private readonly workspace: string, private readonly headless = false) {}

  /** 启动专用 Chrome 并打开当前 RealCode，日常浏览器不受影响。 */
  async start(url = this.origin) {
    if (this.browser) { await this.browser.context.setActivePage(this.owner!); return; }
    const profile = resolve(this.workspace, '.realcode/stagehand/profile');
    await mkdir(profile, { recursive: true });
    const port = await availableChromePort();
    this.browser = await localBrowser.launch({ headless: this.headless, userDataDir: profile, port,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: ['--start-maximized', '--disable-session-crashed-bubble'] });
    this.chromePort = port;
    try {
      this.runtime = await Stagehand.create({ browser: this.browser });
      const guards = await readFile(resolve(import.meta.dir, 'stagehand-page-runtime.js'), 'utf8');
      const navigation = await readFile(resolve(import.meta.dir, '../../browser-extension/src/browser-automation/floating-preview-navigation.js'), 'utf8');
      const videoPause = await readFile(resolve(import.meta.dir, '../../browser-extension/src/browser-automation/embedded-video-pause.js'), 'utf8');
      await this.browser.context.addInitScript(`${guards}\ninstallStagehandGuards(${JSON.stringify(this.nonce)});\n${navigation}\n${videoPause}`);
      const pages = await this.browser.context.pages();
      let blankPage: Page | undefined;
      for (const page of pages) {
        if (await page.url() === 'about:blank') { blankPage = page; break; }
      }
      // Chrome 启动时自带空白标签；复用它，避免会话页旁边留下 about:blank。
      this.owner = blankPage ?? await this.browser.context.newPage();
      await this.owner.goto(url);
      await this.browser.context.setActivePage(this.owner);
      for (const page of await this.browser.context.pages()) {
        if (page.pageId !== this.owner.pageId && await page.url() === 'about:blank') await page.close();
      }
    } catch (error) { await this.stop(); throw error; }
  }

  /** 关闭本驱动创建的 Chrome，清空旧观察，禁止继续使用旧动作。 */
  async stop() {
    const browser = this.browser;
    const runtime = this.runtime;
    const port = this.chromePort;
    this.chromePort = null; this.blockedFrameUrl = null;
    this.browser = null; this.runtime = null; this.owner = null; this.fallback = null; this.observation = null;
    if (browser && port !== null) {
      const graceful = await closeChromeGracefully(port);
      activityLog('stagehand', 'browser.graceful_close', { successful: graceful });
      // Browser.close 只发起关闭；给 Chrome 一点时间写完 profile 状态。
      if (graceful) await new Promise(resolve => setTimeout(resolve, 400));
    }
    // 并行发起运行时释放与浏览器关闭，避免等待网页调试连接后才能终止 Chrome。
    const releasing = runtime?.close().catch(error => {
      if (error instanceof Error && /RPC client is closed|CDP connection.*closed/i.test(error.message)) {
        activityLog('stagehand', 'runtime.already_closed');
        return;
      }
      throw error;
    });
    const outcomes = await Promise.allSettled([releasing, browser?.close()]);
    const failed = outcomes.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  /** 执行与扩展模式一致的工具协议，不额外调用模型。 */
  async command(method: BrowserMethod, args: Record<string, unknown>) {
    const surface = await this.surface();
    if (method === 'browser.openTab') {
      if (surface.mode !== 'new-tab-fallback' || !surface.fallbackUrl || args.url !== surface.fallbackUrl) throw new Error('只能打开观察返回的 fallbackUrl');
      const url = new URL(surface.fallbackUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 页面');
      this.fallback = await this.browser!.context.newPage(url.href);
      return this.observe(await this.surface(), args);
    }
    if (method === 'browser.screenshot') {
      const bytes = await surface.page.screenshot();
      return { provider: 'stagehand', dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` };
    }
    if (method === 'browser.observe') return this.observe(surface, args);
    return this.act(surface, args);
  }

  private async surface(): Promise<Surface> {
    if (!this.browser || !this.owner) throw new Error('请先在浏览器控制面板启动受控模式');
    const page = this.owner;
    if (!(await this.browser.context.pages()).some(p => p.pageId === page.pageId)) throw new Error('受控模式会话标签页已关闭，请重新启动');
    if (new URL(await page.url()).origin !== this.origin) throw new Error('受控标签页已离开 RealCode，请重新启动');
    const control = await page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>('#iframe-modal');
      const frame = document.querySelector<HTMLIFrameElement>('#iframe-expanded');
      if (!modal || !frame) throw new Error('受控标签页已离开 RealCode');
      const open = !modal.hidden && !frame.hidden && Boolean(frame.getAttribute('src'));
      const parts: string[] = [];
      for (let node: Element | null = frame; node; node = node.parentElement) {
        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(e => e.tagName === node!.tagName) : [node];
        parts.unshift(`${node.tagName.toLowerCase()}[${siblings.indexOf(node) + 1}]`);
      }
      const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.message-iframe'));
      return { open, path: `/${parts.join('/')}`, frameUrl: frame.src, fallbackUrl: frames.at(-1)?.src || null };
    });
    if (this.blockedFrameUrl && this.blockedFrameUrl !== control.frameUrl) this.blockedFrameUrl = null;
    if (this.blockedFrameUrl && this.fallback && (await this.browser.context.pages()).some(p => p.pageId === this.fallback!.pageId)) return { page: this.fallback, framePath: null, mode: 'top-level', fallbackUrl: null };
    if (control.open && this.blockedFrameUrl) return { page, framePath: null, mode: 'new-tab-fallback', fallbackUrl: this.blockedFrameUrl };
    if (control.open) return { page, framePath: control.path, mode: 'floating-preview', fallbackUrl: null };
    if (this.fallback && (await this.browser.context.pages()).some(p => p.pageId === this.fallback!.pageId)) return { page: this.fallback, framePath: null, mode: 'top-level', fallbackUrl: null };
    return { page, framePath: null, mode: 'new-tab-fallback', fallbackUrl: control.fallbackUrl };
  }

  private async probe<T>(surface: Surface, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const value = await surface.page.evaluate(async ({ nonce, framed, method, args }) => {
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
    }, { nonce: this.nonce, framed: !!surface.framePath, method, args });
    return value as T;
  }

  private async observe(surface: Surface, args: Record<string, unknown>) {
    if (surface.mode === 'new-tab-fallback') { this.observation = null; return { provider: 'stagehand', controlMode: surface.mode, fallbackUrl: surface.fallbackUrl, frames: [], hint: '请在受控模式的专用 Chrome 中展开 RealCode 网页预览；否则可打开 fallbackUrl。' }; }
    try { return await this.observeReady(surface, args); }
    catch (error) {
      if (surface.mode !== 'floating-preview' || !/浮窗文档未就绪|不支持脚本执行/.test(error instanceof Error ? error.message : String(error))) throw error;
      const url = await surface.page.evaluate(() => document.querySelector<HTMLIFrameElement>('#iframe-expanded')?.src ?? null);
      if (!url) throw error;
      this.blockedFrameUrl = url;
      this.observation = null;
      return { provider: 'stagehand', controlMode: 'new-tab-fallback', fallbackUrl: url, frames: [],
        hint: '嵌入页未提供可操作文档，可能被站点拒绝嵌入。请使用 browser.openTab 打开 fallbackUrl，在受控 Chrome 顶层页面操作。' };
    }
  }

  private async observeReady(surface: Surface, args: Record<string, unknown>) {
    const max = typeof args.maxActions === 'number' ? Math.min(500, Math.max(1, args.maxActions)) : 120;
    const maxText = typeof args.maxTextLength === 'number' ? Math.min(50000, Math.max(0, args.maxTextLength)) : 6000;
    const fingerprint = crypto.randomUUID();
    const observe = () => this.probe<Identity & { text: string; actions: Action[] }>(surface, 'observe', { fingerprint, maxActions: max, maxTextLength: maxText });
    let observed = await observe();
    for (let attempt = 0; attempt < 3 && !observed.actions.length && !observed.text.trim(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      observed = await observe();
    }
    const frameId = `${surface.page.pageId}:${observed.documentId}`;
    this.observation = { fingerprint, frameId, pageId: surface.page.pageId, mode: surface.mode, actions: observed.actions };
    let structure = '';
    try {
      const snapshot = await surface.page.snapshot({ includeIframes: true });
      structure = previewTree(snapshot.formattedTree, snapshot.xpathMap, surface.framePath).slice(0, maxText);
    } catch (error) {
      activityLog('stagehand', 'snapshot.unavailable', { reason: error instanceof Error ? error.name : 'Error' });
    }
    return { provider: 'stagehand', controlMode: surface.mode, fallbackUrl: null, frames: [{ frameId, state: {
      url: observed.url, fingerprint, text: observed.text, structure, actions: observed.actions,
    } }], limitations: '仅支持当前文档/单层浮窗的填写和点击；操作后需检查返回内容确认业务结果。' };
  }

  private async act(surface: Surface, args: Record<string, unknown>) {
    const observed = this.observation;
    if (!observed || observed.fingerprint !== args.fingerprint || observed.pageId !== surface.page.pageId || observed.mode !== surface.mode || (args.frameId && args.frameId !== observed.frameId)) throw new Error('STALE_PAGE: 控制目标或观察已变化，请重新观察');
    const action = observed.actions.find(item => item.id === args.actionId);
    if (!action) throw new Error('无效 actionId');
    if (action.kind === 'fill' && typeof args.text !== 'string') throw new Error('填写操作需要 text');
    const prepared = await this.probe<{ selector: string; documentId: string }>(surface, 'prepare', { fingerprint: observed.fingerprint, actionId: action.id });
    if (`${surface.page.pageId}:${prepared.documentId}` !== observed.frameId) throw new Error('STALE_PAGE: 文档已更换');
    if (surface.framePath) {
      const exposed = await surface.page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#iframe-expanded');
        if (!frame) return false;
        const rect = frame.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        return document.elementFromPoint(x, y) === frame;
      });
      if (!exposed) throw new Error('浮窗被会话弹层遮挡，请先关闭弹层');
    }
    const locator = surface.page.locator(`${surface.framePath ? '#iframe-expanded >> ' : ''}${prepared.selector}`);
    const previousPages = surface.mode === 'top-level' ? new Set((await this.browser!.context.pages()).map(page => page.pageId)) : null;
    if (action.kind === 'fill') await locator.fill(args.text as string);
    else await locator.click();
    this.observation = null;
    // 有界等待页面处理输入，业务完成由后续状态确认，不把 click 成功等同于任务完成。
    await new Promise(resolve => setTimeout(resolve, 150));
    if (previousPages) {
      const opened = (await this.browser!.context.pages()).filter(page => !previousPages.has(page.pageId));
      if (opened.length === 1) this.fallback = opened[0]!;
    }
    // 链接导航异步完成；立即观察可能返回旧文档，误导 Agent 连续点击旧 actionId。
    if (action.navigates) return { provider: 'stagehand', executed: true, actionId: action.id, needsObservation: true, navigationExpected: true };
    try { return { executed: true, actionId: action.id, ...await this.observe(await this.surface(), {}) }; }
    catch (error) { return { provider: 'stagehand', executed: true, actionId: action.id, needsObservation: true, observationError: error instanceof Error ? error.message : String(error) }; }
  }
}
