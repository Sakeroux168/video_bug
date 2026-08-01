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
        const ct = this.getResponseHeader('content-type') || '';
        if (ct.includes('json')) { try { post(this.__dyUrl, JSON.parse(this.responseText)) } catch (e) { /* ignore */ } }
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };
})();`
