type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type CdpEvent = { method: string; params: Record<string, any>; sessionId?: string };

/** A small CDP transport. Page and out-of-process iframe sessions share one WebSocket. */
export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data)) as CdpEvent & { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
          else pending.resolve(message.result ?? {});
        } else if (message.method) {
          for (const listener of this.listeners) listener(message);
        }
      } catch { /* Ignore malformed browser messages. */ }
    });
    const disconnect = () => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome 调试连接已断开'));
      }
      this.pending.clear();
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', disconnect);
  }

  static async connect(endpoint: string): Promise<CdpClient> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome CDP 超时')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 Chrome CDP 失败')); }, { once: true });
    }).catch(error => { socket.close(); throw error; });
    return new CdpClient(socket);
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10000): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('Chrome 调试连接已断开');
    const id = ++this.nextId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
