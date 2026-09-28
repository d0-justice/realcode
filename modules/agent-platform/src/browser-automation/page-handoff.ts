import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 页面加载回执；令牌只用于一次切换，不作为浏览器控制凭据。 */
export class PageHandoff {
  private pending: { token: string; resolve: () => void } | null = null;

  acknowledge(token: unknown) {
    if (!this.pending || token !== this.pending.token) return false;
    this.pending.resolve();
    this.pending = null;
    return true;
  }

  async open(origin: string, launch: (url: string) => Promise<void>, timeoutMs = 30000) {
    if (this.pending) throw new Error('页面正在切换，请稍候');
    const token = crypto.randomUUID();
    const url = new URL(origin);
    url.searchParams.set('handoff', token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.pending = { token, resolve };
      timer = setTimeout(() => reject(new Error('目标页面未确认就绪，未关闭原页面，请重试')), timeoutMs);
    });
    // 先注册等待，再启动页面，避免快速加载的回执丢失。
    try { await Promise.all([ready, launch(url.href)]); }
    finally { clearTimeout(timer); this.pending = null; }
  }
}

/** 不传专用 profile 或调试参数，让 Chrome 将页面交给普通浏览器实例。 */
export async function openNormalChrome(url: string) {
  const candidates = [process.env.CHROME_PATH, ...(process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter((root): root is string => Boolean(root)).map(root => join(root, 'Google/Chrome/Application/chrome.exe'))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])];
  const executable = candidates.find(path => path && existsSync(path));
  if (!executable) throw new Error('未找到普通 Chrome，请配置 CHROME_PATH 后重试');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--new-tab', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
