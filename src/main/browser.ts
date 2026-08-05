import { BrowserWindow, screen, type WebContents } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { FILTER_SELECTORS, resolveSelector, describeCandidate, optionLabel, type FilterCandidate } from './adapters/douyin'
import type { DouyinFilter } from '../shared/types'
import { INJECT_SCRIPT } from './injector'

/** 选项点击脚本重试配置（默认面板/选项各 200ms×10 = 最多 2s 等渲染；测试可调小） */
export interface ClickOptionsRetries {
  panel?: number
  option?: number
}

/** 选项点击脚本（单次 executeJavaScript 完成「面板重找 + 逐选项查找 + el.click」）：
 *  hover 弹层在两次 executeJavaScript 调用间隙（sleep + IPC 往返）会关闭——「面板出现」与「点选项」分两次调用
 *  会报「面板未找到」，合并为一次脚本执行杜绝间隙丢面板；面板/选项各带 200ms×N 重试等待渲染；
 *  命中后 el.click()（React 响应程序化 click，选项无需真实鼠标）。
 *  返回 { ok, panelFound, panelLost, clicked: 选项下标[], missing: 选项下标[] }：
 *  panelFound=false = 面板自始未找到；panelLost=true = 首次找到但脚本执行期间关闭（调用方据此重新悬停按钮重试整批）。
 *  find 即 resolveSelector 的 toString 嵌入（与单测同一份逻辑），rectOf 做可见性校验（隐藏面板不算出现）。 */
export function buildClickOptionsScript(
  sel: typeof FILTER_SELECTORS,
  options: Array<{ label: string; cands: readonly FilterCandidate[] }>,
  retries: ClickOptionsRetries = {}
): string {
  const panelRetries = retries.panel ?? 10
  const optionRetries = retries.option ?? 10
  const panelCands = JSON.stringify(sel.panel)
  const opts = JSON.stringify(options.map(o => o.cands))
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const find = ${resolveSelector.toString()};
    const textOf = el => (el.textContent || '').trim();
    const rectOf = el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
    const panelCands = ${panelCands};
    const opts = ${opts};
    // 面板：200ms×${panelRetries} 重试等出现（脚本启动时弹层可能在间隙中关闭，短暂重试即可复得）
    let panel = null;
    for (let i = 0; i < ${panelRetries} && !panel; i++) {
      const p = find(panelCands, document, textOf, null, rectOf);
      if (p.el) { panel = p.el; break; }
      await sleep(200);
    }
    if (!panel) return { ok: false, panelFound: false, panelLost: false, clicked: [], missing: opts.map((_, i) => i) };
    let ok = true;
    const clicked = [];
    const missing = [];
    // 逐选项：面板内候选查找（200ms×${optionRetries} 重试等渲染）+ el.click（React 响应程序化 click）
    for (let i = 0; i < opts.length; i++) {
      let el = null;
      for (let j = 0; j < ${optionRetries} && !el; j++) {
        const r = find(opts[i], document, textOf, panel, rectOf);
        if (r.el) { el = r.el; break; }
        await sleep(200);
      }
      if (el) {
        try { el.click(); clicked.push(i); } catch (e) { missing.push(i); ok = false; }
      } else {
        missing.push(i); ok = false;
      }
      await sleep(150); // 让 React 处理点击/下拉状态更新再点下一个
    }
    // panelLost：首次面板找到但脚本执行期间关闭（hover 弹层收起）
    const still = find(panelCands, document, textOf, null, rectOf);
    return { ok, panelFound: true, panelLost: !still.el, clicked, missing };
  })()`
}

export class VideoBrowser {
  private win: BrowserWindow | null = null
  // 首次显示前定位到主窗口右侧；之后尊重用户拖拽/缩放后的位置，不再重置
  private positioned = false
  // T4：窗口是否已显示过——首次显示必须 show()（showInactive 对从未显示的窗口是空操作），随后 blur 不抢焦点
  private everShown = false
  // 主动销毁开关：dispose 时置 true，避免 close 拦截把销毁变成隐藏
  private forceClose = false
  /** 筛选流程互斥锁：同一 webContents 的 CDP attach 排他，自动触发（scheduler）与手动测试（debug:testFilter）
   *  并发时后到者直接失败，避免真实鼠标事件互相干扰导致诊断失真/任务误停 */
  private filterInFlight = false

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
    // 最小尺寸 = 抖音搜索页布局下限（实测窗口缩小时页面不缩放、右侧布局被裁出窗外，筛选键跑到窗外）；
    // 900 为防布局溢出裁剪的下限，如仍偏小可微调，勿低于 860。
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
   * 返回 false：按钮找不到/面板 5s 内不出现/任一需要点的选项缺失（页面结构可能已变），调用方按原逻辑停止。
   * 互斥锁被拒（上一次筛选未结束）时抛 code='FILTER_BUSY' 的错误（与真实失败区分），调用方应稍后重试。
   * onLog：全链路诊断日志回调（每步 CDP 交互都打点，调度侧汇入界面「查看拦截日志」面板）
   */
  async applyDouyinFilter(sel: typeof FILTER_SELECTORS, f: DouyinFilter, onLog?: (msg: string) => void): Promise<boolean> {
    const log = (msg: string): void => { onLog?.(msg) }
    // 互斥锁：一次只允许一个筛选流程在跑（自动触发与手动测试共用入口，天然互斥）。
    // CDP attach 对同一 webContents 排他，并发会让后到者静默回退 legacy、真实鼠标事件互相干扰。
    // 被拒时抛带 code=FILTER_BUSY 的错误（与"真实失败"区分）：调度侧据此不消耗 filterApplied、不停止，下一轮重试
    if (this.filterInFlight) {
      log('筛选流程进行中（上一次未结束），本次跳过（FILTER_BUSY）')
      const err = new Error('filter_busy') as Error & { code: string }
      err.code = 'FILTER_BUSY'
      throw err
    }
    this.filterInFlight = true
    try {
      return await this.applyDouyinFilterLocked(sel, f, log)
    } finally {
      this.filterInFlight = false
    }
  }

  /** 互斥锁已持有后的实际筛选流程（含 CDP 优先 / 合成事件回退） */
  private async applyDouyinFilterLocked(sel: typeof FILTER_SELECTORS, f: DouyinFilter, log: (msg: string) => void): Promise<boolean> {
    if (!this.win) { log('浏览器窗口不存在，无法执行筛选'); return false }
    // 组号：1发布时间/2时长/3搜索范围/4内容形式（组 0=排序不操作）；选项 data-index2 即配置索引
    const pairs: Array<[number, number]> = []
    if (f.publishTime > 0) pairs.push([1, f.publishTime])
    if (f.duration > 0) pairs.push([2, f.duration])
    if (f.searchScope > 0) pairs.push([3, f.searchScope])
    if (f.contentType > 0) pairs.push([4, f.contentType])
    if (pairs.length === 0) { log('筛选配置全为不限（各维度 0），无需操作，直接视为成功'); return true }
    // 每个选项是候选数组：语义属性优先，找不到时按选项名映射在面板内文字匹配
    const options = pairs.map(([g, o]) => ({ label: optionLabel(g, o), cands: sel.option(g, o) }))
    log(`开始执行筛选流程，待点选项 ${options.length} 个：${options.map(o => o.label).join('，')}`)
    const wc = this.win.webContents
    // CDP 优先：真实鼠标输入才触发 :hover 面板；attach 失败（如已开调试控制台）→ 回退合成事件方案
    let attached = false
    try {
      wc.debugger.attach('1.3')
      attached = true
      log('CDP attach 成功（协议 1.3）')
      const r = await this.cdpFilterPath(wc, sel, options, log)
      log(`CDP 路径执行完成 → ${r ? '成功' : '失败'}`)
      return r
    } catch (err) {
      // 仅 attach 失败回退合成事件；CDP 已跑起来后的异常（sendCommand/取坐标失败）直接算失败
      if (attached) {
        log(`CDP 路径执行异常 → 失败（${String(err)}）`)
        return false
      }
      log(`CDP attach 失败（${String(err)}），回退合成事件方案`)
      const r = await this.legacyFilterPath(wc, sel, options, log)
      log(`合成事件回退路径执行完成 → ${r ? '成功' : '失败'}`)
      return r
    } finally {
      if (attached) {
        try { wc.debugger.detach() } catch { /* detach 失败忽略 */ }
        log('CDP detach 完成')
      }
    }
  }

  /** 页面内依次尝试候选找元素并返回中心坐标（CDP 真实鼠标用）。
   *  cands：目标候选（css 哈希类 → 文字/语义属性兜底）；scopeCands：非空时先找 scope 容器（面板）再在其内找目标（文字选项限定面板内）。
   *  scrollFirst：先 scrollIntoView 居中再取坐标（仅按钮用——触发场景恰是"搜索到底"（页面停在底部），
   *  筛选栏非 sticky 时按钮在视口外，CDP 真实鼠标打到视口外坐标悬停不到；sticky 场景是 no-op 无害。
   *  选项不滚动：面板已悬停弹出，滚动页面会把按钮移出鼠标位置导致面板收起）。
   *  页面脚本里的 find 即 resolveSelector 的 toString 嵌入（与单测同一份逻辑），并注入 rectOf 做可见性校验：
   *  CSS :hover 驱动的筛选面板大概率常驻 DOM 但隐藏（display:none/visibility:hidden，rect 宽高为 0），
   *  命中但不可见视为未命中，防止轮询假命中 → 坐标全 0 → realClick 打到 (0,0) 的静默假成功。
   *  返回：ok=true 带中心坐标/命中下标；ok=false 时 scopeFound 区分容器未命中/目标未命中，
   *  hitIndex >= 0 = 目标候选「命中但不可见」（打点用），-1 = 完全未命中。 */
  private async locateElement(
    wc: WebContents,
    cands: readonly FilterCandidate[],
    opts: { scopeCands?: readonly FilterCandidate[]; scrollFirst?: boolean } = {}
  ): Promise<{ ok: true; x: number; y: number; index: number } | { ok: false; scopeFound: boolean; hitIndex: number }> {
    // scope 先找面板再在其内找目标；scope 未命中即返回（打点区分「面板未找到」与「选项候选未命中」）
    const scopePart = opts.scopeCands
      ? `const sc = find(${JSON.stringify(opts.scopeCands)}, document, textOf, null, rectOf); if (!sc.el) return { found: false, scopeFound: false, hitIndex: -1 };`
      : 'const sc = null;'
    const scrollPart = opts.scrollFirst ? "el.scrollIntoView({ block: 'center' });" : ''
    const script = `(() => {
      const find = ${resolveSelector.toString()};
      const textOf = el => (el.textContent || '').trim();
      // 可见性校验：display:none/visibility:hidden 的常驻 DOM 元素 rect 宽高为 0，视为未命中
      const rectOf = el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
      ${scopePart}
      const r = find(${JSON.stringify(cands)}, document, textOf, sc, rectOf);
      if (!r.el) return { found: false, scopeFound: true, hitIndex: r.index };
      const el = r.el;
      ${scrollPart}
      const c = el.getBoundingClientRect();
      return { found: true, x: c.left + c.width / 2, y: c.top + c.height / 2, index: r.index };
    })()`
    const r = (await wc.executeJavaScript(script).catch(() => null)) as
      | { found: true; x: number; y: number; index: number }
      | { found: false; scopeFound: boolean; hitIndex: number }
      | null
    if (!r) return { ok: false, scopeFound: false, hitIndex: -1 }
    if (!r.found) return { ok: false, scopeFound: r.scopeFound, hitIndex: r.hitIndex }
    return { ok: true, x: r.x, y: r.y, index: r.index }
  }

  /** 候选依次尝试打点：候选1 css("span.bR4uhU1W")未命中 → 候选2 文字"筛选"命中；hitIndex=-1 表示全部未命中 */
  private candidateHitText(cands: readonly FilterCandidate[], hitIndex: number): string {
    return cands.map((c, i) => `候选${i + 1} ${describeCandidate(c)}${i === hitIndex ? '命中' : '未命中'}`).join(' → ')
  }

  /** 定位失败打点：hitIndex>=0 = 候选命中但不可见（rect 宽高 0，疑似 display:none 的常驻隐藏元素）；
   *  否则候选均未命中 */
  private failHitText(cands: readonly FilterCandidate[], hitIndex: number): string {
    if (hitIndex >= 0) {
      return `候选${hitIndex + 1} 命中但不可见（rect 宽高为 0，疑似 display:none/visibility:hidden 的常驻 DOM 元素）`
    }
    return this.candidateHitText(cands, -1)
  }

  /** 执行选项点击脚本并返回明细（脚本异常/未返回 → null） */
  private async runClickOptionsScript(
    wc: WebContents,
    sel: typeof FILTER_SELECTORS,
    options: Array<{ label: string; cands: readonly FilterCandidate[] }>
  ): Promise<{ ok: boolean; panelFound: boolean; panelLost: boolean; clicked: number[]; missing: number[] } | null> {
    const r = (await wc.executeJavaScript(buildClickOptionsScript(sel, options)).catch(() => null)) as
      | { ok: boolean; panelFound: boolean; panelLost: boolean; clicked: number[]; missing: number[] }
      | null
    return r
  }

  /** 选项点击 + 面板丢失重试（CDP 路径用）：
   *  选项由单次脚本完成（面板重找 + 逐选项 el.click，杜绝两次调用间隙 hover 弹层关闭导致「面板未找到」）；
   *  panelLost（首次面板找到但脚本执行期间弹层关闭）→ 重新 CDP 悬停按钮 → 面板轮询 → 重跑整批，最多 3 次；
   *  面板在但选项缺失（页面结构问题）或面板自始未找到 → 重试无益，直接失败。
   *  hover：真实鼠标悬停回调（cdpFilterPath 传 mouseMoved sendCommand；合成事件路径不重试） */
  private async clickOptionsWithRetry(
    wc: WebContents,
    sel: typeof FILTER_SELECTORS,
    options: Array<{ label: string; cands: readonly FilterCandidate[] }>,
    hover: (x: number, y: number) => Promise<void>,
    log: (msg: string) => void
  ): Promise<boolean> {
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.runClickOptionsScript(wc, sel, options)
      if (!r) { log('选项点击脚本未返回结果（页面无响应）→ 失败'); return false }
      const clickedText = r.clicked.map(i => options[i].label).join('，') || '无'
      const missingText = r.missing.map(i => options[i].label).join('，') || '无'
      log(`选项点击脚本（第 ${attempt + 1} 次）：面板找到=${r.panelFound}，点击=${clickedText}，缺失=${missingText}${r.panelLost ? '，面板在脚本执行期间关闭（panelLost）' : ''} → ${r.ok ? '成功' : '失败'}`)
      if (r.ok) return true
      // 面板在但选项缺失 = 结构性问题，重试无益；面板自始未找到同样直接失败
      if (!r.panelLost || !r.panelFound) return false
      if (attempt >= 2) break
      log(`面板在选项脚本执行期间关闭（panelLost），重新悬停按钮并重试整批（第 ${attempt + 1} 次失败，上限 3 次）...`)
      const btn = await this.locateElement(wc, sel.button, { scrollFirst: true })
      if (!btn.ok) { log(`重新悬停前筛选按钮未找到（${this.failHitText(sel.button, btn.hitIndex)}）→ 放弃重试`); return false }
      await hover(btn.x, btn.y)
      log(`已重新发送真实鼠标悬停（${Math.round(btn.x)}, ${Math.round(btn.y)}）`)
      let shown = false
      for (let i = 0; i < 20; i++) {
        await sleep(250)
        const p = await this.locateElement(wc, sel.panel)
        if (p.ok) { shown = true; break }
      }
      if (!shown) { log('重新悬停后面板未出现 → 放弃重试'); return false }
      await sleep(100) // 面板布局落定一拍
    }
    log('选项点击 3 次整批重试仍失败 → 判定失败')
    return false
  }

  /** CDP 真实鼠标流程（attach 已成功）：取按钮中心 → mouseMoved 悬停 → 轮询面板出现 → 逐选项真实点击 → 等刷新。
   *  按钮/面板/选项均按多候选依次尝试（哈希类名 → 文字/语义属性兜底），每步打点候选命中情况。
   *  坐标取 getBoundingClientRect() 中心：CSS 像素即 viewport 坐标，与 Input.dispatchMouseEvent 一致（页面缩放不影响）。
   *  log：全链路诊断打点（按钮坐标/面板轮询/每选项点击），供「查看拦截日志」面板展示 */
  private async cdpFilterPath(
    wc: WebContents,
    sel: typeof FILTER_SELECTORS,
    options: Array<{ label: string; cands: readonly FilterCandidate[] }>,
    log: (msg: string) => void
  ): Promise<boolean> {
    const d = wc.debugger
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    // 悬停筛选按钮（候选依次尝试 + scrollIntoView 防"搜索到底"时按钮在视口外）→ 轮询面板出现（250ms×20 = 5s，面板只认真实 hover）
    const btn = await this.locateElement(wc, sel.button, { scrollFirst: true })
    if (!btn.ok) { log(`筛选按钮未找到（${this.failHitText(sel.button, btn.hitIndex)}）`); return false }
    log(`筛选按钮 ${this.candidateHitText(sel.button, btn.index)}；中心坐标 x=${Math.round(btn.x)} y=${Math.round(btn.y)}（已 scrollIntoView 居中）`)
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y })
    log(`已发送真实鼠标悬停 mouseMoved（${Math.round(btn.x)}, ${Math.round(btn.y)}）`)
    // 面板轮询 = 等到真正可见：候选命中但不可见（常驻 DOM 隐藏）不视为出现，继续等；
    // 首次出现隐藏命中打一条（防每轮刷屏），供真机诊断 CSS :hover 是否触发
    let panelIndex = -1
    let panelHidden = false
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      const p = await this.locateElement(wc, sel.panel)
      if (p.ok) { panelIndex = p.index; log(`筛选面板出现（第 ${i + 1} 次轮询命中，约 ${(i + 1) * 250}ms，${this.candidateHitText(sel.panel, p.index)}）`); break }
      if (p.hitIndex >= 0) {
        if (!panelHidden) log(`筛选面板候选命中但不可见（rect 宽高为 0，疑似常驻 DOM 但隐藏，CSS :hover 未触发），继续等待...`)
        panelHidden = true
      }
    }
    if (panelIndex < 0) {
      log(panelHidden
        ? '筛选面板 5s 内未出现（候选一直命中但不可见，疑似面板常驻 DOM 但隐藏，CSS :hover 未触发）'
        : `筛选面板 5s 内未出现（CSS :hover 未触发或候选均未命中：${this.candidateHitText(sel.panel, -1)}）`)
      return false
    }
    // 选项：单次脚本完成面板重找 + 逐选项查找/el.click——「面板出现」与「点选项」分两次 executeJavaScript 调用时，
    // 间隙（sleep + IPC 往返）里 hover 弹层会关闭导致「面板未找到」，合并为一次脚本执行杜绝间隙丢面板；
    // 面板在脚本执行期间关闭（panelLost）→ 重新悬停按钮重试整批（最多 3 次）
    const ok = await this.clickOptionsWithRetry(wc, sel, options, async (x, y) => {
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    }, log)
    if (!ok) return false
    // 等筛选条件生效、fetch 触发页面刷新（约 2.5s）
    log('全部选项点击完成，等待 2.5s 让筛选条件生效并刷新页面...')
    await sleep(2500)
    return true
  }

  /** 旧方案兜底（debugger attach 失败时）：合成 mouseover/mouseenter/mousemove 弹面板；选项点击
   *  与 CDP 路径一致复用单脚本 buildClickOptionsScript（面板重找 + 逐选项 el.click，减少对合成事件的依赖）。
   *  非 :hover 驱动的场景下仍可用；仍失败返回 false 由调度侧 notice 兜底。
   *  脚本只负责按钮候选 + hover 合成事件 + 面板等待（可见性校验），返回 { ok, buttonFound, panelShown, buttonIndex, panelIndex }。 */
  private async legacyFilterPath(
    wc: WebContents,
    sel: typeof FILTER_SELECTORS,
    options: Array<{ label: string; cands: readonly FilterCandidate[] }>,
    log: (msg: string) => void
  ): Promise<boolean> {
    const script = `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const find = ${resolveSelector.toString()};
      const textOf = el => (el.textContent || '').trim();
      // 可见性校验：display:none/visibility:hidden 的常驻 DOM 元素 rect 宽高为 0，视为未命中（防隐藏面板假命中）
      const rectOf = el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
      // 按钮：候选依次尝试（哈希类过期时文字"筛选"兜底）
      const buttonR = find(${JSON.stringify(sel.button)}, document, textOf, null, rectOf);
      if (!buttonR.el) return { ok: false, buttonFound: false, panelShown: false, buttonIndex: -1, panelIndex: -1 };
      // hover 弹出：事件坐标取元素中心，模拟真实鼠标悬停（部分面板由 mouseover/enter/move 触发）
      const c = buttonR.el.getBoundingClientRect();
      const evt = { bubbles: true, cancelable: true, clientX: c.left + c.width / 2, clientY: c.top + c.height / 2 };
      buttonR.el.dispatchEvent(new MouseEvent('mouseover', evt));
      buttonR.el.dispatchEvent(new MouseEvent('mouseenter', evt));
      buttonR.el.dispatchEvent(new MouseEvent('mousemove', evt));
      // 等筛选面板真正出现（最多 3s），面板同样候选依次尝试 + 可见性校验（隐藏面板不算出现）
      const waitPanel = async () => {
        for (let i = 0; i < 20; i++) {
          const p = find(${JSON.stringify(sel.panel)}, document, textOf, null, rectOf);
          if (p.el) return p;
          await sleep(150);
        }
        return null;
      };
      let panelR = await waitPanel();
      // click 兼容：hover 未弹出则退回 click 再等一次
      if (!panelR) { buttonR.el.click(); panelR = await waitPanel(); }
      if (!panelR) return { ok: false, buttonFound: true, panelShown: false, buttonIndex: buttonR.index, panelIndex: -1 };
      return { ok: true, buttonFound: true, panelShown: true, buttonIndex: buttonR.index, panelIndex: panelR.index };
    })()`
    try {
      const r = (await wc.executeJavaScript(script)) as {
        ok: boolean; buttonFound: boolean; panelShown: boolean
        buttonIndex: number; panelIndex: number
      } | null
      if (!r) { log('合成事件脚本未返回结果 → 失败'); return false }
      const detail = `按钮${this.candidateHitText(sel.button, r.buttonIndex)}，面板${this.candidateHitText(sel.panel, r.panelIndex)}`
      if (!r.ok || !r.panelShown) {
        log(`合成事件路径明细：${detail} → 失败`)
        return false
      }
      log(`合成事件路径明细：${detail} → 面板已出现，执行选项点击脚本`)
      // 选项：复用与 CDP 路径相同的单脚本点击（面板重找 + el.click + panelLost 检测）；
      // 合成事件路径无 CDP 悬停可重试，panelLost 时单次尝试即失败
      const click = await this.runClickOptionsScript(wc, sel, options)
      if (!click) { log('合成事件选项点击脚本未返回结果 → 失败'); return false }
      const clickedText = click.clicked.map(i => options[i].label).join('，') || '无'
      const missingText = click.missing.map(i => options[i].label).join('，') || '无'
      log(`合成事件选项脚本：面板找到=${click.panelFound}，点击=${clickedText}，缺失=${missingText}${click.panelLost ? '，面板在脚本执行期间关闭（panelLost）' : ''} → ${click.ok ? '成功' : '失败'}`)
      return click.ok
    } catch (err) {
      log(`合成事件脚本执行异常 → 失败（${String(err)}）`)
      return false
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
