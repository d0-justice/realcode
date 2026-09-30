import { createServer } from 'node:net';

/** 为受控 Chrome 指定 CDP 端口，以便退出时向同一实例发送 Browser.close。 */
export async function availableChromePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** SDK 在 Windows 上直接 taskkill 会留下 Crashed profile；先让 Chrome 自己正常退出。 */
export async function closeChromeGracefully(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json() as { webSocketDebuggerUrl?: string };
    const endpoint = new URL(data.webSocketDebuggerUrl ?? '');
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || Number(endpoint.port) !== port) return false;
    return await new Promise<boolean>(resolve => {
      const socket = new WebSocket(endpoint);
      let sent = false;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 3000);
      socket.onopen = () => { sent = true; socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); };
      socket.onmessage = event => {
        try { const message = JSON.parse(String(event.data)); if (message.id === 1) finish(!message.error); }
        catch { /* 非当前命令的事件可以忽略 */ }
      };
      socket.onclose = () => finish(sent);
      socket.onerror = () => finish(false);
    });
  } catch { return false; }
}
