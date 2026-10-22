type Listener = (value: unknown) => void;

export class CompanionClient {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failures = 0;

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => { this.listeners.get(event)?.delete(listener); };
  }

  private emit(event: string, value: unknown) { this.listeners.get(event)?.forEach((listener) => listener(value)); }

  connect() {
    if (this.stopped) return;
    this.emit('connection', 'connecting');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/socket`);
    this.socket = socket;
    socket.onopen = () => { this.failures = 0; this.emit('connection', 'connected'); };
    socket.onmessage = (message) => {
      const response = JSON.parse(message.data);
      if (response.event) this.emit(response.event, response.value);
      else {
        const request = this.pending.get(response.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error)); else request.resolve(response.result);
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const message = event.code === 4001 ? 'This device was revoked. Pair again from desktop.' : 'Disconnected. Action outcome may be unknown; refresh sessions before repeating it.';
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
      this.pending.clear();
      this.emit('connection', 'offline');
      if (!this.stopped && event.code !== 4001) this.retry = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.failures++, 15000));
      if (event.code === 4001) this.emit('revoked', null);
    };
  }

  request<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Desktop is disconnected'));
    // randomUUID is unavailable on private HTTP origins; getRandomValues is.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Request timed out. Action outcome may be unknown; refresh sessions before repeating it.')); }, 60000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket!.send(JSON.stringify({ id, method, args }));
    });
  }

  close() {
    this.stopped = true; clearTimeout(this.retry); this.socket?.close();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Connection closed')); }
    this.pending.clear();
  }
}
