// Electron renderer transport for the port-free desktop edition.
(() => {
  if (!window.sshtermDesktop) return;
  document.documentElement.classList.add('desktop-mode');
  const clients = new Map();
  window.sshtermDesktop.onSocketEvent(({ id, kind, value }) => {
    clients.get(id)?._receive(kind, value);
  });
  class DesktopWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = DesktopWebSocket.CONNECTING;
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.id = crypto.randomUUID();
      clients.set(this.id, this);
      window.sshtermDesktop.openSocket(this.id, url).then(() => {
        if (this.readyState !== DesktopWebSocket.CONNECTING) return;
        this.readyState = DesktopWebSocket.OPEN;
        this._emit(new Event('open'));
        for (const event of this.pending || []) this._receive(event.kind, event.value);
        this.pending = [];
      }).catch(() => {
        this._emit(new Event('error'));
        this._receive('close', { code: 1006, reason: '桌面连接失败' });
      });
    }
    _emit(event) {
      this.dispatchEvent(event);
      this[`on${event.type}`]?.(event);
    }
    _receive(kind, value) {
      if (this.readyState === DesktopWebSocket.CONNECTING && kind === 'message') {
        (this.pending ||= []).push({ kind, value });
        return;
      }
      if (kind === 'close') {
        if (this.readyState === DesktopWebSocket.CLOSED) return;
        this.readyState = DesktopWebSocket.CLOSED;
        clients.delete(this.id);
        this._emit(new CloseEvent('close', { code: value.code || 1000, reason: value.reason || '' }));
      } else if (kind === 'message' && this.readyState === DesktopWebSocket.OPEN) {
        const bytes = new Uint8Array(value.data);
        const data = value.binary
          ? (this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]))
          : new TextDecoder().decode(bytes);
        this._emit(new MessageEvent('message', { data }));
      }
    }
    send(data) {
      if (this.readyState !== DesktopWebSocket.OPEN) throw new DOMException('Socket is not open', 'InvalidStateError');
      window.sshtermDesktop.sendSocket(this.id, data);
    }
    close() {
      if (this.readyState >= DesktopWebSocket.CLOSING) return;
      this.readyState = DesktopWebSocket.CLOSING;
      window.sshtermDesktop.closeSocket(this.id);
    }
  }
  window.WebSocket = DesktopWebSocket;
})();
