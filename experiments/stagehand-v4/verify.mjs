import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { localBrowser, Stagehand } from '@browserbasehq/stagehand';
import { startFixture } from './fixture.mjs';
import { availablePort, inspectBrowser } from './probe.mjs';

const output = resolve(import.meta.dirname, '../../workspace/.realcode/stagehand-v4');
await mkdir(output, { recursive: true });
const mode = process.argv.includes('--without-extension-debugging') ? 'no-extension-debugging' : 'standard';
const results = { at: new Date().toISOString(), sdk: '4.1.0', mode, tests: [], limitations: ['No LLM calls', 'Local fixtures, not arbitrary live websites'] };
let browser;
let stagehand;
let page;
const fixture = await startFixture();
const port = await availablePort();

async function check(name, run) {
  const started = performance.now();
  try {
    const details = await run();
    const result = { name, status: 'passed', durationMs: Math.round(performance.now() - started), details };
    results.tests.push(result);
    console.log(JSON.stringify(result));
    return true;
  } catch (error) {
    const result = { name, status: 'failed', durationMs: Math.round(performance.now() - started), error: String(error.stack || error) };
    results.tests.push(result);
    console.log(JSON.stringify(result));
    return false;
  }
}

async function waitEvent(kind, value) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const event = await page.evaluate(({ kind, value }) => window.fixtureEvents.find(e => e.kind === kind && (value === null || e.value === value)) ?? null, { kind, value: value ?? null });
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Expected fixture event: ${kind}`);
}

try {
  // 验证原版扩展能在独立 Chrome 配置中加载，不影响用户浏览器。
  const launched = await check('official-runtime-launch', async () => {
    browser = await localBrowser.launch({
      headless: true,
      port,
      executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      userDataDir: resolve(output, `profile-${mode}-${Date.now()}`),
      args: ['--site-per-process', '--enable-automation'],
      ...(mode === 'no-extension-debugging' ? { ignoreDefaultArgs: ['--enable-unsafe-extension-debugging'] } : {}),
    });
    stagehand = await Stagehand.create({ browser });
    page = await browser.context.newPage();
    return { initialized: stagehand.initialized };
  });
  if (launched) {
    // 验证跨域页面真实隔离，普通父页面 JS 无法访问 iframe DOM。
    const ready = await check('cross-site-frame-isolation', async () => {
      await page.goto(fixture.url);
      await waitEvent('loaded');
      await waitEvent('nested-ready');
      const denied = await page.evaluate(() => {
        try { return !document.querySelector('#cross').contentWindow.document; }
        catch (e) { return e.name === 'SecurityError'; }
      });
      assert.equal(denied, true);
      return { parentDOMAccessDenied: denied };
    });
    if (ready) {
      // 确认命令行对照组生效，并记录实际存在的跨进程 iframe target。
      await check('actual-browser-configuration', async () => {
        const info = await inspectBrowser(port);
        assert.equal(info.unsafeExtensionDebugging, mode !== 'no-extension-debugging');
        assert.ok(info.frames.some(frame => frame.url.endsWith('/form')));
        return info;
      });
      // 验证 SDK 当前支持的 console 事件订阅确实推送通知。
      await check('console-event-subscription', async () => {
        let received;
        const subscription = await page.on('console', event => { received = event; });
        try {
          await page.evaluate(() => console.log('stagehand-fixture-event'));
          const deadline = Date.now() + 2000;
          while (!received && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(received?.method, 'Runtime.consoleAPICalled');
          return { method: received.method };
        } finally { await subscription.unsubscribe(); }
      });
      // 验证不截图的结构化观察包含跨域 iframe 的搜索控件。
      await check('cross-frame-structured-snapshot', async () => {
        const snapshot = await page.snapshot();
        await writeFile(resolve(output, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
        assert.match(snapshot.formattedTree, /搜索/);
        return { characters: snapshot.formattedTree.length };
      });
      // 显式等待子页面控件就绪，再区分快照遗漏是否仅由首次加载时序引起。
      await check('cross-frame-snapshot-after-ready', async () => {
        await page.waitForSelector('#cross >> #query', { timeout: 3000 });
        const snapshot = await page.snapshot();
        await writeFile(resolve(output, 'snapshot-ready.json'), JSON.stringify(snapshot, null, 2));
        assert.match(snapshot.formattedTree, /搜索/);
        assert.match(snapshot.formattedTree, /Nested action/);
        return { characters: snapshot.formattedTree.length };
      });
      // 验证无关推荐区域持续变化时，填写及提交结果仍然正确。
      await check('fill-submit-with-live-dom-noise', async () => {
        await page.locator('#cross >> #query').fill('亚索');
        assert.equal(await page.locator('#cross >> #query').inputValue(), '亚索');
        const input = await waitEvent('input', '亚索');
        await page.locator('#cross >> #search').click();
        const event = await waitEvent('result', '亚索');
        assert.equal(await page.locator('#cross >> #result').textContent(), '结果：亚索');
        return { inputTrusted: input.trusted, result: event.value };
      });
      // 验证同一个定位器在框架替换节点后能重新定位输入框。
      await check('input-node-replacement', async () => {
        const input = page.locator('#cross >> #query');
        await page.locator('#cross >> #replace').click();
        await input.fill('节点替换后');
        assert.equal(await input.inputValue(), '节点替换后');
      });
      // 验证两层跨域 iframe 内的按钮可以被定位并实际触发事件。
      await check('nested-cross-site-frame', async () => {
        await page.locator('#cross >> #nested >> #nested-button').click();
        await waitEvent('nested');
      });
      // 验证扩展能访问 closed Shadow DOM 并执行按钮行为。
      await check('closed-shadow-root', async () => {
        await page.locator('#cross >> #shadow-button').click();
        await waitEvent('shadow');
      });
      // 验证被遮挡的搜索按钮不会误触发提交。
      await check('covered-target-protection', async () => {
        await page.locator('#cross >> #block').click();
        const before = await page.evaluate(() => fixtureEvents.filter(e => e.kind === 'result').length);
        let rejected = false;
        try { await page.locator('#cross >> #search').click(); }
        catch { rejected = true; }
        await new Promise(resolve => setTimeout(resolve, 250));
        const after = await page.evaluate(() => fixtureEvents.filter(e => e.kind === 'result').length);
        const overlayClicked = await page.evaluate(() => fixtureEvents.some(e => e.kind === 'overlay-click'));
        await page.locator('#cross >> #dismiss').click();
        assert.equal(rejected, true, `click reported success; overlay received click: ${overlayClicked}`);
        assert.equal(after, before);
        return { rejected, overlayClicked, unintendedSubmissions: after - before };
      });
      // 验证浏览器侧批量填写、点击与结果读取，避免每个动作调用模型。
      await check('browser-side-batch', async () => {
        const value = await stagehand.experimentalBatch(async ({ context }, input) => {
          const pages = await context.pages();
          const target = pages.find(p => p.pageId === input.pageId);
          await target.locator('#cross >> #query').fill('批量验证');
          await target.locator('#cross >> #search').click();
          return await target.locator('#cross >> #query').inputValue();
        }, { pageId: page.pageId }, { page, timeout: 10000 });
        assert.equal(value, '批量验证');
        await waitEvent('result', '批量验证');
      });
      // 核实 target=_blank 的默认策略，避免误认为 SDK 会自动强制 iframe 内跳转。
      await check('blank-link-opens-new-tab', async () => {
        const before = await browser.context.pages();
        await page.locator('#cross >> #blank').click();
        let opened;
        const deadline = Date.now() + 3000;
        while (!opened && Date.now() < deadline) {
          opened = (await browser.context.pages()).find(candidate => !before.some(p => p.pageId === candidate.pageId));
          if (!opened) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(opened, 'Expected a new tab from target=_blank');
        await opened.close();
        return { newTab: true, requiresRealCodeNavigationPolicy: true };
      });
      // 验证点击链接只导航 iframe，父页和标签页数量保持稳定。
      await check('in-frame-navigation', async () => {
        const before = (await browser.context.pages()).length;
        await page.locator('#cross >> #next').click();
        await waitEvent('navigated');
        assert.equal(await page.locator('#cross >> #destination').textContent(), 'Navigation successful');
        assert.equal(await page.url(), fixture.url);
        assert.equal((await browser.context.pages()).length, before);
      });
    }
  }
} finally {
  if (stagehand) await check('runtime-cleanup', () => stagehand.close());
  if (browser) await check('browser-cleanup', () => browser.close());
  await fixture.close();
  await writeFile(resolve(output, `${mode}.json`), JSON.stringify(results, null, 2));
  console.log(`Report: ${resolve(output, `${mode}.json`)}`);
}
if (results.tests.some(test => test.status === 'failed')) process.exitCode = 1;
