/**
 * 页面钩子脚本：拦截页面自己发出的 fetch/XHR 响应，postMessage 交给 preload 转主进程。
 *
 * 消息名平台无关（platform:raw）——抖音、快手、后续小红书共用同一条原始响应通道。
 * 脚本本身不认识任何平台：唯一的平台知识是 hints，由适配器声明后注入进来。
 *
 * hints 的用途：部分接口响应的 content-type 不标准（不含 json），此时按 URL 子串兜底
 * 判断这条响应是否值得解析。抖音是 ['/aweme/', '/search/']，快手是 ['/graphql']。
 */
export function buildInjectScript(hints: readonly string[]): string {
  const hintList = JSON.stringify([...hints])
  return `(() => {
  if (window.__platformHookInstalled) return;
  window.__platformHookInstalled = true;
  const HINTS = ${hintList};
  const post = (url, data) => {
    try { window.postMessage({ type: 'platform:raw', url, data }, '*') } catch (e) { /* ignore */ }
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(res => {
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) {
          res.clone().text().then(txt => {
            try { post(res.url, JSON.parse(txt)) } catch (e) { /* ignore */ }
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    });
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__platformUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const u = this.__platformUrl || '';
        const ct = this.getResponseHeader('content-type') || '';
        let txt = null;
        if (this.responseType === '' || this.responseType === 'text') txt = this.responseText;
        else if (this.responseType === 'json' && this.response != null) txt = JSON.stringify(this.response);
        // 内容类型是 json，或 URL 命中当前平台的兜底特征(即便 content-type 不标准)都尝试解析
        if (txt && (ct.includes('json') || HINTS.some(h => u.includes(h)))) {
          try { post(u, JSON.parse(txt)) } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };
})();`
}
