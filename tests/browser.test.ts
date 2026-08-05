import { describe, it, expect, vi } from 'vitest'
import { VideoBrowser } from '../src/main/browser'
import { FILTER_SELECTORS } from '../src/main/adapters/douyin'
import type { DouyinFilter } from '../src/shared/types'

const f: DouyinFilter = { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }

/** 假 webContents：debugger 桩 + executeJavaScript 恒返回候选命中的坐标对象（模拟 DOM 命中，
 *  返回形状与 locateElement 页面脚本一致：found/index/x/y），CDP 全流程可跑完（面板轮询立即命中），
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
    executeJavaScript: vi.fn(async () => ({ found: true, x: 100, y: 100, index: 0 }))
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
