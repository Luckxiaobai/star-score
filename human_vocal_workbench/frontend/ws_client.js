/**
 * ws_client.js — WebSocket 客户端
 * 契约第 2 节：连接 /ws，处理 playhead / note_select / render_notify / mode_switch
 *
 * 特性：
 *   - 断线 2 秒后自动重连
 *   - 事件订阅：on(type, fn)
 *   - 发送：send(type, payload)
 */
class WSClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.handlers = new Map();
    this._connect();
  }
  _connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      console.error('[WS] new WebSocket failed', e);
      setTimeout(() => this._connect(), 2000);
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      console.log('[WS] connected');
      this._emit('__open', {});
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this._emit(msg.type, msg.payload || {});
      } catch (err) {
        console.error('[WS] parse error', err, ev.data);
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      console.log('[WS] disconnected, retry in 2s');
      setTimeout(() => this._connect(), 2000);
    };
    this.ws.onerror = (e) => console.error('[WS] error', e);
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  _emit(type, payload) {
    const list = this.handlers.get(type) || [];
    for (const fn of list) {
      try { fn(payload); } catch (e) { console.error('[WS handler]', type, e); }
    }
  }
  send(type, payload) {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify({ type, payload: payload || {} }));
    return true;
  }
}
