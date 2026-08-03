import { BrowserWindow } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

export class VideoBrowser {
  private win: BrowserWindow | null = null
  // 首次显示前定位到主窗口右侧；之后尊重用户拖拽/缩放后的位置，不再重置
  private positioned = false
  // 主动销毁开关：dispose 时置 true，避免 close 拦截把销毁变成隐藏
  private forceClose = false

  constructor(
    private host: BrowserWindow,
    private onRaw: (url: string, json: unknown) => void,
    private inject: string = INJECT_SCRIPT
  ) {
    // 不再依赖宿主窗口布局：独立子窗口自行定位，无需订阅 resize
  }

  async init(): Promise<void> {
    // 独立可拖拽子窗口：以主窗口为 parent（总是盖在主窗口上层），初始隐藏，由 setVisible/focus 唤起
    const win = new BrowserWindow({
      parent: this.host,
      show: false,
      width: 480,
      height: 760,
      minWidth: 320,
      minHeight: 480,
      title: '抖音浏览器',
      webPreferences: {
        partition: 'persist:douyin',
        preload: join(__dirname, '../preload/douyin.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.win = win

    const wc = win.webContents
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
    // 更早注入：dom-ready 时机比 did-finish-load 早，避免错过页面启动后立即发起的接口
    wc.on('dom-ready', () => {
      void wc.executeJavaScript(this.inject).catch(() => { /* ignore */ })
    })

    // 点「×」只隐藏不销毁：登录态与页面状态保留，重新显示无需重载，也不影响主窗口关闭逻辑
    win.on('close', (e) => {
      if (!this.forceClose) {
        e.preventDefault()
        win.hide()
      }
    })
  }

  async load(adapter: PlatformAdapter, url: string): Promise<void> {
    if (!this.win) throw new Error('browser_not_initialized')
    await this.win.loadURL(url)
  }

  /** 渐进滚动到底：滚 window + 所有可滚容器，多轮小步，并点击"加载更多"，尽力触发抖音加载更多 */
  async scrollToBottom(): Promise<void> {
    if (!this.win) return
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
      // A3：快照主滚动高度 + 各列表容器子元素总数，用于判断滚到底后当页是否还有新内容进来
      const snapshot = () => {
        let h = 0;
        let items = 0;
        try { h = sc ? sc.scrollHeight : 0; } catch (e) {}
        for (const el of bigs) { try { items += el.children.length; } catch (e) {} }
        return { h: h, items: items };
      };
      // A3：滚到底后轮询等当页加载——250ms 一次，最多等 4s；
      // 有增长（高度/条目数变化）立即返回 true 提前进下一轮；无增长超时也返回，防卡死
      const waitForGrowth = async (base) => {
        const deadline = Date.now() + 4000;
        let last = base;
        while (Date.now() < deadline) {
          await sleep(250);
          const cur = snapshot();
          if (cur.h > last.h || cur.items > last.items) return true;
          last = cur;
        }
        return false;
      };
      // 放慢节奏：单步小、间隔长，每轮到底后等当页结果加载完再滚下一轮，避免漏抓
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 10; i++) {
          targets.forEach(t => { try { t.scrollTop += 500; } catch (e) {} });
          wheel(500);
          await sleep(450);
        }
        targets.forEach(t => { try { t.scrollTop = t.scrollHeight; } catch (e) {} });
        wheel(1500);
        clickMore();
        await waitForGrowth(snapshot());
      }
      await sleep(1500); // 最后再等一拍，等网络/渲染落定
      return targets.length;
    })()`
    await this.win.webContents.executeJavaScript(script).catch(() => {})
  }

  /**
   * 显示/隐藏抖音窗口。程序化调用一律不抢焦点（showInactive），
   * 避免盖住用户正在打字/看文件的窗口；仅用户主动切到浏览器标签时传 focus=true（show 激活窗口）。
   * 注意：showInactive 对已显示的窗口是无操作且安全的
   */
  setVisible(v: boolean, focus = false): void {
    if (!this.win || this.win.isDestroyed()) return
    if (v) {
      // 首次显示前定位到主窗口右侧；之后不再重置，保留用户拖拽后的位置
      if (!this.positioned) {
        const b = this.host.getBounds()
        this.win.setPosition(b.x + b.width + 24, b.y)
        this.positioned = true
      }
      if (focus) this.win.show()
      else this.win.showInactive()
    } else {
      this.win.hide()
    }
  }

  /** 打开抖音页面的开发者工具（调试用） */
  openDevTools(): void {
    if (this.win) this.win.webContents.openDevTools({ mode: 'detach' })
  }

  dispose(): void {
    if (this.win) {
      this.forceClose = true
      this.win.destroy()
      this.win = null
    }
  }
}
