import { resolve } from 'node:path';
import { StagehandDriver } from '../../modules/agent-platform/src/browser-automation/stagehand-driver';

const article = 'https://news.sina.com.cn/c/2026-09-12/doc-inirputk6718450.shtml';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<!doctype html><meta charset="utf-8"><div id="iframe-modal"><iframe id="iframe-expanded" src="${article}" style="width:1100px;height:750px"></iframe></div>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
const driver = new StagehandDriver(`http://127.0.0.1:${server.port}`, resolve(import.meta.dirname, '../../workspace/.realcode/stagehand-sina-smoke'), true);
try {
  await driver.start();
  const started = performance.now();
  const observed = await driver.command('browser.observe', { maxActions: 80, maxTextLength: 4000 }) as any;
  const first = observed.frames?.[0];
  if (!first) throw new Error(`嵌入页不可访问：${JSON.stringify(observed)}`);
  const action = first.state.actions.find((item: { label: string }) => item.label.includes('梅姨案进入审判阶段'))
    ?? first.state.actions.find((item: { label: string }) => item.label === '新闻');
  if (!action) throw new Error(`未找到新闻链接：${JSON.stringify({ url: first.state.url, text: first.state.text?.slice(0, 200), actions: first.state.actions.slice(0, 20) })}`);
  const observeMs = Math.round(performance.now() - started);
  const actStarted = performance.now();
  const acted = await driver.command('browser.act', { frameId: first.frameId, fingerprint: first.state.fingerprint, actionId: action.id });
  const clickMs = Math.round(performance.now() - actStarted);
  await Bun.sleep(750);
  const settled = await driver.command('browser.observe', { maxActions: 20, maxTextLength: 300 });
  console.log(JSON.stringify({ observeMs, clickMs, urlBefore: first.state.url, actions: first.state.actions.length, clicked: action.label,
    needsObservation: acted.needsObservation, urlImmediatelyAfter: acted.frames?.[0]?.state.url, urlAfterWait: settled.frames?.[0]?.state.url,
    textAfterWait: settled.frames?.[0]?.state.text?.slice(0, 100) }, null, 2));
} finally {
  await driver.stop();
  await server.stop(true);
}
