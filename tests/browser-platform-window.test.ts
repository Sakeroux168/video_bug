import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlatformAdapter } from '../src/main/adapters/types'

// C 阶段：内置浏览器按平台切换登录态分区。
// partition 只能在 BrowserWindow 创建时定死，改不了，所以跨平台必须销毁重建。
// 这里用 BrowserWindow mock 驱动，重点盯三处真机上很难发现的坑：
//   1. 销毁必须真销毁——close 拦截（点×只隐藏）会把关闭变成 hide，留下一个仍占着旧分区的隐藏残窗
//   2. everShown 必须随新窗口复位——否则 setVisible(true) 只调 showInactive()，
//      而它对从未显示过的窗口是空操作，表现为「切平台后浏览器窗口再也打不开」
//   3. 同平台连续任务不能重建窗口，否则每个任务都要重新加载、白白丢掉页面状态

interface WinOptions {
  title?: string
  webPreferences?: { partition?: string; preload?: string }
}

class FakeWebContents {
  handlers = new Map<string, (...args: unknown[]) => void>()
  sent: string[] = []
  on = vi.fn((event: string, fn: (...args: unknown[]) => void) => { this.handlers.set(event, fn) })
  setBackgroundThrottling = vi.fn()
  setWindowOpenHandler = vi.fn()
  executeJavaScript = vi.fn(async () => undefined)
  send = vi.fn((channel: string) => { this.sent.push(channel) })
  openDevTools = vi.fn()
  session = { setPermissionRequestHandler: vi.fn() }
}

class FakeWindow {
  static created: FakeWindow[] = []
  options: WinOptions
  webContents = new FakeWebContents()
  closeHandlers: Array<(e: { preventDefault: () => void }) => void> = []
  destroyed = false
  visible = false
  bounds = { x: 10, y: 20, width: 1024, height: 760 }

  destroy = vi.fn(() => { this.destroyed = true })
  hide = vi.fn(() => { this.visible = false })
  show = vi.fn(() => { this.visible = true })
  showInactive = vi.fn(() => { this.visible = true })
  blur = vi.fn()
  isMinimized = vi.fn(() => false)
  setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y } })
  setBounds = vi.fn((b: typeof FakeWindow.prototype.bounds) => { this.bounds = { ...b } })
  getBounds = vi.fn(() => ({ ...this.bounds }))
  isVisible = vi.fn(() => this.visible)
  isDestroyed = vi.fn(() => this.destroyed)
  loadURL = vi.fn(async () => {})

  constructor(options: WinOptions = {}) {
    this.options = options
    FakeWindow.created.push(this)
  }

  on(event: string, fn: (e: { preventDefault: () => void }) => void): void {
    if (event === 'close') this.closeHandlers.push(fn)
  }

  /** 模拟用户点窗口右上角「×」 */
  userClose(): { defaultPrevented: boolean } {
    let defaultPrevented = false
    for (const fn of this.closeHandlers) fn({ preventDefault: () => { defaultPrevented = true } })
    return { defaultPrevented }
  }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn() }
}))

const { VideoBrowser } = await import('../src/main/browser')

const douyin = {
  name: 'douyin', displayName: '抖音',
  sessionPartition: 'persist:douyin',
  rawUrlHints: ['/aweme/', '/search/']
} as unknown as PlatformAdapter

const kuaishou = {
  name: 'kuaishou', displayName: '快手',
  sessionPartition: 'persist:kuaishou',
  rawUrlHints: ['/graphql']
} as unknown as PlatformAdapter

/** 宿主主窗口桩：setVisible 首次定位会读它 */
const host = {
  getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  isVisible: () => true,
  isMinimized: () => false
} as never

function partitions(): Array<string | undefined> {
  return FakeWindow.created.map(w => w.options.webPreferences?.partition)
}

beforeEach(() => { FakeWindow.created = [] })

describe('VideoBrowser 按平台切换登录态分区', () => {
  it('首个快手任务：窗口标题与分区都是快手的，preload 用平台无关那份', async () => {
    const b = new VideoBrowser(host)
    await b.load(kuaishou, 'https://www.kuaishou.com/search/video?searchKey=x')

    expect(FakeWindow.created).toHaveLength(1)
    const win = FakeWindow.created[0]
    expect(win.options.title).toBe('快手浏览器')
    expect(win.options.webPreferences?.partition).toBe('persist:kuaishou')
    expect(win.options.webPreferences?.preload).toMatch(/platform\.js$/)
    expect(b.adapter).toBe(kuaishou)
    expect(win.loadURL).toHaveBeenCalledWith('https://www.kuaishou.com/search/video?searchKey=x')
  })

  it('同平台连续任务不重建窗口（页面状态与登录态都留着）', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/search/a')
    await b.load(douyin, 'https://www.douyin.com/search/b')
    await b.load(douyin, 'https://www.douyin.com/user/SEC1')

    expect(FakeWindow.created).toHaveLength(1)
    expect(FakeWindow.created[0].destroy).not.toHaveBeenCalled()
    expect(FakeWindow.created[0].loadURL).toHaveBeenCalledTimes(3)
  })

  it('抖音 → 快手 → 抖音：分区按序重建，旧窗口是被销毁而不是隐藏残留', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/')
    await b.load(kuaishou, 'https://www.kuaishou.com/')
    await b.load(douyin, 'https://www.douyin.com/')

    expect(partitions()).toEqual(['persist:douyin', 'persist:kuaishou', 'persist:douyin'])
    // 前两个必须真销毁：留成隐藏窗口的话旧分区仍被占着，且窗口越积越多
    expect(FakeWindow.created[0].destroy).toHaveBeenCalled()
    expect(FakeWindow.created[1].destroy).toHaveBeenCalled()
    expect(FakeWindow.created[0].hide).not.toHaveBeenCalled()
    expect(FakeWindow.created[1].hide).not.toHaveBeenCalled()
    expect(FakeWindow.created[2].destroy).not.toHaveBeenCalled()
    expect(b.adapter).toBe(douyin)
  })

  it('切平台后新窗口仍能显示：everShown 随窗口复位，走 show() 而不是对新窗口无效的 showInactive()', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/')
    b.setVisible(true)
    expect(FakeWindow.created[0].show).toHaveBeenCalled()

    // 先藏起来再切，隔离掉"继承可见状态"那条路径，单测 everShown 复位本身
    b.setVisible(false)
    await b.load(kuaishou, 'https://www.kuaishou.com/')
    const fresh = FakeWindow.created[1]
    expect(fresh.show).not.toHaveBeenCalled() // 原来藏着，不该自己冒出来

    b.setVisible(true)
    // everShown 若没随新窗口复位，这里只会调 showInactive()——对从未显示过的窗口是空操作，窗口永远出不来
    expect(fresh.show).toHaveBeenCalled()
    expect(fresh.showInactive).not.toHaveBeenCalled()
    expect(fresh.visible).toBe(true)
  })

  it('切平台继承可见状态：原来开着就继续开着，原来藏着就别自己冒出来', async () => {
    const shown = new VideoBrowser(host)
    await shown.load(douyin, 'https://www.douyin.com/')
    shown.setVisible(true)
    await shown.load(kuaishou, 'https://www.kuaishou.com/')
    expect(FakeWindow.created[1].visible).toBe(true)

    FakeWindow.created = []
    const hidden = new VideoBrowser(host)
    await hidden.load(douyin, 'https://www.douyin.com/')
    await hidden.load(kuaishou, 'https://www.kuaishou.com/')
    expect(FakeWindow.created[1].visible).toBe(false)
    expect(FakeWindow.created[1].show).not.toHaveBeenCalled()
  })

  it('切平台继承窗口位置：用户拖过的位置不因换平台被重置', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/')
    FakeWindow.created[0].bounds = { x: 500, y: 300, width: 1024, height: 760 }

    await b.load(kuaishou, 'https://www.kuaishou.com/')
    expect(FakeWindow.created[1].setBounds).toHaveBeenCalledWith({ x: 500, y: 300, width: 1024, height: 760 })
  })

  it('用户点「×」仍然只隐藏不销毁（登录态与页面状态保留），这条既有行为不能被销毁重建改坏', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/')
    const win = FakeWindow.created[0]

    const r = win.userClose()
    expect(r.defaultPrevented).toBe(true)
    expect(win.hide).toHaveBeenCalled()
    expect(win.destroy).not.toHaveBeenCalled()
  })

  it('dispose 真销毁，且之后 setVisible / abortScroll 不炸', async () => {
    const b = new VideoBrowser(host)
    await b.load(kuaishou, 'https://www.kuaishou.com/')
    b.dispose()

    expect(FakeWindow.created[0].destroy).toHaveBeenCalled()
    expect(() => b.setVisible(true)).not.toThrow()
    expect(() => b.abortScroll()).not.toThrow()
  })

  // 安全检查 A3：平台网页申请摄像头、麦克风、定位、通知等权限一律拒绝（以前没有处理，默认全部放行）
  it('平台窗口装上权限请求处理：只放行全屏和写剪贴板', async () => {
    const b = new VideoBrowser({} as never)
    await b.load(douyin as never, 'https://www.douyin.com/')
    const handler = FakeWindow.created.at(-1)!.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as
      ((wc: unknown, permission: string, cb: (ok: boolean) => void) => void) | undefined
    expect(handler).toBeTypeOf('function')
    const ask = (p: string): boolean => { let r = true; handler!(null, p, ok => { r = ok }); return r }
    expect(ask('media')).toBe(false)
    expect(ask('geolocation')).toBe(false)
    expect(ask('notifications')).toBe(false)
    expect(ask('fullscreen')).toBe(true)
  })

  it('注入脚本随平台切换：新窗口拿到的是新平台的 URL 兜底特征', async () => {
    const b = new VideoBrowser(host)
    await b.load(douyin, 'https://www.douyin.com/')
    const injected = (): string => (b as unknown as { inject: string }).inject
    expect(injected()).toContain('/aweme/')

    await b.load(kuaishou, 'https://www.kuaishou.com/')
    expect(injected()).toContain('/graphql')
    expect(injected()).not.toContain('/aweme/')
  })
})
