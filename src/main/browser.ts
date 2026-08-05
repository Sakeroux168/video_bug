import { BrowserWindow, screen, type WebContents } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { FILTER_SELECTORS } from './adapters/douyin'
import type { DouyinFilter } from '../shared/types'
import { INJECT_SCRIPT } from './injector'

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
            await sleep(450);
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
    await this.win.webContents.executeJavaScript(script).catch(() => {})
  }

  /** 通知页面滚动脚本立即中止（fire-and-forget，不等待脚本返回）：
   *  webContents.send('dy:scroll-abort') → preload（隔离世界）→ window.postMessage → 主世界滚动脚本置 __scrollAborted，
   *  滚动循环在下个检查点退出（步间隔 ≤450ms，暂停 1 秒内生效） */
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
        // 主窗口不可见/最小化：直接放主显示器 workArea 居中（子窗口随最小化宿主自动隐藏，但避免残留越界坐标）
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

  /** 扫描全 DOM 文本节点找底部文案（如抖音「暂时没有更多了」），命中返回截断 30 字的文本，否则 null。
   *  与"15 秒无新视频"先到先触发：命中说明搜索已到底，应触发筛选续爬 */
  async findBottomText(): Promise<string | null> {
    if (!this.win) return null
    const script = `(() => {
      const re = /没有更多|到底|暂时没有/i;
      const body = document.body;
      if (!body) return null;
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const el = node.parentElement;
          return el && skip.has(el.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
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

  /**
   * 注入脚本操作抖音搜索筛选面板（T3/T4 筛选续爬，CDP 真实鼠标优先）：
   * 筛选面板是 CSS :hover 驱动，合成 mouseover/mouseenter/mousemove 事件不触发真实 hover（面板不出现）→
   * 改走 CDP Input.dispatchMouseEvent 发真实鼠标输入：attach('1.3') → executeJavaScript 取按钮中心（viewport 坐标）
   * → mouseMoved 悬停 → 轮询面板出现（250ms×20）→ 逐选项（index>0）取中心 → mouseMoved + mousePressed/mouseReleased
   * 真实点击 → 等 2.5s 页面刷新 → finally detach。
   * debugger attach 失败（如已开调试控制台）→ 回退旧合成事件方案；仍失败返回 false，由调度侧 notice 兜底。
   * 返回 false：按钮找不到/面板 5s 内不出现/任一需要点的选项缺失（页面结构可能已变），调用方按原逻辑停止
   */
  async applyDouyinFilter(sel: typeof FILTER_SELECTORS, f: DouyinFilter): Promise<boolean> {
    if (!this.win) return false
    // 组号：1发布时间/2时长/3搜索范围/4内容形式（组 0=排序不操作）；选项 data-index2 即配置索引
    const pairs: Array<[number, number]> = []
    if (f.publishTime > 0) pairs.push([1, f.publishTime])
    if (f.duration > 0) pairs.push([2, f.duration])
    if (f.searchScope > 0) pairs.push([3, f.searchScope])
    if (f.contentType > 0) pairs.push([4, f.contentType])
    const optionSelectors = pairs.map(([g, o]) => sel.option(g, o))
    const wc = this.win.webContents
    // CDP 优先：真实鼠标输入才触发 :hover 面板；attach 失败（如已开调试控制台）→ 回退合成事件方案
    let attached = false
    try {
      wc.debugger.attach('1.3')
      attached = true
      return await this.cdpFilterPath(wc, sel, optionSelectors)
    } catch {
      // 仅 attach 失败回退合成事件；CDP 已跑起来后的异常（sendCommand/取坐标失败）直接算失败
      return attached ? false : this.legacyFilterPath(wc, sel, optionSelectors)
    } finally {
      if (attached) {
        try { wc.debugger.detach() } catch { /* detach 失败忽略 */ }
      }
    }
  }

  /** CDP 真实鼠标流程（attach 已成功）：取按钮中心 → mouseMoved 悬停 → 轮询面板出现 → 逐选项真实点击 → 等刷新。
   *  坐标取 getBoundingClientRect() 中心：CSS 像素即 viewport 坐标，与 Input.dispatchMouseEvent 一致（页面缩放不影响） */
  private async cdpFilterPath(wc: WebContents, sel: typeof FILTER_SELECTORS, optionSelectors: string[]): Promise<boolean> {
    const d = wc.debugger
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    // 取元素中心坐标（executeJavaScript 返回 null = 找不到）。
    // scrollFirst：先 scrollIntoView 居中再取坐标——触发场景恰是"搜索到底"（页面停在底部），
    // 筛选栏非 sticky 时按钮在视口外，CDP 真实鼠标打到视口外坐标悬停不到；sticky 场景是 no-op 无害。
    // 选项不滚动：面板已悬停弹出，滚动页面会把按钮移出鼠标位置导致面板收起
    const center = async (selector: string, scrollFirst = false): Promise<{ x: number; y: number } | null> => {
      const r = await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ${scrollFirst ? "el.scrollIntoView({ block: 'center' });" : ''}const c = el.getBoundingClientRect(); return { x: c.left + c.width / 2, y: c.top + c.height / 2 }; })()`
      )
      return (r as { x: number; y: number } | null)
    }
    // 真实鼠标点击：悬停到位后按下/松开（clickCount:1 = 一次完整 click）
    const realClick = async (x: number, y: number): Promise<void> => {
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y })
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y })
    }
    // 悬停筛选按钮（先 scrollIntoView 防"搜索到底"时按钮在视口外）→ 轮询面板出现（250ms×20 = 5s，面板只认真实 hover）
    const btn = await center(sel.button, true)
    if (!btn) return false
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y })
    let shown = false
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      const has = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(sel.panel)})`)
      if (has) { shown = true; break }
    }
    if (!shown) return false
    // 面板布局落定一拍再点首选项（渲染/定位未稳时取到的 rect 可能过期）
    await sleep(100)
    // 逐组选项（index>0）：悬停 + 按下/松开即真实点击，找不到直接失败
    for (const s of optionSelectors) {
      const pos = await center(s)
      if (!pos) return false
      await realClick(pos.x, pos.y)
      await sleep(200)
    }
    // 等筛选条件生效、fetch 触发页面刷新（约 2.5s）
    await sleep(2500)
    return true
  }

  /** 旧方案兜底（debugger attach 失败时）：合成 mouseover/mouseenter/mousemove 弹面板 + click 点选项；
   *  非 :hover 驱动的场景下仍可用；仍失败返回 false 由调度侧 notice 兜底 */
  private async legacyFilterPath(wc: WebContents, sel: typeof FILTER_SELECTORS, optionSelectors: string[]): Promise<boolean> {
    const script = '(async () => {' +
      'const sleep = ms => new Promise(r => setTimeout(r, ms));' +
      `const button = document.querySelector(${JSON.stringify(sel.button)});` +
      'if (!button) return false;' +
      // hover 弹出：事件坐标取元素中心，模拟真实鼠标悬停（部分面板由 mouseover/enter/move 触发）
      'const c = button.getBoundingClientRect();' +
      'const evt = { bubbles: true, cancelable: true, clientX: c.left + c.width / 2, clientY: c.top + c.height / 2 };' +
      "button.dispatchEvent(new MouseEvent('mouseover', evt));" +
      "button.dispatchEvent(new MouseEvent('mouseenter', evt));" +
      "button.dispatchEvent(new MouseEvent('mousemove', evt));" +
      // 等筛选面板出现（最多 3s）
      'const waitPanel = async () => {' +
      `for (let i = 0; i < 20; i++) { const p = document.querySelector(${JSON.stringify(sel.panel)}); if (p) return p; await sleep(150); }` +
      'return null;' +
      '};' +
      'let panel = await waitPanel();' +
      // click 兼容：hover 未弹出则退回 click 再等一次
      'if (!panel) { button.click(); panel = await waitPanel(); }' +
      'if (!panel) return false;' +
      'let ok = true;' +
      `const sels = ${JSON.stringify(optionSelectors)};` +
      'for (const s of sels) {' +
      'const el = document.querySelector(s);' +
      'if (el) { el.click(); } else { ok = false; }' +
      '}' +
      // 等筛选条件生效、fetch 触发页面刷新（约 2.5s）
      'await sleep(2500);' +
      'return ok;' +
      '})()'
    try {
      return !!(await wc.executeJavaScript(script))
    } catch { return false }
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
