import { describe, it, expect, vi, afterEach } from 'vitest'
import { VideoBrowser, JS_EVAL_TIMEOUT_MS, withTimeout } from '../src/main/browser'

// R20：页面卡死 / 正在跳转时 executeJavaScript 可能永远不返回。
// 以前调度器等它等到天荒地老：任务一直「进行中」一动不动，后面排队的全都等着。
// 现在页面里的查询脚本最多等 15 秒，等不到一律按「没查到」处理。

/** 假窗口：executeJavaScript 永远不返回（模拟页面卡死） */
function hungBrowser(): { b: VideoBrowser; wc: Record<string, ReturnType<typeof vi.fn>> } {
  const wc = {
    executeJavaScript: vi.fn(() => new Promise(() => {})),
    send: vi.fn(),
    stop: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  }
  const b = new VideoBrowser({} as never)
  ;(b as unknown as { win: unknown }).win = { webContents: wc, isDestroyed: () => false }
  return { b, wc }
}

afterEach(() => { vi.useRealTimers() })

describe('页面查询脚本超时（R20）', () => {
  it('查验证码 / 查到底文案 / 读作者昵称：页面不回话 → 15 秒后返回 null，不会永远挂着', async () => {
    vi.useFakeTimers()
    const { b } = hungBrowser()
    let verify: unknown = 'pending'
    let bottom: unknown = 'pending'
    let nick: unknown = 'pending'
    void b.findVerifyIndicator().then(r => { verify = r })
    void b.findBottomText().then(r => { bottom = r })
    void b.readAuthorNickname().then(r => { nick = r })

    await vi.advanceTimersByTimeAsync(JS_EVAL_TIMEOUT_MS - 1)
    expect([verify, bottom, nick]).toEqual(['pending', 'pending', 'pending'])

    await vi.advanceTimersByTimeAsync(2)
    expect([verify, bottom, nick]).toEqual([null, null, null])
  })

  it('页面正常回话 → 照常返回结果（超时只兜底，不改正常行为）', async () => {
    const b = new VideoBrowser({} as never)
    ;(b as unknown as { win: unknown }).win = {
      webContents: { executeJavaScript: vi.fn(async () => '暂时没有更多了') },
      isDestroyed: () => false
    }
    expect(await b.findBottomText()).toBe('暂时没有更多了')
  })

  it('withTimeout：先完成就不再触发超时，计时器被清掉', async () => {
    vi.useFakeTimers()
    const p = withTimeout(Promise.resolve(7), 1000, '测试')
    await expect(p).resolves.toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resetPage：叫停滚动、停止加载并换成空白页（都是发出去不等，页面卡死也不会把程序卡住）', () => {
    const { b, wc } = hungBrowser()
    b.resetPage()
    expect(wc.send).toHaveBeenCalledWith('platform:scroll-abort')
    expect(wc.stop).toHaveBeenCalled()
    // R20 复查：不能 reload——刷新的还是上一个任务的作者主页，它的接口数据会串进下一个任务
    expect(wc.loadURL).toHaveBeenCalledWith('about:blank')
    expect(wc.reload).not.toHaveBeenCalled()
  })

  it('resetPage：空白页打不开（loadURL 拒绝）也不会变成未处理的异常', async () => {
    const { b, wc } = hungBrowser()
    wc.loadURL.mockImplementation(async () => { throw new Error('ERR_ABORTED') })
    expect(() => b.resetPage()).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
  })

  it('resetPage：没有窗口 / 页面抛错都不影响调用方', () => {
    const empty = new VideoBrowser({} as never)
    expect(() => empty.resetPage()).not.toThrow()
    const { b, wc } = hungBrowser()
    wc.stop.mockImplementation(() => { throw new Error('renderer gone') })
    expect(() => b.resetPage()).not.toThrow()
  })
})
