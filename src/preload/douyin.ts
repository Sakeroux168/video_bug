import { ipcRenderer } from 'electron'

// 页面世界经 window.postMessage 发来的原始 JSON → 主进程（只在 douyin 内嵌视图加载）
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (d && typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('dy:')) {
    ipcRenderer.send('dy:raw', { url: d.url ?? '', json: d.data })
  }
})
