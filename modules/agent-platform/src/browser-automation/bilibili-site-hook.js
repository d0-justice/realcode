/** RealCode authored adapter for Bilibili; never presented as a site-owned tool. */
function installBilibiliSiteHook(nonce) {
  if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;

  const results = new Map();
  const tools = [
    { name: 'bilibili.searchVideos', description: '搜索哔哩哔哩视频', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'bilibili.listResults', description: '列出当前搜索页的视频', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } } } },
    { name: 'bilibili.openResult', description: '打开前一次列出的一个视频', inputSchema: { type: 'object', properties: { resultId: { type: 'string' } }, required: ['resultId'] } },
  ];

  function state() {
    if (/验证码|人机验证/.test(document.title) || document.querySelector('#risk-captcha-app')) return 'human_verification_required';
    if (location.hostname === 'search.bilibili.com') return 'search_results';
    if (/^\/video\/BV/i.test(location.pathname)) return 'video';
    return 'site';
  }

  function listResults(limit) {
    if (state() !== 'search_results') throw new Error('当前页面不是哔哩哔哩搜索结果');
    results.clear();
    const output = [], seen = new Set();
    for (const anchor of document.querySelectorAll('a[href*="/video/BV"]')) {
      if (output.length >= limit) break;
      const url = new URL(anchor.href, location.href);
      if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) continue;
      const match = /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname);
      if (!match) continue;
      const canonicalUrl = 'https://www.bilibili.com/video/' + match[1] + '/';
      if (seen.has(canonicalUrl)) continue;
      const titleNode = anchor.closest('.bili-video-card__wrap')?.querySelector('.bili-video-card__info--tit');
      const title = (titleNode?.getAttribute('title') || titleNode?.textContent || anchor.querySelector('img[alt]')?.getAttribute('alt') || anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      seen.add(canonicalUrl);
      const resultId = match[1];
      results.set(resultId, canonicalUrl);
      output.push({ resultId, title: title.slice(0, 180), url: canonicalUrl });
    }
    return { state: state(), results: output, totalVisible: output.length };
  }

  function execute(name, args = {}) {
    const current = state();
    if (current === 'human_verification_required') return { state: current, requiresHuman: true };
    if (name === 'bilibili.searchVideos') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 100) throw new Error('query 必须为 1–100 个字符');
      return { state: current, navigationUrl: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(query) };
    }
    if (name === 'bilibili.listResults') return listResults(Math.min(30, Math.max(1, Number(args.limit) || 10)));
    if (name === 'bilibili.openResult') {
      const url = results.get(args.resultId);
      if (!url) throw new Error('结果已失效，请重新调用 bilibili.listResults');
      return { state: current, navigationUrl: url };
    }
    throw new Error('未知的哔哩哔哩工具：' + name);
  }

  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== (window === top ? window : parent) || data?.nonce !== nonce || !['site.tools', 'site.call'].includes(data.method)) return;
    let result;
    try {
      result = data.method === 'site.tools'
        ? { site: 'bilibili.com', source: 'realcode-adapter', state: state(), tools: state() === 'human_verification_required' ? [] : tools }
        : execute(data.name, data.args);
    } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    event.source.postMessage({ nonce, id: data.id, result }, '*');
  });


}
