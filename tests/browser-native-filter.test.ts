import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { VideoBrowser } from '../src/main/browser'

function browserWithDom(html: string) {
  const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/search_result_ai', runScripts: 'outside-only' })
  Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { left: 10, top: 10, width: 100, height: 30, right: 110, bottom: 40, x: 10, y: 10, toJSON() {} } }
  })
  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  let attached = false
  const debug = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params })
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        const panel = dom.window.document.querySelector<HTMLElement>('.filter-panel')
        if (panel) panel.style.display = 'block'
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        const card = dom.window.document.querySelector<HTMLElement>('[data-note-id]')
        if (card) card.dataset.noteId = 'FILTERED'
      }
    })
  }
  const win = {
    isDestroyed: () => false,
    webContents: { executeJavaScript: async (script: string) => dom.window.eval(script), debugger: debug }
  }
  const browser = new VideoBrowser({} as never)
  ;(browser as unknown as { win: unknown }).win = win
  return { browser, debug, sent }
}

describe('VideoBrowser.applyNativeSearchFilters', () => {
  it('真实 hover 展开面板，并按组标题和选项文字点击，不依赖固定下标', async () => {
    const { browser, debug, sent } = browserWithDom(`
      <div class="filter ai-chat-filter">筛选</div>
      <div class="filter-panel" style="display:none">
        <div class="filters"><span>笔记类型</span><div class="tags">不限</div><div class="tags">视频</div></div>
        <div class="filters"><span>发布时间</span><div class="tags">不限</div><div class="tags">一周内</div></div>
      </div>
      <section data-note-id="INITIAL"></section>`)
    const result = await browser.applyNativeSearchFilters([
      { group: '笔记类型', option: '视频' },
      { group: '发布时间', option: '一周内' }
    ])
    expect(result).toEqual({ applied: true, noteIds: ['FILTERED'] })
    expect(sent.filter(x => x.params.type === 'mousePressed')).toHaveLength(2)
    expect(debug.attach).toHaveBeenCalledWith('1.3')
    expect(debug.detach).toHaveBeenCalled()
  })

  it('页面没有筛选按钮时返回失败，由调度器回退到详情精确筛选', async () => {
    const { browser } = browserWithDom('<section data-note-id="INITIAL"></section>')
    await expect(browser.applyNativeSearchFilters([{ group: '笔记类型', option: '视频' }]))
      .resolves.toEqual({ applied: false, noteIds: ['INITIAL'] })
  })
})
