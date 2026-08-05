import { describe, it, expect, vi } from 'vitest'
import { VideoBrowser } from '../src/main/browser'
import { FILTER_SELECTORS } from '../src/main/adapters/douyin'
import type { DouyinFilter } from '../src/shared/types'

const f: DouyinFilter = { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }

/** 假 webContents：debugger 桩 + executeJavaScript 按脚本分流返回——
 *  选项点击脚本（buildClickOptionsScript，含 panelLost 字样）返回成功明细，定位脚本返回候选命中的坐标对象
 *  （形状与 locateElement 页面脚本一致：found/index/x/y），CDP 全流程可跑完（面板轮询立即命中），
 *  用于验证 applyDouyinFilter 的互斥锁 */
function fakeWebContents(): {
  debugger: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> }
  executeJavaScript: ReturnType<typeof vi.fn>
} {
  return {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => {})
    },
    executeJavaScript: vi.fn(async (script: string) =>
      script.includes('panelLost')
        ? { ok: true, panelFound: true, panelLost: false, clicked: [0], missing: [] }
        : { found: true, x: 100, y: 100, index: 0, hitDesc: 'button.mock', covered: false, inViewport: true }
    )
  }
}

function makeBrowser(): { b: VideoBrowser; logs: string[] } {
  const b = new VideoBrowser({} as never, () => {})
  return { b, logs: [] }
}

describe('VideoBrowser.applyDouyinFilter 互斥锁（并发防护）', () => {
  it('并发调用时第二个抛 FILTER_BUSY（与真实失败区分）并打点；首次结束后解锁', async () => {
    const { b, logs } = makeBrowser()
    const wc = fakeWebContents()
    ;(b as unknown as { win: unknown }).win = { webContents: wc }
    const p1 = b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    // 第一次尚在 CDP 流程中（互斥锁已持有）→ 第二次应抛带标记的 FILTER_BUSY 错误
    await expect(b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m)))
      .rejects.toMatchObject({ code: 'FILTER_BUSY' })
    expect(logs.join('\n')).toContain('筛选流程进行中（上一次未结束），本次跳过')
    await p1
    expect((b as unknown as { filterInFlight: boolean }).filterInFlight).toBe(false)
  }, 15000)

  it('无并发时正常执行完整个 CDP 流程并通过 finally 复位锁', async () => {
    const { b, logs } = makeBrowser()
    const wc = fakeWebContents()
    ;(b as unknown as { win: unknown }).win = { webContents: wc }
    const r = await b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    expect(r).toBe(true)
    expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('CDP 路径执行完成 → 成功')
    expect((b as unknown as { filterInFlight: boolean }).filterInFlight).toBe(false)
  }, 15000)

  it('窗口不存在提前返回时同样复位锁（finally 覆盖所有出口）', async () => {
    const { b, logs } = makeBrowser()
    const r = await b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    expect(r).toBe(false)
    expect(logs.join('\n')).toContain('浏览器窗口不存在')
    expect((b as unknown as { filterInFlight: boolean }).filterInFlight).toBe(false)
  })
})

describe('VideoBrowser 选项点击：面板丢失（panelLost）→ 重新悬停重试整批', () => {
  /** 分流 mock：点击脚本（含 panelLost 字样）按序列返回，其余定位脚本恒返回候选命中坐标 */
  function panelLostWebContents(clickResults: Array<Record<string, unknown>>) {
    let runs = 0
    return {
      debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => {}) },
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes('panelLost')) {
          return clickResults[Math.min(runs++, clickResults.length - 1)]
        }
        return { found: true, x: 100, y: 100, index: 0, hitDesc: 'button.mock', covered: false, inViewport: true }
      })
    }
  }

  it('选项脚本 panelLost → 重新悬停按钮 + 面板轮询后重试整批，最终成功', async () => {
    const { b, logs } = makeBrowser()
    const wc = panelLostWebContents([
      { ok: false, panelFound: true, panelLost: true, clicked: [], missing: [0] },
      { ok: true, panelFound: true, panelLost: false, clicked: [0], missing: [] }
    ])
    ;(b as unknown as { win: unknown }).win = { webContents: wc }
    const r = await b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    expect(r).toBe(true)
    const all = logs.join('\n')
    expect(all).toContain('panelLost')
    expect(all).toContain('重新悬停按钮')
    expect(all).toContain('CDP 路径执行完成 → 成功')
    // 悬停 2 次（首次 + panelLost 重试各一次 mouseMoved；选项已改脚本内 el.click，无真实点击）
    expect(wc.debugger.sendCommand).toHaveBeenCalledTimes(2)
  }, 15000)

  it('panelLost 且 3 次整批重试仍失败 → 返回 false', async () => {
    const { b, logs } = makeBrowser()
    const wc = panelLostWebContents([
      { ok: false, panelFound: true, panelLost: true, clicked: [], missing: [0] }
    ])
    ;(b as unknown as { win: unknown }).win = { webContents: wc }
    const r = await b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    expect(r).toBe(false)
    const all = logs.join('\n')
    expect(all).toContain('CDP 路径执行完成 → 失败')
    // 悬停 3 次（首次 + 2 次重试后放弃）
    expect(wc.debugger.sendCommand).toHaveBeenCalledTimes(3)
  }, 15000)

  it('非 panelLost 失败（面板在但选项缺失）→ 不重试，直接失败', async () => {
    const { b, logs } = makeBrowser()
    const wc = panelLostWebContents([
      { ok: false, panelFound: true, panelLost: false, clicked: [], missing: [0] }
    ])
    ;(b as unknown as { win: unknown }).win = { webContents: wc }
    const r = await b.applyDouyinFilter(FILTER_SELECTORS, f, m => logs.push(m))
    expect(r).toBe(false)
    const all = logs.join('\n')
    expect(all).toContain('CDP 路径执行完成 → 失败')
    expect(all).not.toContain('重新悬停')
    // 只悬停 1 次（按钮 hover），未重试
    expect(wc.debugger.sendCommand).toHaveBeenCalledTimes(1)
  }, 15000)
})
