import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve(import.meta.dir, 'bilibili-site-hook.js'), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture({ url = 'https://www.bilibili.com/', readyState = 'complete', iframe = false, toolsDenied = false } = {}) {
  const listeners = new Map();
  const registered = new Map();
  const messages = [];
  const navigations = [];
  const statusEvents = [];
  let toolChanges = 0;
  let mutation;
  const site = { title: '', readyState, searchLoaded: false, captcha: false, login: 'unknown', videoTitle: '', anchors: [], video: null, editors: [], activeEditor: null };
  const location = {
    ...new URL(url),
    href: url,
    hostname: new URL(url).hostname,
    pathname: new URL(url).pathname,
    assign(next) { navigations.push(next); Object.assign(location, { href: next, hostname: new URL(next).hostname, pathname: new URL(next).pathname }); },
  };
  const modelContext = {
    registerTool(tool, options) {
      toolChanges++;
      if (toolsDenied) return Promise.reject(new Error('NotAllowedError: Access to the feature "tools" is disallowed by permissions policy.'));
      registered.set(tool.name, { tool, options });
      options.signal.addEventListener('abort', () => { registered.delete(tool.name); toolChanges++; }, { once: true });
      return Promise.resolve();
    },
  };
  const document = {
    modelContext,
    documentElement: {},
    get title() { return site.title; },
    get readyState() { return site.readyState; },
    querySelector(selector) {
      if (selector.includes('#risk-captcha-app')) return site.captcha ? {} : null;
      if (selector.includes('header .header-avatar-wrap')) return site.login === 'signed_in' ? {} : null;
      if (selector.includes('header .header-login-entry')) return site.login === 'signed_out' ? {} : null;
      if (selector.includes('a[href*="/video/BV"],')) return site.anchors[0] || (site.searchLoaded ? {} : null);
      if (selector.includes('h1')) return site.videoTitle ? { textContent: site.videoTitle, getAttribute: () => site.videoTitle } : null;
      if (selector === 'video') return site.video;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href*="/video/BV"]') return site.anchors;
      if (selector.startsWith('textarea,input:not([type])')) return site.editors;
      return [];
    },
    execCommand(command, _showUI, text) {
      if (command !== 'insertText' || !site.activeEditor) return false;
      if (site.activeEditor.isContentEditable) site.activeEditor.textContent += text;
      else site.activeEditor.value += text;
      return true;
    },
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
    createRange() { return { selectNodeContents() {}, collapse() {} }; },
  };
  const parent = { postMessage(message) { messages.push(message); } };
  const window = {
    location, document, parent: iframe ? parent : null,
    addEventListener(type, callback) { const set = listeners.get(type) || new Set(); set.add(callback); listeners.set(type, set); },
    setTimeout, clearTimeout,
  };
  window.top = iframe ? {} : window;
  window.parent ||= window;
  const sandbox = { window, top: window.top, parent: window.parent, location, document, URL, Event, AbortController,
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    setTimeout, clearTimeout, addEventListener: window.addEventListener.bind(window), dispatchEvent: () => true, console,
    __realcodeSiteStateChanged(payload) { statusEvents.push(JSON.parse(payload)); } };
  runInNewContext(`${source}\ninstallBilibiliSiteHook('test-nonce', 'http://127.0.0.1:4173');`, sandbox);
  return {
    site, location, parent, registered, messages, navigations, statusEvents,
    get toolChanges() { return toolChanges; },
    emit(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
    mutate() { mutation?.(); },
    names() { return [...registered.keys()].sort(); },
    call(name, input, context) { return registered.get('realcode.bilibili.' + name).tool.execute(input, context); },
    anchor(id, title) {
      return { href: 'https://www.bilibili.com/video/' + id + '/', textContent: title,
        getAttribute: () => title, closest: () => null, querySelector: () => null };
    },
    editor(value = '', rich = false) {
      return { value, textContent: value, isConnected: true, isContentEditable: rich, tagName: rich ? 'DIV' : 'TEXTAREA',
        matches: () => false, closest: () => null, getAttribute: () => null,
        getClientRects: () => [{}], checkVisibility: () => true,
        focus() { site.activeEditor = this; }, setSelectionRange() {} };
    },
  };
}

test('registers only tools available in the current state and retracts them on navigation and captcha', async () => {
  const f = fixture();
  expect(f.names()).toEqual(['realcode.bilibili.searchAndPlay', 'realcode.bilibili.searchVideos']);
  expect(f.registered.get(f.names()[0]).options.exposedTo).toEqual(['http://127.0.0.1:4173']);
  const initialChanges = f.toolChanges;

  f.location.href = 'https://search.bilibili.com/all?keyword=yasuo';
  f.location.hostname = 'search.bilibili.com';
  f.location.pathname = '/all';
  f.site.searchLoaded = true;
  f.site.anchors = [f.anchor('BV123', '亚索视频')];
  f.emit('popstate');
  await pause(100);
  expect(f.names()).toEqual(['realcode.bilibili.listResults', 'realcode.bilibili.searchAndPlay', 'realcode.bilibili.searchVideos']);
  const listing = await f.call('listResults', { limit: 10 });
  expect(listing).toMatchObject({ status: 'arrived', results: [{ resultId: 'BV123', title: '亚索视频' }] });
  await pause(100);
  expect(f.names()).toContain('realcode.bilibili.openResult');
  expect(f.toolChanges).toBeGreaterThan(initialChanges);

  f.site.captcha = true;
  f.mutate();
  await pause(100);
  expect(f.names()).toEqual([]);
  f.emit('pagehide');
});

test('reports loading and changed DOM, and cancels a pending navigation', async () => {
  const f = fixture({ url: 'https://search.bilibili.com/all?keyword=yasuo', readyState: 'loading' });
  expect(f.names()).toEqual([]);
  f.site.readyState = 'complete';
  f.site.searchLoaded = true;
  f.site.anchors = [f.anchor('BV123', '')];
  f.emit('DOMContentLoaded');
  await pause(100);
  expect(f.names()).toContain('realcode.bilibili.listResults');
  expect(await f.call('listResults', {})).toMatchObject({ status: 'layout_unrecognized', results: [] });

  const cancellation = new AbortController();
  const navigation = await f.call('searchVideos', { query: '亚索' }, { signal: cancellation.signal });
  expect(navigation.status).toBe('navigation_started');
  cancellation.abort();
  await pause(150);
  expect(f.navigations).toEqual([]);
  f.emit('pagehide');
});

test('iframe bridge reports current tools and video arrival separately from navigation intent', async () => {
  const f = fixture({ url: 'https://www.bilibili.com/video/BV123/', iframe: true });
  f.site.videoTitle = '亚索视频';
  f.mutate();
  await pause(100);
  expect(f.names()).toContain('realcode.bilibili.getVideoInfo');
  expect(await f.call('getVideoInfo', {})).toMatchObject({ status: 'arrived', resultId: 'BV123', title: '亚索视频' });
  const data = { nonce: 'test-nonce', id: '1', method: 'site.tools' };
  f.emit('message', { source: f.parent, data });
  expect(f.messages[0].result.tools.map(tool => tool.name)).toContain('realcode.bilibili.getVideoInfo');
  f.emit('pagehide');
  expect(f.names()).toEqual([]);
});

test('reports login changes without exposing an unavailable action', async () => {
  const f = fixture();
  expect(f.statusEvents.at(-1)).toMatchObject({ state: 'home', loginState: 'unknown' });
  f.site.login = 'signed_in';
  f.mutate();
  await pause(100);
  expect(f.statusEvents.at(-1)).toMatchObject({ state: 'home', loginState: 'signed_in' });
  expect(f.names()).toEqual(['realcode.bilibili.searchAndPlay', 'realcode.bilibili.searchVideos']);
  f.emit('pagehide');
});

test('exposes a task tool for search and play, and verifies playback on the video page', async () => {
  const home = fixture();
  const task = await home.call('searchAndPlay', { query: 'rag' });
  expect(task).toMatchObject({ status: 'navigation_started', task: 'search_and_play', targetState: 'search_results' });
  home.emit('pagehide');

  const video = fixture({ url: 'https://www.bilibili.com/video/BV123/' });
  video.site.videoTitle = 'RAG 入门';
  video.site.video = { paused: true, readyState: 0, currentSrc: '', async play() { this.paused = false; }, pause() { this.paused = true; } };
  video.mutate();
  await pause(100);
  expect(video.names()).toContain('realcode.bilibili.playVideo');
  expect(video.names()).toContain('realcode.bilibili.pauseVideo');
  expect(await video.call('playVideo', {})).toMatchObject({ status: 'player_loading' });
  video.site.video.readyState = 1;
  video.site.video.currentSrc = 'https://example.com/video.m4s';
  expect(await video.call('playVideo', {})).toMatchObject({ status: 'playing', state: 'video' });
  expect(await video.call('pauseVideo', {})).toMatchObject({ status: 'paused', state: 'video', wasPlaying: true });
  expect(video.site.video.paused).toBe(true);
  expect(await video.call('pauseVideo', {})).toMatchObject({ status: 'paused', wasPlaying: false });
  video.emit('pagehide');
});

test('keeps the hook catalog available when iframe permissions policy denies native WebMCP', async () => {
  const f = fixture({ url: 'https://search.bilibili.com/all?keyword=rag', iframe: true, toolsDenied: true });
  f.site.searchLoaded = true;
  f.site.anchors = [f.anchor('BV123', 'RAG 入门')];
  f.mutate();
  await pause(100);
  const attempts = f.toolChanges;
  f.mutate();
  await pause(100);
  expect(f.toolChanges).toBe(attempts);
  expect(f.names()).toEqual([]);
  f.emit('message', { source: f.parent, data: { nonce: 'test-nonce', id: 'denied', method: 'site.tools' } });
  await pause(0);
  expect(f.messages.at(-1).result.tools.map(tool => tool.name)).toContain('realcode.bilibili.listResults');
  f.emit('pagehide');
});

test('pauses video through the iframe hook when native WebMCP is denied', async () => {
  const f = fixture({ url: 'https://www.bilibili.com/video/BV123/', iframe: true, toolsDenied: true });
  f.site.videoTitle = 'RAG 入门';
  f.site.video = { paused: false, pause() { this.paused = true; } };
  f.mutate();
  await pause(100);
  f.emit('message', { source: f.parent, data: { nonce: 'test-nonce', id: 'pause', method: 'site.call', name: 'bilibili.pauseVideo', args: {} } });
  await pause(0);
  expect(f.messages.at(-1).result).toMatchObject({ status: 'paused', wasPlaying: true });
  expect(f.site.video.paused).toBe(true);
  f.emit('pagehide');
});

test('registers appendText for a visible editor, appends plain text, deduplicates retries and retracts on removal', async () => {
  const f = fixture({ iframe: true });
  const editor = f.editor('Intro');
  f.site.editors = [editor];
  f.mutate();
  await pause(100);
  expect(f.names()).toContain('realcode.bilibili.listEditors');
  expect(f.names()).toContain('realcode.bilibili.appendText');
  const listed = await f.call('listEditors', {});
  const targetId = listed.editors[0].targetId;
  expect(await f.call('appendText', { targetId, text: '<h1>Title</h1>', chunkId: 'part-1' })).toMatchObject({ status: 'appended' });
  expect(editor.value).toBe('Intro<h1>Title</h1>');
  const rich = f.editor('Rich', true);
  f.site.editors.push(rich);
  f.mutate();
  await pause(100);
  const richTarget = (await f.call('listEditors', {})).editors.find(item => item.kind === 'rich-text').targetId;
  expect(await f.call('appendText', { targetId: richTarget, text: '<b>literal</b>' })).toMatchObject({ status: 'appended' });
  expect(rich.textContent).toBe('Rich<b>literal</b>');
  expect(await f.call('appendText', { targetId, text: '<h1>Title</h1>', chunkId: 'part-1' })).toMatchObject({ status: 'duplicate' });
  expect(editor.value).toBe('Intro<h1>Title</h1>');
  await expect(f.call('appendText', { targetId, text: 'different', chunkId: 'part-1' })).rejects.toThrow('chunkId');
  f.site.editors = [];
  editor.isConnected = false;
  f.mutate();
  await pause(100);
  expect(f.names()).not.toContain('realcode.bilibili.appendText');
  f.emit('pagehide');
});

test('offers appendText through the iframe bridge when native WebMCP is denied', async () => {
  const f = fixture({ iframe: true, toolsDenied: true });
  const editor = f.editor('A');
  f.site.editors = [editor];
  f.mutate();
  await pause(100);
  f.emit('message', { source: f.parent, data: { nonce: 'test-nonce', id: 'list', method: 'site.tools' } });
  expect(f.messages.at(-1).result.tools.map(tool => tool.name)).toContain('realcode.bilibili.appendText');
  f.emit('message', { source: f.parent, data: { nonce: 'test-nonce', id: 'targets', method: 'site.call', name: 'bilibili.listEditors', args: {} } });
  await pause(0);
  const targetId = f.messages.at(-1).result.editors[0].targetId;
  f.emit('message', { source: f.parent, data: { nonce: 'test-nonce', id: 'append', method: 'site.call', name: 'bilibili.appendText', args: { targetId, text: 'B' } } });
  await pause(0);
  expect(f.messages.at(-1).result.status).toBe('appended');
  expect(editor.value).toBe('AB');
  f.emit('pagehide');
});
