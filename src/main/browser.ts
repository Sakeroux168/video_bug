import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

// 顶部留给渲染层标题栏+标签栏的高度（header ~40px + tabs ~44px + 边框），微调此处即可
const TOP_OFFSET = 96

export class VideoBrowser {
  private view: WebContentsView | null = null
  private visible = false

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

    view.webContents.on('did-finish-load', () => {
      void view.webContents.executeJavaScript(this.inject).catch(() => { /* 页面脚本执行失败不影响主流程 */ })
    })
    view.webContents.on('did-navigate', () => {
      void view.webContents.executeJavaScript(this.inject).catch(() => { /* ignore */ })
    })
  }

  async load(adapter: PlatformAdapter, url: string): Promise<void> {
    if (!this.view) throw new Error('browser_not_initialized')
    const wc = this.view.webContents
    await wc.loadURL(url)
  }

  async scrollToBottom(): Promise<void> {
    if (!this.view) return
    await this.view.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {})
  }

  setVisible(v: boolean): void {
    if (!this.view) return
    this.visible = v
    if (v) this.applyBounds()
    this.view.setVisible(v)
  }

  /** 视图置于渲染层下方，顶部留出标题+标签栏高度，避免整窗覆盖后无法切回面板 */
  private applyBounds(): void {
    if (!this.view) return
    const [w, h] = this.host.getContentSize()
    const top = Math.min(TOP_OFFSET, h)
    this.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) })
  }

  dispose(): void {
    if (this.view) {
      this.host.contentView.removeChildView(this.view)
      this.view = null
    }
  }
}
