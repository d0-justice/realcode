import type { BrowserMethod } from './browser-method';
import { CdpController } from './cdp-controller';
import { activityLog } from './activity-log';
import { PageHandoff, openNormalChrome } from './page-handoff';

type Event = { type: string; at: string; data: unknown };

/** 在普通模式和受控模式间切换，普通模式不派发浏览器操作。 */
export class BrowserAutomationService {
  readonly handoff = new PageHandoff();
  private provider: 'normal' | 'cdp' = 'normal';
  private ready = false;
  private working = false;
  private error: string | null = null;
  private pageState: unknown = null;
  private listeners = new Set<(event: Event) => void>();
  private readonly controller: CdpController;

  constructor(private readonly origin: string, workspace: string, headless = false,
    private readonly openNormal: (url: string) => Promise<void> = openNormalChrome) {
    this.controller = new CdpController(origin, workspace, headless,
      change => this.emit('browser_tools_changed', change),
      change => this.emit('browser_site_state', change));
  }

  /** 返回当前真正处理 Agent 工具的引擎状态。 */
  status() {
    if (this.provider === 'normal') return { provider: this.provider, connected: false, authenticated: false, selectedTabId: null, pendingCommands: 0, switching: this.working, error: this.error };
    return { provider: this.provider, connected: this.ready, authenticated: this.ready, selectedTabId: null,
      runtime: 'Chrome CDP', pendingCommands: this.working ? 1 : 0, switching: this.working, error: this.error };
  }

  /** 缓存供调试面板读取的最近一次结构化观察。 */
  latestPageState() { return this.provider === 'normal' ? null : this.pageState; }

  /** List only tools belonging to the page the agent can currently control. */
  async siteTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    if (this.provider !== 'cdp' || !this.ready) return [];
    const result = await this.controller.listSiteTools();
    return result.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const tool = value as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== 'string' || !tool.name || typeof tool.description !== 'string') return [];
      const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema as Record<string, unknown> : { type: 'object', properties: {} };
      return [{ name: tool.name, description: tool.description, inputSchema }];
    });
  }

  /** 订阅执行阶段与状态，复用 RealCode 的 SSE 通道。 */
  subscribe(listener: (event: Event) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private emit(type: string, data: unknown) {
    for (const listener of this.listeners) listener({ type, at: new Date().toISOString(), data });
  }

  /** 通过显式操作切换驱动，执行期间禁止更换控制目标。 */
  async select(provider: 'normal' | 'cdp', transferPage = false) {
    if (this.working) throw new Error('浏览器正在执行操作，请完成后再切换');
    this.working = true; this.error = null;
    this.emit('browser_status', this.status());
    try {
      if (provider === 'cdp') {
        this.provider = provider; this.ready = false;
        this.emit('browser_status', this.status());
        await this.controller.stop();
        if (transferPage) await this.handoff.open(this.origin, url => this.controller.start(url));
        else await this.controller.start();
        this.ready = true;
      } else {
        if (transferPage && this.provider !== 'normal') await this.handoff.open(this.origin, this.openNormal);
        await this.controller.stop(); this.ready = false; this.provider = provider;
      }
      this.pageState = null;
      activityLog('cdp', 'provider.changed', { provider });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      if (provider === 'cdp') { this.ready = false; await this.controller.stop(); }
      throw error;
    } finally {
      this.working = false;
      this.emit('browser_status', this.status());
      this.emit('browser_tools_changed', { frameId: null, added: [], removed: [], reason: 'provider_changed' });
    }
    return this.status();
  }

  /** 发送工具命令；超时时关闭专用浏览器，使旧动作不能在后台继续执行。 */
  async command(method: BrowserMethod, args: Record<string, unknown>) {
    if (this.working) throw new Error('浏览器正在执行操作，请勿并发发送命令');
    if (this.provider === 'normal') throw new Error('当前为普通模式。请先点击“进入受控模式”，在打开的专用 Chrome 中展开网页预览。');
    if (!this.ready) throw new Error('受控模式未就绪，请在浏览器面板重新启动');
    this.working = true;
    const id = crypto.randomUUID();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.emit('browser_command', { id, provider: 'cdp', phase: 'executing' });
    activityLog('cdp', 'command.started', { id, method });
    try {
      const result = await Promise.race([
        this.controller.command(method, args),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('受控模式操作超时，已停止本次控制，请重新启动')),
          method === 'browser.site' && args.name === 'realcode.bilibili.searchAndPlay' ? 45000 : 15000); }),
      ]);
      this.pageState = { receivedAt: new Date().toISOString(), commandId: id, state: result };
      this.error = null;
      this.emit('browser_page_state', this.pageState);
      this.emit('browser_command', { id, provider: 'cdp', phase: 'completed', durationMs: Date.now() - started });
      activityLog('cdp', 'command.completed', { id, method, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error = message;
      if (/超时|closed|disconnected|标签页已关闭|已离开 RealCode/i.test(message)) {
        this.ready = false;
        try { await this.controller.stop(); } catch (cleanupError) { activityLog('cdp', 'cleanup.failed', { error: cleanupError instanceof Error ? cleanupError.name : 'Error' }); }
      }
      this.emit('browser_command', { id, provider: 'cdp', phase: 'failed', durationMs: Date.now() - started });
      activityLog('cdp', 'command.failed', { id, method, durationMs: Date.now() - started });
      throw error;
    } finally { clearTimeout(timer); this.working = false; this.emit('browser_status', this.status()); }
  }

  /** 服务退出时只清理其拥有的浏览器。 */
  async shutdown() { this.ready = false; await this.controller.stop(); }
}
