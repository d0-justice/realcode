/** 只有目标页面已连上服务端后，才发送一次就绪回执。 */
export async function acknowledgeBrowserHandoff(api) {
  const url = new URL(location.href);
  const token = url.searchParams.get('handoff');
  if (!token) return;
  await api('/api/browser/handoff/ready', { token });
  url.searchParams.delete('handoff');
  history.replaceState(history.state, '', url);
}

/** 普通 Chrome 可能拒绝关闭手动打开且已有导航历史的标签页。 */
export function closeTransferredPage(events) {
  events.close();
  window.close();
  // 被浏览器拦截时，撤下旧会话界面，避免两个页面继续操作同一实例。
  const panel = document.createElement('main');
  panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f8fafc;display:grid;place-content:center;text-align:center;color:#334155;font:16px system-ui;gap:16px';
  const heading = document.createElement('h2');
  heading.textContent = 'RealCode 已在新窗口打开';
  const hint = document.createElement('p');
  hint.textContent = '浏览器阻止了自动关闭此标签页，请手动关闭。';
  panel.append(heading, hint);
  for (const child of document.body.children) { child.hidden = true; child.inert = true; }
  document.body.append(panel);
}
