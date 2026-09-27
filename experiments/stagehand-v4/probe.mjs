import { createServer } from 'node:net';

/** 选择独立调试端口，只供本次测试浏览器使用。 */
export async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 只读核对实际 Chrome 参数和子框架 target，不通过此连接执行页面动作。 */
export async function inspectBrowser(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const call = method => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method }));
  });
  try {
    const commandLine = await call('Browser.getBrowserCommandLine');
    const targets = await call('Target.getTargets');
    return {
      browser: version.Browser,
      unsafeExtensionDebugging: commandLine.arguments.includes('--enable-unsafe-extension-debugging'),
      remoteDebugging: commandLine.arguments.some(arg => arg.startsWith('--remote-debugging-port=')),
      headless: commandLine.arguments.includes('--headless'),
      frames: targets.targetInfos.filter(t => t.type === 'iframe').map(t => ({ type: t.type, url: t.url })),
    };
  } finally { socket.close(); }
}
