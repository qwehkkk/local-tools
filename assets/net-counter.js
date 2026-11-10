/**
 * 网络请求计数器
 *
 * 作用：把「本页脚本到目前为止发出了几个请求」实时显示在页面上，
 * 让用户不必打开开发者工具也能看到那个 0。
 *
 * 必须说清楚的边界：这是自证，不是安全边界。它只能证明「这段脚本没有
 * 调用 fetch/XHR/WebSocket/beacon」。真正的验证方式仍然是打开 DevTools
 * 的 Network 面板，看粘贴或拖入文件之后有没有新请求冒出来。
 *
 * 用法：在页面入口最上方调用一次。会寻找 id="netCount" 的元素并写入数字。
 */
export function installNetCounter() {
  const state = { count: 0, sent: 0 };

  const paint = () => {
    const el = document.getElementById('netCount');
    if (el) el.textContent = String(state.count);
    const se = document.getElementById('netSent');
    if (se) se.textContent = String(state.sent);
  };

  const bump = () => {
    state.count += 1;
    paint();
  };

  // 统计「向外发送的字节数」。请求数会随着按需加载的库增加，
  // 但上传字节数必须恒为 0 —— 这才是「文件没离开这台机器」的硬指标。
  const addSent = (n) => {
    if (!n || n < 0) return;
    state.sent += n;
    paint();
  };

  const sizeOfBody = (body) => {
    if (!body) return 0;
    if (typeof body === 'string') return new Blob([body]).size;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
    if (body instanceof FormData) {
      let total = 0;
      try {
        for (const [, v] of body.entries()) total += sizeOfBody(v);
      } catch {
        return 0;
      }
      return total;
    }
    return 0;
  };

  const realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      bump();
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') addSent(sizeOfBody(init && init.body));
      return realFetch.apply(this, [input, init]);
    };
  }

  const RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    const open = RealXHR.prototype.open;
    RealXHR.prototype.open = function (...args) {
      bump();
      return open.apply(this, args);
    };
    const send = RealXHR.prototype.send;
    RealXHR.prototype.send = function (body) {
      addSent(sizeOfBody(body));
      return send.apply(this, [body]);
    };
  }

  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (...args) {
      bump();
      return realBeacon(...args);
    };
  }

  if (window.WebSocket) {
    const RealWS = window.WebSocket;
    window.WebSocket = function (...args) {
      bump();
      return new RealWS(...args);
    };
    window.WebSocket.prototype = RealWS.prototype;
  }

  return state;
}
