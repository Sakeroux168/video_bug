import { ipcRenderer } from 'electron'

// 页面世界经 window.postMessage 发来的原始 JSON → 主进程（只在 douyin 内嵌视图加载）
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (d && typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('dy:')) {
    ipcRenderer.send('dy:raw', { url: d.url ?? '', json: d.data })
  }
})

// 主进程滚动中止信号 → 页面世界：隔离世界 postMessage 主世界滚动脚本能收到（爬取暂停即时生效）
ipcRenderer.on('dy:scroll-abort', () => {
  window.postMessage({ type: 'dy:scroll-abort' }, '*')
})
