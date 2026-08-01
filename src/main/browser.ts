import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

export class VideoBrowser {
  private view: WebContentsView | null = null

  constructor(
    private host: BrowserWindow,
    private onRaw: (url: string, json: unknown) => void,
    private inject: string = INJECT_SCRIPT
  ) {}

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
    const [w, h] = this.host.getContentSize()
    if (v) this.view.setBounds({ x: 0, y: 0, width: w, height: h })
    this.view.setVisible(v)
    void this.host
  }

  dispose(): void {
    if (this.view) {
      this.host.contentView.removeChildView(this.view)
      this.view = null
    }
  }
}
