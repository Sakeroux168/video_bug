import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

// 顶部留给渲染层标题栏+标签栏的高度（header ~40px + tabs ~44px + 边框），微调此处即可
const TOP_OFFSET = 96

export class VideoBrowser {
  private view: WebContentsView | null = null
  private visible = false
  private pip = false

  constructor(
    private host: BrowserWindow,
    private onRaw: (url: string, json: unknown) => void,
    private inject: string = INJECT_SCRIPT
  ) {
    // 窗口缩放时保持视图贴合可用区域（仅可见时更新，避免频繁 setBounds 开销）
    this.host.on('resize', () => { if (this.visible) this.applyBounds() })
  }

  async init(): Promise<void> {
    const view = new WebContentsView({ webPreferences: { partition: 'persist:douyin', preload: join(__dirname, '../preload/douyin.js') } })
    view.setVisible(false)
    this.host.contentView.addChildView(view)
    this.view = view

    const wc = view.webContents
    // 关键：隐藏/切后台时不被 Chromium 节流，否则切到管理面板后页面停止发请求，爬取到一页就停
    wc.setBackgroundThrottling(false)
    // 拦截自定义协议（bytedance:// 等）：不走 Windows 协议处理，避免弹微软商店
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/.test(url)) e.preventDefault()
    })
    // 一律不允许页面开新窗口/新标签（也拦截协议型 window.open）
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
      return { action: 'deny' }
    })

    wc.on('did-finish-load', () => {
      void wc.executeJavaScript(this.inject).catch(() => { /* 页面脚本执行失败不影响主流程 */ })
    })
    wc.on('did-navigate', () => {
      void wc.executeJavaScript(this.inject).catch(() => { /* ignore */ })
    })
  }

  async load(adapter: PlatformAdapter, url: string): Promise<void> {
    if (!this.view) throw new Error('browser_not_initialized')
    const wc = this.view.webContents
    await wc.loadURL(url)
  }

  /** 渐进滚动到底：定位真正的滚动容器（抖音列表常是内层 div 而非 window），触发"加载更多" */
  async scrollToBottom(): Promise<void> {
    if (!this.view) return
    const script = `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // 收集所有可滚动元素（含 document.scrollingElement）
      const candidates = [document.scrollingElement];
      document.querySelectorAll('*').forEach(el => {
        try { if (el.scrollHeight > el.clientHeight + 50) candidates.push(el); } catch (e) {}
      });
      // 选 scrollHeight 最大的那个（最外层列表容器）
      let target = candidates[0];
      for (const c of candidates) if (c.scrollHeight > (target ? target.scrollHeight : 0)) target = c;
      if (!target) return 0;
      const steps = Math.max(1, Math.ceil((target.scrollHeight - target.scrollTop - target.clientHeight) / 900));
      for (let i = 0; i < steps; i++) { target.scrollTop += 900; await sleep(220); }
      target.scrollTop = target.scrollHeight;
      await sleep(220);
      return target.scrollHeight;
    })()`
    await this.view.webContents.executeJavaScript(script).catch(() => {})
  }

  setVisible(v: boolean): void {
    if (!this.view) return
    this.visible = v
    if (v) this.applyBounds()
    this.view.setVisible(v)
  }

  /** 任务运行时把视图缩成右下角小窗：既保持页面活跃（触发加载更多），又不挡管理面板 */
  setPiP(active: boolean): void {
    this.pip = active
    if (this.visible) this.applyBounds()
  }

  /** 视图置于渲染层下方，顶部留出标题+标签栏高度，避免整窗覆盖后无法切回面板 */
  private applyBounds(): void {
    if (!this.view) return
    const [w, h] = this.host.getContentSize()
    if (this.pip) {
      const pw = 320, ph = 200
      this.view.setBounds({ x: Math.max(0, w - pw - 12), y: Math.max(0, h - ph - 12), width: pw, height: ph })
    } else {
      const top = Math.min(TOP_OFFSET, h)
      this.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) })
    }
  }

  dispose(): void {
    if (this.view) {
      this.host.contentView.removeChildView(this.view)
      this.view = null
    }
  }
}
