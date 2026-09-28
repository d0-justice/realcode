/** 会话嵌入页及其播放器子框架初次加载时暂停 HTML5 视频；用户交互后不再干预播放。 */
(function installRealCodeEmbeddedVideoPause() {
  if (window === parent) return;
  let referrer;
  try { referrer = new URL(document.referrer); } catch { /* 子框架可能不传 Referer */ }
  const directChild = referrer && ['localhost', '127.0.0.1'].includes(referrer.hostname) && ['http:', 'https:'].includes(referrer.protocol);
  const signal = 'realcode:pause-embedded-video';
  let active = false;
  let userInteracted = false;
  const knownFrames = new WeakSet();
  const pause = media => {
    if (active && !userInteracted && media instanceof HTMLMediaElement && !media.paused) media.pause();
  };
  const scan = () => {
    document.querySelectorAll('video').forEach(pause);
    document.querySelectorAll('iframe').forEach(frame => {
      if (knownFrames.has(frame)) return;
      knownFrames.add(frame);
      const notify = () => frame.contentWindow?.postMessage({ type: signal }, '*');
      frame.addEventListener('load', notify);
      notify();
    });
  };
  const activate = () => {
    if (active) return;
    active = true;
    const allowManualPlayback = event => { if (event.isTrusted) userInteracted = true; };
    addEventListener('pointerdown', allowManualPlayback, true);
    addEventListener('keydown', allowManualPlayback, true);
    addEventListener('play', event => pause(event.target), true);
    const startScan = () => {
      scan();
      new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node =>
          node instanceof Element && (node.matches('video,iframe') || node.querySelector('video,iframe'))))) scan();
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', startScan, { once: true });
    else startScan();
  };
  addEventListener('message', event => {
    if (event.source === parent && event.data?.type === signal) activate();
  });
  if (directChild) activate();
})();
