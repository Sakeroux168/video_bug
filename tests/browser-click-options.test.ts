// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildClickOptionsScript } from '../src/main/browser'
import { FILTER_SELECTORS } from '../src/main/adapters/douyin'

/** 待点选项夹具：与 browser.applyDouyinFilterLocked 构造的 options 同构 */
function optionsFixture() {
  return [
    { label: '组2(视频时长)选项2(1-5分钟)', cands: FILTER_SELECTORS.option(2, 2) },
    { label: '组3(搜索范围)选项1(关注的人)', cands: FILTER_SELECTORS.option(3, 1) }
  ]
}

/** jsdom 无布局引擎（getBoundingClientRect 恒全 0）：按真实浏览器语义打补丁，
 *  display:none → 0 宽高（隐藏面板），其余非零（可见） */
function patchRect() {
  ;(HTMLElement.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = function (
    this: HTMLElement
  ) {
    const st = this.style
    if (st && st.display === 'none') return { width: 0, height: 0, left: 0, top: 0 }
    return { width: 100, height: 40, left: 10, top: 20 }
  }
}

/** 与主进程 executeJavaScript 等价地执行脚本（脚本是 async IIFE → 返回 Promise） */
function runScript(script: string): Promise<{
  ok: boolean; panelFound: boolean; panelLost: boolean; clicked: number[]; missing: number[]
}> {
  return new Function('document', 'return (' + script + ')')(document) as Promise<{
    ok: boolean; panelFound: boolean; panelLost: boolean; clicked: number[]; missing: number[]
  }>
}

beforeEach(() => {
  document.body.innerHTML = ''
  patchRect()
})

describe('buildClickOptionsScript 单脚本选项点击（面板/选项重试 + el.click + panelLost）', () => {
  it('面板存在时逐选项命中并 el.click（含文字兜底，无真实鼠标依赖）', async () => {
    document.body.innerHTML = `
      <div id="panel">
        <span>排序依据</span>
        <span>视频时长</span>
        <span>1-5分钟</span>
        <span>关注的人</span>
      </div>`
    const clicked: string[] = []
    const spy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicked.push((this.textContent ?? '').trim())
    })
    try {
      const r = await runScript(buildClickOptionsScript(FILTER_SELECTORS, optionsFixture()))
      expect(r.ok).toBe(true)
      expect(r.panelFound).toBe(true)
      expect(r.panelLost).toBe(false)
      expect(r.clicked).toEqual([0, 1])
      expect(r.missing).toEqual([])
      expect(clicked).toEqual(['1-5分钟', '关注的人'])
    } finally {
      spy.mockRestore()
    }
  })

  it('选项未命中时记入 missing、ok=false；面板仍在 → panelLost=false（不触发重试）', async () => {
    document.body.innerHTML = '<div id="panel"><span>排序依据</span><span>视频时长</span></div>'
    const r = await runScript(buildClickOptionsScript(FILTER_SELECTORS, optionsFixture(), { panel: 2, option: 2 }))
    expect(r.ok).toBe(false)
    expect(r.panelFound).toBe(true)
    expect(r.panelLost).toBe(false)
    expect(r.missing).toEqual([0, 1])
    expect(r.clicked).toEqual([])
  })

  it('选项点击后面板消失（hover 弹层在脚本执行期间关闭）→ panelLost=true', async () => {
    document.body.innerHTML = `
      <div id="panel">
        <span>排序依据</span>
        <span>视频时长</span>
        <span>1-5分钟</span>
      </div>`
    const panel = document.getElementById('panel') as HTMLElement
    // 模拟：首次点击后面板自动收起（真实场景的 hover 弹层关闭）
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      panel.style.display = 'none'
    })
    const r = await runScript(buildClickOptionsScript(FILTER_SELECTORS, optionsFixture(), { panel: 2, option: 2 }))
    expect(r.panelLost).toBe(true)
    expect(r.ok).toBe(false) // 面板关闭后选项2无法再点
  })

  it('面板自始不可见（未悬停/未出现）→ panelFound=false 且 panelLost=false', async () => {
    // 含关键词的容器自始 display:none（面板未弹出）→ 可见性校验拒绝，面板重试后仍找不到
    document.body.innerHTML = '<div style="display:none"><span>排序依据</span><span>视频时长</span></div>'
    const r = await runScript(buildClickOptionsScript(FILTER_SELECTORS, optionsFixture(), { panel: 2, option: 2 }))
    expect(r.ok).toBe(false)
    expect(r.panelFound).toBe(false)
    expect(r.panelLost).toBe(false)
    expect(r.missing).toEqual([0, 1])
  })
})
