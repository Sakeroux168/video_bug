import { describe, it, expect, vi } from 'vitest'
import { VideoBrowser, VERIFY_TEXT_PATTERN, withTimeout } from '../src/main/browser'

function makeBrowser(): { b: VideoBrowser } {
  const b = new VideoBrowser({} as never)
  return { b }
}

describe('验证码识别与长操作强制超时（R11-4）', () => {
  it('验证码匹配正则：常见文案命中', () => {
    // R11-5 扩展词：机器人验证/完成拼图/点击完成/安全校验/verify/captcha（抖音实际文案漏词修复）
    for (const t of ['请完成验证', '拖动滑块完成验证', '安全验证', '滑动验证', '请输入验证码', '验证码错误',
      '机器人验证', '请完成拼图验证', '点击完成验证', '安全校验', 'verify you are human', 'captcha-required']) {
      expect(VERIFY_TEXT_PATTERN.test(t)).toBe(true)
    }
  })

  it('验证码匹配正则：普通文案不误命中', () => {
    for (const t of ['暂时没有更多了', '加载更多', '热门搜索', '点赞']) {
      expect(VERIFY_TEXT_PATTERN.test(t)).toBe(false)
    }
  })

  it('withTimeout：操作永不 resolve → 超时 reject OP_TIMEOUT（不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const p = withTimeout(new Promise(() => {}), 31000, '页面加载')
      const codes: string[] = []
      void p.catch(e => codes.push((e as { code?: string }).code ?? ''))
      await vi.advanceTimersByTimeAsync(30000)
      expect(codes).toEqual([]) // 30s 未到不触发
      await vi.advanceTimersByTimeAsync(1000)
      expect(codes).toEqual(['OP_TIMEOUT'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('withTimeout：操作先完成 → 正常透传结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok')
  })

  it('load 永不 resolve → 30s 强制超时走超时路径（任务不永久挂起）', async () => {
    vi.useFakeTimers()
    try {
      const { b } = makeBrowser()
      const never = new Promise<void>(() => {})
      ;(b as unknown as { win: unknown }).win = { loadURL: () => never, isDestroyed: () => false }
      // load 现在会先 ensureWindow：把 current 一并设成同一个桩，走"同平台复用"分支，
      // 不触发 new BrowserWindow（本文件不 mock electron，窗口生命周期在
      // browser-platform-window.test.ts 里用 BrowserWindow mock 专测）
      const stub = { sessionPartition: 'persist:douyin', rawUrlHints: ['/aweme/'] } as never
      ;(b as unknown as { current: unknown }).current = stub
      const p = b.load(stub, 'https://www.douyin.com/search/x').catch(e => e)
      await vi.advanceTimersByTimeAsync(31000)
      const r = await p
      expect(r).toMatchObject({ code: 'OP_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  }, 15000)

  it('scrollToBottom 脚本永不返回 → 60s 超时视为滚动结束返回（不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const { b } = makeBrowser()
      const wc = { executeJavaScript: vi.fn(() => new Promise(() => {})) }
      ;(b as unknown as { win: unknown }).win = { webContents: wc }
      const p = b.scrollToBottom({ waitMs: 8000 })
      let done = false
      void p.then(() => { done = true })
      await vi.advanceTimersByTimeAsync(61000)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 15000)
})

// ---------------------------------------------------------------------------
// B：原始响应通道泛化。窗口要记住自己正在服务哪个平台——主进程收到 platform:raw
// 后靠它决定交给哪个适配器解析，不能只凭 URL 遍历所有适配器（快手与后续平台
// 可能共用 /graphql 这类通用路径，只看 URL 会认错平台）。
// ---------------------------------------------------------------------------
describe('VideoBrowser 记住当前平台', () => {
  it('未 load 过任何页面时没有当前平台', () => {
    expect(new VideoBrowser({} as never).adapter).toBeNull()
  })

  // 切平台时的 adapter 归属、注入脚本切换、窗口销毁重建，改由
  // tests/browser-platform-window.test.ts 用 BrowserWindow mock 走真实路径覆盖
  // （比这里的假 win 桩更强）；此处只保留不需要窗口的初始状态断言。
})

// 真机日志：
//   Error occurred in handler for 'browser:open': ERR_ABORTED (-3) loading 'https://www.kuaishou.com/'
//
// Chromium 在「导航被后续导航取代」或「服务端重定向」时会中止原始导航，
// 让 loadURL 以 errno -3 拒绝——而页面通常已经正常打开了。
// 当成加载失败会把任务白白判死（真机上抖音连着三次记成 network 失败）。
describe('页面加载：ERR_ABORTED 不是失败', () => {
  function browserWith(loadURL: () => Promise<void>): VideoBrowser {
    const b = new VideoBrowser({} as never)
    const stub = { sessionPartition: 'persist:douyin', rawUrlHints: ['/aweme/'] } as never
    ;(b as unknown as { current: unknown }).current = stub
    ;(b as unknown as { win: unknown }).win = { loadURL, isDestroyed: () => false }
    return b
  }

  const stub = { sessionPartition: 'persist:douyin', rawUrlHints: ['/aweme/'] } as never

  it('loadURL 以 ERR_ABORTED 拒绝 → load 正常返回，不抛错', async () => {
    const err = Object.assign(new Error('ERR_ABORTED (-3) loading'), { errno: -3, code: 'ERR_ABORTED' })
    const b = browserWith(() => Promise.reject(err))
    await expect(b.load(stub, 'https://www.kuaishou.com/')).resolves.toBeUndefined()
  })

  it('Electron 只给 errno=-3、没有 code 时也按导航中止处理', async () => {
    const err = Object.assign(new Error("(-3) loading 'https://www.douyin.com/search/x'"), { errno: -3 })
    const b = browserWith(() => Promise.reject(err))
    await expect(b.load(stub, 'https://www.douyin.com/search/x')).resolves.toBeUndefined()
  })

  it('小红书主页超时但 DOM 已有作品卡片时继续执行', async () => {
    vi.useFakeTimers()
    try {
      const b = browserWith(() => new Promise<void>(() => {}))
      const wc = { executeJavaScript: vi.fn(async () => true), stop: vi.fn() }
      ;(b as unknown as { win: unknown }).win = { loadURL: () => new Promise<void>(() => {}), isDestroyed: () => false, webContents: wc }
      const xhs = { name: 'xiaohongshu', sessionPartition: 'persist:douyin', rawUrlHints: ['/api/sns/web/'] } as never
      const pending = b.load(xhs, 'https://www.xiaohongshu.com/user/profile/U1')
      await vi.advanceTimersByTimeAsync(31000)
      await expect(pending).resolves.toBeUndefined()
      expect(wc.executeJavaScript).toHaveBeenCalled()
      expect(wc.stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('其它加载错误照常抛出（真打不开还是要判失败）', async () => {
    const err = Object.assign(new Error('ERR_CONNECTION_REFUSED'), { errno: -102, code: 'ERR_CONNECTION_REFUSED' })
    const b = browserWith(() => Promise.reject(err))
    await expect(b.load(stub, 'https://www.douyin.com/')).rejects.toThrow('ERR_CONNECTION_REFUSED')
  })
})
