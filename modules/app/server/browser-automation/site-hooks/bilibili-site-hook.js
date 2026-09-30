/** RealCode's third-party Bilibili adapter. Site-owned tools never use the realcode prefix. */
function installBilibiliSiteHook(nonce, trustedOrigin) {
  if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;

  const prefix = 'realcode.bilibili.';
  const results = new Map();
  const registrations = new Map();
  const executions = new Set();
  const pendingNavigations = new Set();
  const editorIds = new WeakMap();
  const editors = new Map();
  const appendedChunks = new Map();
  let nextEditorId = 1;
  let currentKey = '';
  let lastStatusKey = '';
  let refreshTimer;
  let disposed = false;

  const definitions = {
    searchVideos: {
      name: prefix + 'searchVideos',
      description: '在哔哩哔哩搜索视频；返回已发起的导航及目标 URL，随后需等待结果页。',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
    searchAndPlay: {
      name: prefix + 'searchAndPlay',
      description: '搜索哔哩哔哩视频并播放第一条结果；用户要求“搜索并播放”时使用。跨页面等待结果、打开视频和确认播放由 RealCode 完成。',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
    listResults: {
      name: prefix + 'listResults',
      description: '列出当前搜索结果页可见的视频标题、BV 号及链接。',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
    openResult: {
      name: prefix + 'openResult',
      description: '打开本页最近一次 listResults 返回的视频 BV 号；返回已发起的导航。',
      inputSchema: { type: 'object', properties: { resultId: { type: 'string', pattern: '^BV[0-9A-Za-z]+$' } }, required: ['resultId'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
    getVideoInfo: {
      name: prefix + 'getVideoInfo',
      description: '读取当前视频页的标题、BV 号和规范链接。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
    playVideo: {
      name: prefix + 'playVideo',
      description: '播放当前哔哩哔哩视频，并返回是否已经真正开始播放。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
    pauseVideo: {
      name: prefix + 'pauseVideo',
      description: '暂停当前哔哩哔哩视频，并返回播放器是否已经暂停。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
    listEditors: {
      name: prefix + 'listEditors',
      description: '列出当前 B 站页面可见的文本编辑框，返回用于 appendText 的 targetId。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
    appendText: {
      name: prefix + 'appendText',
      description: '向 listEditors 返回的编辑框末尾追加纯文本，不清空原内容；HTML 代码按文本输入。可用 chunkId 在重试时去重。',
      inputSchema: { type: 'object', properties: {
        targetId: { type: 'string', pattern: '^editor-[1-9][0-9]*$' },
        text: { type: 'string', minLength: 1 },
        chunkId: { type: 'string', minLength: 1 },
      }, required: ['targetId', 'text'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
    },
  };

  function visibleEditors() {
    const found = [];
    for (const element of document.querySelectorAll('textarea,input:not([type]),input[type="text"],input[type="search"],[contenteditable="true"]')) {
      if (!element.isConnected || element.matches(':disabled,[readonly],[type="password"]') || element.closest('[inert],[aria-disabled="true"]')) continue;
      if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (element.getClientRects && !element.getClientRects().length) continue;
      let targetId = editorIds.get(element);
      if (!targetId) { targetId = 'editor-' + nextEditorId++; editorIds.set(element, targetId); }
      editors.set(targetId, element);
      found.push({ targetId, kind: element.isContentEditable ? 'rich-text' : 'plain-text',
        label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') ||
          element.closest('label')?.textContent || element.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 120) });
    }
    const live = new Set(found.map(item => item.targetId));
    for (const id of editors.keys()) if (!live.has(id)) editors.delete(id);
    return found;
  }

  function appendText({ targetId, text, chunkId = undefined }) {
    if (typeof targetId !== 'string' || typeof text !== 'string' || !text.length ||
      (chunkId !== undefined && (typeof chunkId !== 'string' || !chunkId.length))) throw new Error('appendText 参数无效');
    visibleEditors();
    const element = editors.get(targetId);
    if (!element) throw new Error('STALE_PAGE: 编辑框已变化，请重新调用 listEditors');
    const key = chunkId ? targetId + ':' + chunkId : null;
    if (key && appendedChunks.has(key)) {
      if (appendedChunks.get(key) !== text) throw new Error('chunkId 已用于不同文本');
      return { status: 'duplicate', targetId, chunkId };
    }
    element.focus();
    if (element.isContentEditable) {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } else element.setSelectionRange(element.value.length, element.value.length);
    if (!document.execCommand('insertText', false, text)) throw new Error('编辑框不支持文本插入');
    if (key) {
      if (appendedChunks.size >= 200) appendedChunks.delete(appendedChunks.keys().next().value);
      appendedChunks.set(key, text);
    }
    return { status: 'appended', targetId, length: text.length, chunkId: chunkId ?? null };
  }

  function state() {
    if (/验证码|人机验证|安全验证/.test(document.title) || document.querySelector('#risk-captcha-app, .geetest_panel, .bili-captcha')) return 'human_verification_required';
    if (document.readyState === 'loading') return 'loading';
    if (location.hostname === 'search.bilibili.com') {
      return document.querySelector('a[href*="/video/BV"], .search-result, .video-list, .bili-video-card, .vui_pagenation')
        ? 'search_results' : 'loading';
    }
    if (/^\/video\/BV[0-9A-Za-z]+/.test(location.pathname)) {
      return document.querySelector('h1, video, .video-title') ? 'video' : 'loading';
    }
    return location.pathname === '/' ? 'home' : 'site';
  }

  function available(current = state()) {
    if (current === 'loading' || current === 'human_verification_required') return [];
    const tools = current === 'search_results'
      ? (results.size ? ['searchVideos', 'searchAndPlay', 'listResults', 'openResult'] : ['searchVideos', 'searchAndPlay', 'listResults'])
      : current === 'video' ? ['searchVideos', 'searchAndPlay', 'getVideoInfo', 'playVideo', 'pauseVideo'] : ['searchVideos', 'searchAndPlay'];
    if (visibleEditors().length) tools.push('listEditors', 'appendText');
    return tools;
  }

  function loginState() {
    if (document.querySelector('header .header-avatar-wrap, header .bili-avatar, .bili-header .header-avatar-wrap')) return 'signed_in';
    if (document.querySelector('header .header-login-entry, header .bili-header__login, .bili-header .login-entry')) return 'signed_out';
    return 'unknown';
  }

  function clearPending() {
    for (const item of pendingNavigations) { clearTimeout(item.timer); item.controller.abort(); }
    pendingNavigations.clear();
  }

  function refresh() {
    if (disposed) return;
    const current = state();
    const key = location.href + '|' + current;
    if (currentKey && currentKey !== key) {
      results.clear();
      clearPending();
      for (const controller of executions) controller.abort();
    }
    currentKey = key;
    const wanted = new Set(available(current));
    const status = { state: current, loginState: loginState(), url: location.href };
    const statusKey = JSON.stringify(status);
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      try { globalThis.__realcodeSiteStateChanged?.(JSON.stringify({ nonce, ...status })); } catch { /* CDP binding may be unavailable. */ }
    }
    for (const [name, registration] of registrations) {
      if (!wanted.has(name)) { registration.abort(); registrations.delete(name); }
    }
    const modelContext = document.modelContext;
    if (!modelContext?.registerTool) return;
    for (const name of wanted) {
      if (registrations.has(name)) continue;
      const registration = new AbortController();
      registrations.set(name, registration);
      const definition = definitions[name];
      const options = { signal: registration.signal };
      if (trustedOrigin) options.exposedTo = [trustedOrigin];
      Promise.resolve(modelContext.registerTool({
        ...definition,
        execute: async (input = {}, context = {}) => {
          const invocation = new AbortController();
          executions.add(invocation);
          const cancel = () => invocation.abort();
          context.signal?.addEventListener('abort', cancel, { once: true });
          try {
            if (context.signal?.aborted || invocation.signal.aborted) throw new Error('操作已取消');
            const result = await execute(name, input);
            if (result.navigationUrl) scheduleNavigation(result.navigationUrl, invocation, context.signal);
            return result;
          } finally {
            context.signal?.removeEventListener('abort', cancel);
            executions.delete(invocation);
          }
        },
      }, options)).catch(error => {
        if (/permissions policy|NotAllowedError/i.test(String(error))) return;
        if (registrations.get(name) === registration) registrations.delete(name);
      });
    }
  }

  function scheduleRefresh() {
    if (disposed || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 80);
  }

  function listResults(limit) {
    const output = [], seen = new Set(), nextResults = new Map();
    const anchors = document.querySelectorAll('a[href*="/video/BV"]');
    for (const anchor of anchors) {
      if (output.length >= limit) break;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) continue;
      const match = /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname);
      if (!match || seen.has(match[1])) continue;
      const titleNode = anchor.closest('.bili-video-card__wrap')?.querySelector('.bili-video-card__info--tit');
      const title = (titleNode?.getAttribute('title') || titleNode?.textContent || anchor.querySelector('img[alt]')?.getAttribute('alt') || anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      const resultId = match[1];
      const canonicalUrl = 'https://www.bilibili.com/video/' + resultId + '/';
      seen.add(resultId);
      nextResults.set(resultId, canonicalUrl);
      output.push({ resultId, title: title.slice(0, 180), url: canonicalUrl });
    }
    results.clear();
    for (const [id, url] of nextResults) results.set(id, url);
    scheduleRefresh();
    return { status: anchors.length && !output.length ? 'layout_unrecognized' : 'arrived', state: 'search_results', results: output, totalVisible: output.length };
  }

  async function execute(name, args = {}) {
    refresh();
    const current = state();
    if (current === 'human_verification_required') return { status: 'human_verification_required', state: current, requiresHuman: true };
    if (current === 'loading') return { status: 'page_loading', state: current };
    if (!available(current).includes(name)) throw new Error('当前页面状态不支持该工具，请重新发现工具');
    if (name === 'listEditors') return { status: 'ready', editors: visibleEditors() };
    if (name === 'appendText') return appendText(args);
    if (name === 'searchVideos' || name === 'searchAndPlay') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 100) throw new Error('query 必须为 1–100 个字符');
      return { status: 'navigation_started', state: current, targetState: 'search_results', navigationUrl: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(query), ...(name === 'searchAndPlay' ? { task: 'search_and_play' } : {}) };
    }
    if (name === 'listResults') {
      const limit = args.limit === undefined ? 10 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('limit 必须为 1–30 的整数');
      return listResults(limit);
    }
    if (name === 'openResult') {
      const url = results.get(args.resultId);
      if (!url || ![...document.querySelectorAll('a[href*="/video/BV"]')].some(anchor => anchor.href.includes(args.resultId))) throw new Error('结果已失效，请重新调用 listResults');
      return { status: 'navigation_started', state: current, targetState: 'video', navigationUrl: url, resultId: args.resultId };
    }
    if (name === 'getVideoInfo') {
      const match = /^\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname);
      const titleNode = document.querySelector('h1.video-title, h1, .video-title');
      const title = (titleNode?.getAttribute('title') || titleNode?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!match || !title) return { status: 'layout_unrecognized', state: current };
      return { status: 'arrived', state: current, resultId: match[1], title: title.slice(0, 180), url: 'https://www.bilibili.com/video/' + match[1] + '/' };
    }
    if (name === 'playVideo') {
      const video = document.querySelector('video');
      if (!video) return { status: 'player_unavailable', state: current };
      if (!video.currentSrc && video.readyState === 0) return { status: 'player_loading', state: current };
      dispatchEvent(new Event('realcode:allow-embedded-video'));
      try { await video.play(); } catch { /* A real pointer gesture may still be required. */ }
      return { status: video.paused ? 'user_gesture_required' : 'playing', state: current };
    }
    if (name === 'pauseVideo') {
      const video = document.querySelector('video');
      if (!video) return { status: 'player_unavailable', state: current };
      const wasPlaying = !video.paused;
      video.pause();
      return { status: video.paused ? 'paused' : 'pause_failed', state: current, wasPlaying };
    }
    throw new Error('未知工具');
  }

  function scheduleNavigation(url, controller, signal) {
    if (controller.signal.aborted || signal?.aborted) return;
    const item = { controller, timer: undefined };
    item.timer = setTimeout(() => {
      pendingNavigations.delete(item);
      if (!disposed && !controller.signal.aborted && !signal?.aborted) location.assign(url);
    }, 120);
    pendingNavigations.add(item);
    signal?.addEventListener('abort', () => { clearTimeout(item.timer); pendingNavigations.delete(item); }, { once: true });
  }

  addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== (window === top ? window : parent) || data?.nonce !== nonce || !['site.tools', 'site.call', 'site.playTarget'].includes(data.method)) return;
    let result;
    try {
      refresh();
      const current = state();
      if (data.method === 'site.tools') result = { site: 'bilibili.com', source: 'third-party-hook', state: current, loginState: loginState(), tools: available(current).map(name => definitions[name]) };
      else if (data.method === 'site.playTarget') {
        const video = document.querySelector('video');
        const rect = video?.getBoundingClientRect();
        result = video && rect ? { paused: video.paused, readyState: video.readyState, networkState: video.networkState,
          currentTime: video.currentTime, error: video.error?.message, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : { error: '视频播放器不可用' };
      } else result = await execute(String(data.name || '').replace(/^(realcode\.)?bilibili\./, ''), data.args);
    } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    event.source.postMessage({ nonce, id: data.id, result }, '*');
  });

  const observe = () => {
    if (document.documentElement) new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
    refresh();
  };
  if (document.documentElement) observe();
  else addEventListener('DOMContentLoaded', observe, { once: true });
  addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  addEventListener('pageshow', scheduleRefresh);
  addEventListener('popstate', scheduleRefresh);
  addEventListener('hashchange', scheduleRefresh);
  addEventListener('pagehide', () => {
    disposed = true;
    clearTimeout(refreshTimer);
    clearPending();
    for (const controller of executions) controller.abort();
    for (const registration of registrations.values()) registration.abort();
    registrations.clear();
    editors.clear();
    appendedChunks.clear();
  }, { once: true });
}
