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

  /** 渐进滚动到底：滚 window + 所有可滚容器，多轮小步，并点击"加载更多"，尽力触发抖音加载更多 */
  async scrollToBottom(): Promise<void> {
    if (!this.view) return
    const script = `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const sc = document.scrollingElement || document.documentElement;
      // 收集所有明显可滚动的元素（列表容器）
      const bigs = [];
      document.querySelectorAll('div, main, section').forEach(el => {
        try { if (el.scrollHeight > el.clientHeight + 300 && el.scrollHeight > 600) bigs.push(el); } catch (e) {}
      });
      bigs.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const targets = [sc, ...bigs.slice(0, 3)];
      const clickMore = () => {
        const btns = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
          const t = (b.textContent || '').trim();
          return t.includes('加载更多') || t.includes('查看更多') || t.includes('展开');
        });
        for (const b of btns.slice(0, 2)) { try { b.click(); } catch (e) {} }
      };
      // 模拟真实鼠标滚轮事件（部分站点只监听 wheel，程序化 scrollTop 不触发加载）
      const wheel = (dy) => {
        try {
          window.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
          document.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        } catch (e) {}
      };
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 8; i++) {
          targets.forEach(t => { try { t.scrollTop += 700; } catch (e) {} });
          wheel(700);
          await sleep(280);
        }
        targets.forEach(t => { try { t.scrollTop = t.scrollHeight; } catch (e) {} });
        wheel(2000);
        clickMore();
        await sleep(600);
      }
      return targets.length;
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
      const pw = Math.min(520, Math.round(w * 0.5)), ph = Math.min(320, Math.round(h * 0.4))
      this.view.setBounds({ x: Math.max(0, w - pw - 12), y: Math.max(0, h - ph - 12), width: pw, height: ph })
    } else {
      const top = Math.min(TOP_OFFSET, h)
      this.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) })
    }
  }

  /** 打开抖音页面的开发者工具（调试用） */
  openDevTools(): void {
    if (this.view) this.view.webContents.openDevTools({ mode: 'detach' })
  }

  dispose(): void {
    if (this.view) {
      this.host.contentView.removeChildView(this.view)
      this.view = null
    }
  }
}
