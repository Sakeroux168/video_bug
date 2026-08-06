import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

/** R11-4：验证码识别正则（导出供测试与页面脚本共用）——验证码/滑动验证/安全验证/拖动滑块/请完成验证 */
export const VERIFY_TEXT_PATTERN = /验证码|滑动验证|安全验证|拖动滑块|请完成验证/i

/** R11-4：页面加载强制超时毫秒（loadURL 挂起/页面卡死时不永久卡任务） */
export const LOAD_TIMEOUT_MS = 30000
/** R11-4：滚动脚本强制超时毫秒（超时视为滚动结束返回，防循环永久卡死） */
export const SCROLL_TIMEOUT_MS = 60000

/** R11-4：长操作强制超时——Promise.race 竞速，超时侧 reject 带 code=OP_TIMEOUT 的标记错误（不引入依赖） */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label}超时（${ms}ms）`), { code: 'OP_TIMEOUT' })), ms)
    )
  ])
}

export class VideoBrowser {
  private win: BrowserWindow | null = null
  // 首次显示前定位到主窗口右侧；之后尊重用户拖拽/缩放后的位置，不再重置
  private positioned = false
  // T4：窗口是否已显示过——首次显示必须 show()（showInactive 对从未显示的窗口是空操作），随后 blur 不抢焦点
  private everShown = false
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
    // 独立普通窗口（不带 parent：Windows 上带 parent 的 owned window 永远盖在父窗口上层，
    // 用户抱怨抖音窗口一直挡在程序上方；去 parent 后点谁谁在上）。初始隐藏，由 setVisible/focus 唤起。
    // 最小尺寸 = 抖音搜索页布局下限（实测窗口缩小时页面不缩放、右侧布局被裁出窗外）。
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 760,
      minWidth: 900,
      minHeight: 600,
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
    // R11-4：页面加载 30s 强制超时——loadURL 永不 resolve（网络挂起/页面卡死）时不永久卡住；
    // 超时抛 code=OP_TIMEOUT 标记错误，调度器按"加载失败"处理（重搜超时计数消耗后继续）
    await withTimeout(this.win.loadURL(url), LOAD_TIMEOUT_MS, '页面加载')
  }

  /** 渐进滚动到底：滚 window + 所有可滚容器，多轮小步，并点击"加载更多"，尽力触发抖音加载更多。
   *  waitMs：滚到底后等当页新内容进来自动进下一轮的 waitForGrowth 超时（默认 8000，对应"每页最大等待秒数"设置）。
   *  暂停即时：脚本开头清 __scrollAborted 并注册 message 监听，pause() 经 abortScroll() 置位后下个检查点即退出 */
  async scrollToBottom(opts?: { waitMs?: number }): Promise<void> {
    if (!this.win) return
    const waitMs = opts?.waitMs ?? 8000
    const pollMs = Math.max(100, Math.round(waitMs / 32)) // 轮询间隔随超时缩放：8s→250ms，3s→~100ms
    const script = `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // 中止信号（暂停即时）：pause() → 主进程 send → preload postMessage → 这里置位；循环每步检查，置位立即 break
      window.__scrollAborted = false;
      const onAbort = (e) => {
        try { if (e.data && e.data.type === 'dy:scroll-abort') window.__scrollAborted = true; } catch (err) {}
      };
      window.addEventListener('message', onAbort);
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
      // A3：滚到底后轮询等当页加载——每 pollMs 一次，最多等 waitMs（默认 8s，设置页可调）；
      // 有增长（高度/条目数变化）立即返回 true 提前进下一轮；无增长超时也返回，防卡死
      const waitForGrowth = async (base) => {
        const deadline = Date.now() + ${waitMs};
        let last = base;
        while (Date.now() < deadline) {
          if (window.__scrollAborted) return false; // 中止：立即退出等增长，交还控制权
          await sleep(${pollMs});
          const cur = snapshot();
          if (cur.h > last.h || cur.items > last.items) return true;
          last = cur;
        }
        return false;
      };
      // 放慢节奏：单步小、间隔长，每轮到底后等当页结果加载完再滚下一轮，避免漏抓
      try {
        for (let round = 0; round < 4; round++) {
          if (window.__scrollAborted) break; // 每轮顶部检查中止
          for (let i = 0; i < 10; i++) {
            if (window.__scrollAborted) break; // 每步顶部检查中止
            targets.forEach(t => { try { t.scrollTop += 500; } catch (e) {} });
            wheel(500);
            await sleep(550); // R12：步间延迟 450→550ms 放慢降风控
          }
          if (window.__scrollAborted) break;
          targets.forEach(t => { try { t.scrollTop = t.scrollHeight; } catch (e) {} });
          wheel(1500);
          clickMore();
          await waitForGrowth(snapshot());
        }
      } finally {
        // 防泄漏：正常结束或中止退出都移除监听，脚本多次执行不叠加
        window.removeEventListener('message', onAbort);
      }
      if (!window.__scrollAborted) await sleep(1500); // 最后再等一拍，等网络/渲染落定；已中止则立即返回
      return targets.length;
    })()`
    // R11-4：整体 60s 强制超时——脚本异常挂起（页面 JS 死循环等）视为滚动结束返回，防循环永久卡死
    await Promise.race([
      this.win.webContents.executeJavaScript(script).catch(() => {}),
      new Promise<void>(resolve => setTimeout(resolve, SCROLL_TIMEOUT_MS))
    ])
  }

  /**
   * R11-4：验证码识别——扫 DOM 文本匹配 /验证码|滑动验证|安全验证|拖动滑块|请完成验证/i
   * （可见性 + 视口校验，复用 findBottomText 的 inView 模式），命中返回匹配文本。
   * 验证码可能在任何时刻弹出（不只停滞时），由 scheduler 心跳每 2s 查一次。
   */
  async findVerifyIndicator(): Promise<string | null> {
    if (!this.win) return null
    const script = `(() => {
      const re = ${VERIFY_TEXT_PATTERN.toString()};
      // 可见 + 视口内：宽高 > 0（排除 display:none/visibility:hidden）且与视口相交
      const inView = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
      };
      const body = document.body;
      if (!body) return null;
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const el = node.parentElement;
          return el && !skip.has(el.tagName) && inView(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = (node.textContent || '').trim();
        if (t && re.test(t)) return t.slice(0, 30);
      }
      return null;
    })()`
    try {
      const r = await this.win.webContents.executeJavaScript(script)
      return typeof r === 'string' && r.length > 0 ? r : null
    } catch { return null }
  }

  /** 通知页面滚动脚本立即中止（fire-and-forget，不等待脚本返回）：
   *  webContents.send('dy:scroll-abort') → preload（隔离世界）→ window.postMessage → 主世界滚动脚本置 __scrollAborted，
   *  滚动循环在下个检查点退出（步间隔 ≤550ms，暂停 1 秒内生效） */
  abortScroll(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send('dy:scroll-abort')
  }

  /**
   * 显示/隐藏抖音窗口。程序化调用一律不抢焦点，避免盖住用户正在打字/看文件的窗口；
   * 仅用户主动切到浏览器标签时传 focus=true（show 激活窗口）。
   * 首次显示：showInactive（SW_SHOWNOACTIVATE）对从未显示过的窗口是空操作 → 必须 show() 才真正显示，
   * 显示后立即 blur() 解除激活态，不抢用户焦点；之后再显示才用 showInactive。
   */
  setVisible(v: boolean, focus = false): void {
    if (!this.win || this.win.isDestroyed()) return
    if (v) {
      // 首次显示前定位到主窗口右侧；之后不再重置，保留用户拖拽后的位置
      if (!this.positioned) {
        const b = this.host.getBounds()
        const wa = screen.getPrimaryDisplay().workArea
        const w = this.win.getBounds()
        let x: number
        let y: number
        // 主窗口不可见/最小化：直接放主显示器 workArea 居中（无 parent 依赖，独立窗口位置自理；避免定位到不可见宿主旁产生越界坐标）
        if (!this.host.isVisible() || this.host.isMinimized()) {
          x = wa.x + Math.round((wa.width - w.width) / 2)
          y = wa.y + Math.round((wa.height - w.height) / 2)
        } else {
          x = b.x + b.width + 24
          y = b.y
          // 钳制到 workArea 内：主窗口右侧放不下（x 越界）→ 回退主窗口左侧 → 仍越界则贴右缘；y 同理贴下缘
          if (x + w.width > wa.x + wa.width) {
            x = b.x - w.width - 24
            if (x < wa.x) x = wa.x + wa.width - w.width
          }
          if (y + w.height > wa.y + wa.height) {
            y = wa.y + wa.height - w.height
            if (y < wa.y) y = wa.y
          }
        }
        this.win.setPosition(x, y)
        this.positioned = true
      }
      if (!this.everShown) {
        this.everShown = true
        this.win.show()
        // 显示后一拍再 blur：窗口已可见但焦点回到用户之前的窗口，不打断用户操作
        setImmediate(() => {
          if (!focus && this.win && !this.win.isDestroyed()) this.win.blur()
        })
      } else if (focus) {
        this.win.show()
      } else {
        this.win.showInactive()
      }
    } else {
      this.win.hide()
    }
  }

  /** 扫描全 DOM 找"到底"文案（如抖音「暂时没有更多了」），命中返回截断 30 字的文本，否则 null。
   *  与"X 秒无新视频"先到先触发：命中说明搜索已到底，应触发重搜自救（忽略重搜冷却立即重搜）。
   *  可见性 + 视口校验：抖音把提示常驻 DOM 但隐藏（display:none/visibility:hidden，rect 宽高 0），
   *  且未滚到底时提示在视口外——隐藏/视口外文本不算命中，避免「还没到底就触发重搜」。
   *  快速路径：先查真实元素 div.nU717OFZ（含同样校验，命中直接返回），再走文字正则扫描。 */
  async findBottomText(): Promise<string | null> {
    if (!this.win) return null
    const script = `(() => {
      const re = /没有更多|到底|暂时没有/i;
      // 可见 + 视口内：宽高 > 0（排除 display:none/visibility:hidden）且与视口相交（排除滚到底前就存在的隐藏提示）
      const inView = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
      };
      // 快速路径：真实元素 css 候选（抖音实测 div.nU717OFZ），同样校验可见性 + 视口
      try {
        const real = document.querySelector('div.nU717OFZ');
        if (real && inView(real)) {
          const t = (real.textContent || '').trim();
          if (t && re.test(t)) return t.slice(0, 30);
        }
      } catch (e) {}
      const body = document.body;
      if (!body) return null;
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const el = node.parentElement;
          return el && !skip.has(el.tagName) && inView(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = (node.textContent || '').trim();
        if (t && re.test(t)) return t.slice(0, 30);
      }
      return null;
    })()`
    try {
      const r = await this.win.webContents.executeJavaScript(script)
      return typeof r === 'string' && r.length > 0 ? r : null
    } catch { return null }
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
