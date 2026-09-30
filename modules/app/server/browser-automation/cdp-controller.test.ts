import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CdpController } from './cdp-controller';

let parent: ReturnType<typeof Bun.serve>;
let child: ReturnType<typeof Bun.serve>;
let controller: CdpController;
let workspace: string;
const toolChanges: Array<{ frameId: string; added: string[]; removed: string[] }> = [];

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'realcode-cdp-test-'));
  child = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch() {
    return new Response(`<input id="query"><button id="go" onclick="document.querySelector('#result').textContent = document.querySelector('#query').value">Go</button><output id="result"></output><button id="unregister" onclick="window.__registrationController.abort()">Unregister</button>
      <script>window.__registration='pending';window.__registrationController=new AbortController();document.modelContext?.registerTool({name:'site.echo',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:async ({value})=>({echo:value})},{signal:window.__registrationController.signal}).then(()=>window.__registration='registered').catch(error=>window.__registration=String(error));</script>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  parent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(`<div id="iframe-modal"><iframe id="iframe-expanded" src="http://127.0.0.2:${child.port}/" sandbox="allow-scripts allow-forms" allow="tools" style="width:600px;height:400px"></iframe></div>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  controller = new CdpController(`http://127.0.0.1:${parent.port}`, workspace, true, change => toolChanges.push(change));
  await controller.start();
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const listing: any = await controller.command('browser.site', { operation: 'tools' });
      if (listing.tools?.some((tool: { name: string }) => tool.name === 'site.echo')) return;
    } catch { /* Cross-origin frame may still be attaching. */ }
    await Bun.sleep(100);
  }
  throw new Error('WebMCP fixture did not become ready');
});

afterAll(async () => {
  await controller?.stop();
  parent?.stop(); child?.stop();
  if (workspace?.startsWith(resolve(tmpdir()) + '\\')) await rm(workspace, { recursive: true, force: true });
});

test('observes and controls a sandboxed cross-origin floating iframe', async () => {
  let result: any;
  for (let attempt = 0; attempt < 20; attempt++) {
    result = await controller.command('browser.observe', { maxActions: 10, maxTextLength: 100 });
    if (result.frames?.[0]?.state?.actions?.length) break;
    await Bun.sleep(100);
  }
  expect(result.controlMode).toBe('floating-preview');
  const state = result.frames[0].state;
  expect(state.actions.map((action: { label: string }) => action.label)).toContain('Go');
  const input = state.actions.find((action: { kind: string }) => action.kind === 'fill');
  const filled: any = await controller.command('browser.act', { actionId: input.id, fingerprint: state.fingerprint, frameId: result.frames[0].frameId, text: '亚索' });
  expect(filled.executed).toBe(true);
  const next = filled.frames[0].state;
  const button = next.actions.find((action: { label: string }) => action.label === 'Go');
  const clicked: any = await controller.command('browser.act', { actionId: button.id, fingerprint: next.fingerprint, frameId: filled.frames[0].frameId });
  expect(clicked.frames[0].state.text).toContain('亚索');
});

test('discovers and invokes a site-owned WebMCP tool in the selected iframe', async () => {
  let listing: any;
  for (let attempt = 0; attempt < 20; attempt++) {
    listing = await controller.command('browser.site', { operation: 'tools' });
    if (listing.tools?.some((tool: { name: string }) => tool.name === 'site.echo')) break;
    await Bun.sleep(100);
  }
  expect(listing.tools).toContainEqual(expect.objectContaining({ name: 'site.echo', source: 'site' }));
  const called: any = await controller.command('browser.site', { operation: 'call', name: 'site.echo', args: { value: 'works' } });
  expect(called.output).toEqual({ echo: 'works' });
});

test('removes a withdrawn WebMCP tool and reports the tool change', async () => {
  const observed: any = await controller.command('browser.observe', { maxActions: 10, maxTextLength: 100 });
  const state = observed.frames[0].state;
  const action = state.actions.find((item: { label: string }) => item.label === 'Unregister');
  expect(action).toBeDefined();
  await controller.command('browser.act', { actionId: action.id, fingerprint: state.fingerprint, frameId: observed.frames[0].frameId });
  let listing: any;
  for (let attempt = 0; attempt < 20; attempt++) {
    listing = await controller.command('browser.site', { operation: 'tools' });
    if (!listing.tools.some((tool: { name: string }) => tool.name === 'site.echo')) break;
    await Bun.sleep(100);
  }
  expect(listing.tools.some((tool: { name: string }) => tool.name === 'site.echo')).toBe(false);
  expect(toolChanges.some(change => change.removed.includes('site.echo'))).toBe(true);
});
