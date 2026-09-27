import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBrowser, Stagehand } from '@browserbasehq/stagehand';
import { startFixture } from './fixture.mjs';
import { availablePort } from './probe.mjs';

const fixture = await startFixture();
const profile = await mkdtemp(join(tmpdir(), 'realcode-stagehand-locator-'));
let browser;
let runtime;
try {
  browser = await localBrowser.launch({ headless: true, port: await availablePort(),
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    userDataDir: profile,
    args: ['--site-per-process', '--enable-automation'] });
  console.log('launched');
  runtime = await Stagehand.create({ browser });
  console.log('runtime');
  const page = await browser.context.newPage();
  await page.goto(fixture.url);
  console.log('navigated');
  const input = page.locator('#cross >> xpath=/html[1]/body[1]/form[1]/label[1]/input[1]');
  await input.fill('native xpath');
  assert.equal(await input.inputValue(), 'native xpath');
  const snapshot = await page.snapshot({ includeIframes: true });
  assert.match(snapshot.formattedTree, /native xpath|textbox/);
  console.log(JSON.stringify({ nativeCrossFrameLocator: true, snapshotCharacters: snapshot.formattedTree.length }));
} finally {
  try { await runtime?.close(); } catch (error) { console.error('runtime close:', error); }
  try { await browser?.close(); } catch (error) { console.error('browser close:', error); }
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
