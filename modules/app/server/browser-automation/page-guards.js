/** 仅观察受控文档，并在操作前校验节点身份与遮挡状态。 */
function installPageGuards(nonce) {
  const documentId = crypto.randomUUID();
  let fingerprint;
  let nodes = new Map();
  const signature = element => JSON.stringify([
    element.tagName, element.getAttribute('type'), element.getAttribute('href'),
    element.getAttribute('aria-label'), element.getAttribute('placeholder'),
    element.matches('input,textarea') ? '' : element.textContent.trim().slice(0, 300),
  ]);
  const label = element => (
    element.getAttribute('aria-label') || element.getAttribute('title') ||
    element.getAttribute('placeholder') || element.labels?.[0]?.textContent ||
    element.innerText || element.textContent || element.getAttribute('value') || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 160);
  const kind = element => element.matches('textarea,[contenteditable="true"],input:not([type]),input:is([type="text"],[type="search"],[type="email"],[type="url"],[type="tel"],[type="number"])') ? 'fill' : 'click';
  const selector = element => {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const tag = node.localName;
      if (!tag) break;
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.localName === tag) : [node];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== (window === top ? window : parent) || data?.nonce !== nonce || !['observe', 'prepare'].includes(data.method)) return;
    const reply = result => event.source.postMessage({ nonce, id: data.id, result }, '*');
    try {
      if (data.method === 'observe') {
        fingerprint = data.fingerprint;
        nodes = new Map();
        const actions = [];
        const limit = Math.min(500, Math.max(1, typeof data.maxActions === 'number' ? data.maxActions : 120));
        for (const element of document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]')) {
          if (actions.length >= limit) break;
          if (element.matches('input[type="password"],input[type="file"],input[type="hidden"],:disabled') || element.closest('[inert],[aria-disabled="true"]')) continue;
          if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !element.getClientRects().length) continue;
          const action = { id: `e${actions.length + 1}`, kind: kind(element), label: label(element) || element.tagName.toLowerCase(), navigates: Boolean(element.closest('a[href]')) };
          nodes.set(action.id, { element, signature: signature(element) });
          actions.push(action);
        }
        const maxTextLength = Math.min(50000, Math.max(0, typeof data.maxTextLength === 'number' ? data.maxTextLength : 6000));
        const text = (document.body?.innerText || '').slice(0, maxTextLength);
        return reply({ documentId, url: location.href, text, actions });
      }
      if (data.method !== 'prepare' || data.fingerprint !== fingerprint) throw new Error('STALE_PAGE: 请重新观察页面');
      const cached = nodes.get(data.actionId);
      const element = cached?.element;
      if (!element?.isConnected || cached.signature !== signature(element)) throw new Error('STALE_PAGE: 目标节点已变化');
      if (element.matches(':disabled,[readonly]') || element.closest('[inert],[aria-disabled=true]') || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) throw new Error('目标不可操作');
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (!rect.width || !rect.height || !element.contains(document.elementFromPoint(x, y))) throw new Error('目标被遮挡，请先关闭遮挡层');
      if (window !== top) {
        const anchor = element.closest('a[href]');
        if (anchor) anchor.target = '_self';
      }
      reply({ selector: selector(element), documentId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    } catch (error) { reply({ error: error.message }); }
  });
}
