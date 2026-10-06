// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildLoginScript, buildVerifyScript } from '../src/main/browser'
import { buildLoginStatusScript } from '../src/main/pageSignals'

// scheduler 顶层会读设置（settings.ts 用 electron app.getPath）；指向不存在的目录 → 用默认设置
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() + '/.tmp-page-signals-perf' } }))

// 2026-10-06 全面检查「性能」F6：检测脚本以前先对每段文字判断「看不看得见」（每段都往上逐层 getComputedStyle），
// 再匹配文字；3000 张卡片时一次要 0.3 秒，每 2 秒跑一次。现在先匹配文字，命中了才判断看不看得见。

const run = (script: string): unknown => new Function(`return ${script}`)()
const cards = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<div class="card"><a><span>猫咪视频 ${i}</span><span>作者${i}</span><span>${i} 赞</span></a></div>`).join('')

describe('F6 检测脚本先看文字、命中才算可见性', () => {
  beforeEach(() => {
    document.title = '猫咪 - 抖音搜索'
    ;(Element.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = () =>
      ({ width: 100, height: 100, top: 0, bottom: 100, right: 100 }) as DOMRect
  })

  it('满屏普通卡片、没有验证码 → 一次 getComputedStyle 都不调', () => {
    document.body.innerHTML = cards(300)
    const spy = vi.spyOn(window, 'getComputedStyle')
    expect(run(buildVerifyScript())).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('未登录检测、登录灯脚本同理：没有「登录」字样就不算可见性', () => {
    document.body.innerHTML = cards(300)
    const spy = vi.spyOn(window, 'getComputedStyle')
    expect(run(buildLoginScript('douyin'))).toBeNull()
    expect(run(buildLoginStatusScript('douyin'))).toBe('unknown')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('结果不变：看得见的验证文字照样认出来，藏起来的不算', () => {
    document.body.innerHTML = cards(50) + '<div style="display:none">请完成安全验证</div>'
    expect(run(buildVerifyScript())).toBeNull()
    document.body.innerHTML = cards(50) + '<div>请完成安全验证</div>'
    expect(run(buildVerifyScript())).toBe('请完成安全验证')
  })
})

describe('F6 心跳检测不叠加', () => {
  it('skipIfBusy：上一次还没返回就跳过这次，返回后才能再跑', async () => {
    const { skipIfBusy } = await import('../src/main/scheduler')
    let release!: () => void
    const fn = vi.fn(() => new Promise<void>(r => { release = r }))
    const guarded = skipIfBusy(fn)
    expect(guarded()).toBe(true)
    expect(guarded()).toBe(false)
    expect(guarded()).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    release()
    await new Promise(r => setTimeout(r, 0))
    expect(guarded()).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
