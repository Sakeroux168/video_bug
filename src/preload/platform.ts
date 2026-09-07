import { ipcRenderer } from 'electron'

// 页面世界经 window.postMessage 发来的原始 JSON → 主进程。
// 平台无关：抖音、快手、后续小红书的内嵌视图共用这一份 preload。
// 只认 platform:raw 这一种消息，不按前缀放行——下面自己 postMessage 的
// platform:scroll-abort 会被同一个 message 监听收到，按前缀匹配会把它回传成
// 一条 url 为空的假 raw，污染拦截日志。
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (d && typeof d === 'object' && d.type === 'platform:raw') {
    ipcRenderer.send('platform:raw', { url: d.url ?? '', json: d.data })
  }
})

// 主进程滚动中止信号 → 页面世界：隔离世界 postMessage 主世界滚动脚本能收到（爬取暂停即时生效）
ipcRenderer.on('platform:scroll-abort', () => {
  window.postMessage({ type: 'platform:scroll-abort' }, '*')
})
