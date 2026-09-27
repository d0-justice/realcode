import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { StagehandBrowser } from '@browserbasehq/stagehand';
import { BrowserBridge, isBrowserMethod } from '../../src/browser-automation/bridge';
import { BrowserAutomationService } from '../../src/browser-automation/service';

// 用真实跨域 iframe 验证驱动协议、遮挡保护、节点替换与导航，不调用模型。
const bridge = new BrowserBridge();
let automation: BrowserAutomationService;
let normalLaunchFails = true;
let blockedPreview = false;
const server = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/ready') {
    return Response.json({ ok: automation.handoff.acknowledge(url.searchParams.get('token')) });
  }
  if (url.pathname === '/ui') return new Response(Bun.file(resolve(import.meta.dirname, '../../public/index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (['/styles.css', '/extras.css', '/fenix-theme.css'].includes(url.pathname)) return new Response(Bun.file(resolve(import.meta.dirname, `../../public${url.pathname}`)), { headers: { 'content-type': 'text/css; charset=utf-8' } });
  if (url.pathname === '/app.js') return new Response('', { headers: { 'content-type': 'application/javascript' } });
  if (url.pathname === '/command') {
    if (request.headers.get('authorization') !== `Bearer ${bridge.internalSecret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      const { method, args } = await request.json();
      if (!isBrowserMethod(method)) throw new Error('Invalid method');
      return Response.json({ result: await automation.command(method, args) });
    } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  }
  const parent = `<div id="iframe-modal"><iframe id="iframe-expanded" name="realcode-floating-preview" style="width:100%;height:600px" src="http://localhost:${server.port}/${blockedPreview ? 'blocked' : 'child'}"></iframe></div>
    <script>const token=new URL(location.href).searchParams.get('handoff');if(token)fetch('/ready?token='+encodeURIComponent(token));</script>`;
  const child = `<meta charset="utf-8"><label>搜索<input id="q"></label><button id="submit">搜索</button><div id="result"></div>
    <video id="sample-video"></video><span id="video-state">未播放</span><button id="play-video">手动播放</button>
    <iframe src="/nested-video" referrerpolicy="no-referrer"></iframe><span id="nested-video-state">嵌套视频未播放</span>
    <button id="cover">遮挡</button><button id="replace">替换输入框</button><a href="/next" target="_blank">下一页</a>
    <script>
      document.querySelector('#submit').onclick=()=>document.querySelector('#result').textContent='搜索结果：'+document.querySelector('#q').value;
      const video=document.querySelector('#sample-video');
      Object.defineProperty(video,'paused',{get:()=>false});
      video.pause=()=>document.querySelector('#video-state').textContent='默认暂停';
      video.dispatchEvent(new Event('play'));
      document.querySelector('#play-video').onclick=()=>{document.querySelector('#video-state').textContent='手动播放中';video.dispatchEvent(new Event('play'))};
      addEventListener('message',event=>{if(event.data==='nested-paused')document.querySelector('#nested-video-state').textContent='嵌套视频已暂停'});
      document.querySelector('#cover').onclick=()=>{const overlay=document.createElement('div');overlay.style='position:fixed;inset:0;background:white;z-index:99';overlay.textContent='已遮挡';document.body.append(overlay);setTimeout(()=>overlay.remove(),1500)};
      document.querySelector('#replace').onclick=()=>{const old=document.querySelector('#q');old.replaceWith(old.cloneNode())};
    </script>`;
  if (url.pathname === '/blocked') return new Response(child, { headers: { 'content-type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' } });
  if (url.pathname === '/nested-video') return new Response(`<video id="nested"></video><script>
    const video=document.querySelector('#nested');
    Object.defineProperty(video,'paused',{get:()=>false});
    video.pause=()=>parent.postMessage('nested-paused','*');
    video.dispatchEvent(new Event('play'));
  </script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return new Response(url.pathname === '/' ? parent : url.pathname === '/child' ? child : '<h1>导航完成</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
} });
automation = new BrowserAutomationService(bridge, `http://127.0.0.1:${server.port}`, resolve(import.meta.dirname, '../../workspace/.realcode/stagehand-integration-test'), true, async url => {
  // 普通 Chrome 启动器用回执替身，避免集成测试打开用户日常浏览器；受控浏览器仍是真实 Chrome。
  assert.equal(automation.status().connected, true, '目标就绪前必须保留原受控浏览器');
  if (normalLaunchFails) throw new Error('模拟普通浏览器启动失败');
  const token = new URL(url).searchParams.get('handoff');
  const response = await fetch(`http://127.0.0.1:${server.port}/ready?token=${token}`);
  assert.equal((await response.json()).ok, true);
});
const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../src/browser-automation/mcp-server.ts')], {
  env: { ...process.env, REALCODE_BROWSER_API: `http://127.0.0.1:${server.port}/command`, REALCODE_BROWSER_SECRET: bridge.internalSecret },
  stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const reader = createInterface({ input: child.stdout! });
reader.on('line', line => {
  const message = JSON.parse(line);
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error || message.result?.isError) item.reject(new Error(message.error?.message || message.result.content[0].text));
  else item.resolve(message.result.structuredContent ?? message.result);
});
const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out')); }, 25000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const driver = { command: (method: string, args: unknown) => request('tools/call', { name: method.replace('.', '_'), arguments: args }) };
const results = [];
type State = { frames: Array<{ frameId: string; state: { fingerprint: string; text: string; structure: string; actions: Array<{ id: string; kind: string; label: string }> } }> };
const observe = async () => await driver.command('browser.observe', {}) as State;
async function act(observed: State, label: string, text?: string) {
  const frame = observed.frames[0]!;
  const action = frame.state.actions.find(a => a.label === label && (text === undefined || a.kind === 'fill'));
  assert.ok(action, `Missing action ${label}: ${JSON.stringify(frame.state.actions)}`);
  const result = await driver.command('browser.act', { frameId: frame.frameId, fingerprint: frame.state.fingerprint, actionId: action.id, ...(text === undefined ? {} : { text }) }) as State & { needsObservation?: boolean };
  if (!result.needsObservation) return result;
  await new Promise(resolve => setTimeout(resolve, 250));
  return await observe();
}
try {
  // 普通模式禁止浏览器动作，不能暗中回退到已隐藏的旧扩展驱动。
  assert.equal(automation.status().provider, 'normal');
  await assert.rejects(() => automation.command('browser.observe', {}), /普通模式/);
  results.push('normal-mode-blocks-browser-actions');
  const switching = automation.select('stagehand', true);
  await assert.rejects(() => automation.select('stagehand', true), /正在执行/);
  await switching;
  results.push('target-page-ready-and-concurrent-switch-rejected');
  const controlledContext = (automation as unknown as { stagehand: { browser: StagehandBrowser } }).stagehand.browser.context;
  const startupPages = await controlledContext.pages();
  const startupUrls = await Promise.all(startupPages.map(page => page.url()));
  assert.equal(startupUrls.filter(url => url === 'about:blank').length, 0, `受控浏览器遗留空白标签：${startupUrls.join(', ')}`);
  results.push('controlled-startup-has-no-blank-tab');
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
  let state = await observe();
  assert.ok(state.frames[0]?.state.actions.length);
  assert.match(state.frames[0]!.state.structure, /textbox|button/);
  assert.doesNotMatch(state.frames[0]!.state.structure, /RealCode.*会话/);
  results.push('cross-origin-observation');
  assert.match(state.frames[0]!.state.text, /默认暂停/);
  assert.match(state.frames[0]!.state.text, /嵌套视频已暂停/);
  state = await act(state, '手动播放');
  assert.match(state.frames[0]!.state.text, /手动播放中/);
  results.push('embedded-and-nested-video-paused-until-user-play');
  state = await act(state, '搜索', '亚索');
  const frame = state.frames[0]!;
  const click = frame.state.actions.find(a => a.label === '搜索' && a.kind === 'click')!;
  state = await driver.command('browser.act', { frameId: frame.frameId, fingerprint: frame.state.fingerprint, actionId: click.id }) as State;
  assert.match(state.frames[0]!.state.text, /搜索结果：亚索/);
  results.push('fill-click-result');
  await assert.rejects(() => driver.command('browser.act', { fingerprint: frame.state.fingerprint, actionId: click.id }), /STALE_PAGE/);
  results.push('old-observation-rejected');
  state = await act(state, '遮挡');
  await assert.rejects(() => act(state, '搜索', '不应输入'), /遮挡/);
  results.push('covered-target-rejected');
  await new Promise(resolve => setTimeout(resolve, 1600));
  state = await observe();
  state = await act(state, '下一页');
  if (!state.frames) state = await observe();
  assert.match(state.frames[0]!.state.text, /导航完成/);
  results.push('blank-link-stays-in-frame');
  // 切回普通模式必须关闭专用浏览器，并撤销后续工具操作能力。
  await assert.rejects(() => automation.select('normal', true), /模拟普通浏览器启动失败/);
  assert.equal(automation.status().provider, 'stagehand');
  assert.equal(automation.status().connected, true);
  assert.match((await observe()).frames[0]!.state.text, /导航完成/);
  results.push('failed-normal-launch-preserves-controlled-page');
  normalLaunchFails = false;
  await automation.select('normal', true);
  assert.equal(automation.status().connected, false);
  await assert.rejects(() => observe(), /普通模式/);
  results.push('return-to-normal-disables-control');
  blockedPreview = true;
  await automation.select('stagehand');
  const blocked = await observe() as State & { controlMode: string; fallbackUrl: string };
  assert.equal(blocked.controlMode, 'new-tab-fallback');
  assert.match(blocked.fallbackUrl, /\/blocked$/);
  const topLevel = await request('tools/call', { name: 'browser_open_tab', arguments: { url: blocked.fallbackUrl } }) as State;
  assert.ok(topLevel.frames[0]?.state.actions.some(action => action.label === '搜索'));
  const filledTopLevel = await act(topLevel, '搜索', '亚索');
  const topFrame = filledTopLevel.frames[0]!;
  const searchButton = topFrame.state.actions.find(action => action.label === '搜索' && action.kind === 'click')!;
  const clickedTopLevel = await driver.command('browser.act', { frameId: topFrame.frameId, fingerprint: topFrame.state.fingerprint, actionId: searchButton.id }) as State;
  assert.match(clickedTopLevel.frames[0]!.state.text, /搜索结果：亚索/);
  const uiPage = (automation as unknown as { stagehand: { owner: { goto(url: string): Promise<void>; setViewportSize(width: number, height: number): Promise<void>; evaluate<T>(fn: () => T): Promise<T> } } }).stagehand.owner;
  await uiPage.goto(`http://127.0.0.1:${server.port}/ui`);
  for (const width of [1280, 500, 375]) {
    await uiPage.setViewportSize(width, 800);
    const layout = await uiPage.evaluate(() => {
      const status = document.querySelector('#browser-mode-status')!;
      const toggle = document.querySelector('#browser-mode-toggle')!;
      const trace = document.querySelector('#trace-toggle')!;
      const bounds = document.querySelector('.conversation')!.getBoundingClientRect();
      return { modalRemoved: !document.querySelector('#browser-modal'), restartRemoved: !document.querySelector('#browser-mode-restart'), mode: status.textContent?.trim(),
        action: toggle.textContent?.trim(), grouped: status.parentElement?.classList.contains('browser-mode-group') && toggle.parentElement === status.parentElement,
        controlsInside: [status, toggle, trace].every(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        }), bounds: { left: bounds.left, right: bounds.right }, controls: [status, toggle, trace].map(node => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }) };
    });
    assert.equal(layout.modalRemoved, true);
    assert.equal(layout.restartRemoved, true);
    assert.equal(layout.mode, '普通模式');
    assert.equal(layout.action, '切换');
    assert.equal(layout.grouped, true);
    assert.equal(layout.controlsInside, true, `顶部按钮超出 ${width}px 视口：${JSON.stringify(layout)}`);
  }
  results.push('mode-controls-visible-without-dialog-at-three-widths');
  await automation.select('normal');
  results.push('blocked-iframe-top-level-search-result');
  console.log(JSON.stringify({ passed: results }, null, 2));
} finally { child.stdin!.end(); reader.close(); child.kill(); await automation.shutdown(); await server.stop(true); }
