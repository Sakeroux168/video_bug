import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { VideoBrowser } from '../src/main/browser'

// 2026-10-07 N01：抖音搜索页的「筛选」不是小红书那套 class（真机：悬停「筛选」后出现「排序依据 / 发布时间 / 视频时长 / 搜索范围」）。
// 按文字找：先找写着「筛选」的按钮悬停，再找组标题旁边写着选项文字的那一个点下去

function douyinDom() {
  const dom = new JSDOM(`
    <div class="jjU9T0dQ"><span class="QfeM8ow3">筛选</span></div>
    <div class="pnl" style="display:none">
      <div class="grp"><span>排序依据</span><div><span class="opt">综合排序</span><span class="opt">最新发布</span><span class="opt">最多点赞</span></div></div>
      <div class="grp"><span>发布时间</span><div><span class="opt">不限</span><span class="opt">一天内</span></div></div>
    </div>`, { url: 'https://www.douyin.com/search/x?type=video', runScripts: 'outside-only' })
  let clicked = ''
  Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      // 藏起来的（自己或祖先 display:none）宽高为 0，和真浏览器一样
      for (let p: Element | null = this; p; p = p.parentElement) {
        if ((p as HTMLElement).style?.display === 'none') return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }
      }
      const i = [...dom.window.document.querySelectorAll('*')].indexOf(this)
      return { left: i * 10, top: i * 10, width: 40, height: 20, right: i * 10 + 40, bottom: i * 10 + 20, x: i * 10, y: i * 10, toJSON() {} }
    }
  })
  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  let attached = false
  const debug = {
    isAttached: () => attached,
    attach: () => { attached = true },
    detach: () => { attached = false },
    sendCommand: async (_method: string, params: Record<string, number | string>) => {
      if (params.type === 'mouseMoved') (dom.window.document.querySelector('.pnl') as HTMLElement).style.display = 'block'
      if (params.type === 'mouseReleased') {
        const hit = [...dom.window.document.querySelectorAll('.opt')].find(el => {
          const r = el.getBoundingClientRect()
          return params.x === r.left + r.width / 2 && params.y === r.top + r.height / 2
        })
        clicked = hit?.textContent ?? ''
      }
    }
  }
  const browser = new VideoBrowser({} as never)
  ;(browser as unknown as { win: unknown }).win = {
    isDestroyed: () => false,
    webContents: { executeJavaScript: async (s: string) => dom.window.eval(s), debugger: debug }
  }
  return { browser, clicked: () => clicked }
}

describe('VideoBrowser.applyNativeSearchFilters（抖音式面板，按文字找）', () => {
  it('悬停「筛选」→ 点「排序依据」里的「最多点赞」', async () => {
    const { browser, clicked } = douyinDom()
    const r = await browser.applyNativeSearchFilters([{ group: '排序依据', option: '最多点赞' }])
    expect(r.applied).toBe(true)
    expect(clicked()).toBe('最多点赞')
  })

  it('找不到这个选项 → 返回没点上', async () => {
    const { browser } = douyinDom()
    const r = await browser.applyNativeSearchFilters([{ group: '排序依据', option: '最多收藏' }])
    expect(r.applied).toBe(false)
  })
})
