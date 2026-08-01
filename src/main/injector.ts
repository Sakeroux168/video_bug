export const INJECT_SCRIPT = `(() => {
  if (window.__dyHookInstalled) return;
  window.__dyHookInstalled = true;
  const post = (url, data) => {
    try { window.postMessage({ type: 'dy:raw', url, data }, '*') } catch (e) { /* ignore */ }
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
    this.__dyUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const u = this.__dyUrl || '';
        const ct = this.getResponseHeader('content-type') || '';
        let txt = null;
        if (this.responseType === '' || this.responseType === 'text') txt = this.responseText;
        else if (this.responseType === 'json' && this.response != null) txt = JSON.stringify(this.response);
        // 内容类型是 json，或 URL 是抖音接口(即便 content-type 不标准)都尝试解析
        if (txt && (ct.includes('json') || u.includes('/aweme/') || u.includes('/search/'))) {
          try { post(u, JSON.parse(txt)) } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };
})();`
