// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { VideoBrowser } from '../src/main/browser'

/** 假 win：executeJavaScript 用 jsdom 的 window/document 真正求值页面脚本（与真实页面环境一致） */
function makeBrowserWithDom(): VideoBrowser {
  const executeJavaScript = async (script: string): Promise<unknown> =>
    new Function('window', 'document', 'return (' + script + ')')(window, document)
  const b = new VideoBrowser({} as never)
  ;(b as unknown as { win: unknown }).win = { webContents: { executeJavaScript } }
  return b
}

/** jsdom 无布局引擎（getBoundingClientRect 恒全 0）：按真实浏览器语义打补丁——
 *  display:none → 0 宽高；#below → 文档底部视口外；其余 → 视口内可见 */
function patchLayout() {
  ;(HTMLElement.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = function (
    this: HTMLElement
  ) {
    const st = this.style
    if (st && st.display === 'none') return { width: 0, height: 0, top: 0, bottom: 0 }
    if (this.id === 'below') return { width: 100, height: 30, top: 2000, bottom: 2030 }
    return { width: 100, height: 30, top: 100, bottom: 130 }
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  ;(window as { innerHeight: number }).innerHeight = 800
  patchLayout()
})

describe('findBottomText 到底文案检测：可见性 + 视口校验（防未到底提前触发筛选）', () => {
  it('隐藏的「暂时没有更多了」（display:none 常驻 DOM）→ null', async () => {
    document.body.innerHTML = '<div style="display:none">暂时没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBeNull()
  })

  it('提示在文档底部但视口未滚到（rect 在视口外）→ null', async () => {
    document.body.innerHTML = '<div id="below">暂时没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBeNull()
  })

  it('滚到底且提示可见（视口内）→ 命中「暂时没有更多了」', async () => {
    document.body.innerHTML = '<div id="inview">暂时没有更多了</div>'
    const t = await makeBrowserWithDom().findBottomText()
    expect(t).toBe('暂时没有更多了')
  })

  it('其他到底文案变体（没有更多了）可见时同样命中', async () => {
    document.body.innerHTML = '<div id="inview">没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBe('没有更多了')
  })

  it('快速路径：div.nU717OFZ 可见且在视口内直接命中', async () => {
    document.body.innerHTML = '<div class="nU717OFZ" id="inview">暂时没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBe('暂时没有更多了')
  })

  it('快速路径：nU717OFZ 隐藏时跳过，文字扫描也无可见命中 → null', async () => {
    document.body.innerHTML = '<div class="nU717OFZ" style="display:none">暂时没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBeNull()
  })

  it('快速路径：nU717OFZ 在视口外时跳过（未滚到底）→ null', async () => {
    document.body.innerHTML = '<div class="nU717OFZ" id="below">暂时没有更多了</div>'
    expect(await makeBrowserWithDom().findBottomText()).toBeNull()
  })
})
