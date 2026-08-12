import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Btn, SelectContainer } from '../../src/renderer/src/components/ui'

// P2（round16）：设计基元的契约测试。
//
// 这些不是样式测试——被锁住的是**结构**，因为结构一旦变了，功能会静默退化：
//   · Btn 必须渲染原生 <button> 且 children 原样透传：useMarqueeSelect 的
//     closest('button, a, input') 守卫靠它区分「点按钮」与「点行/框选」；
//     tasklist-batch-matrix 还有一条按 textContent 断言的文案契约。
//   · SelectContainer 必须只渲染一层 div，直接子元素是唯一的 <table>：
//     框选遮罩用容器相对坐标，中间插一层 wrapper 框选就整体偏移，
//     而 jsdom 没有布局引擎，这种错位任何渲染测试都发现不了。

describe('Btn 基元', () => {
  it('渲染原生 <button>，children 原样透传', () => {
    const { container } = render(<Btn>下载</Btn>)
    const el = container.firstElementChild as HTMLElement
    expect(el.tagName).toBe('BUTTON')
    expect(el.textContent).toBe('下载')
  })

  it('透传 data-action / disabled / onClick', () => {
    const onClick = vi.fn()
    const { container } = render(<Btn action="download" disabled onClick={onClick}>下载</Btn>)
    const el = container.firstElementChild as HTMLButtonElement
    expect(el.getAttribute('data-action')).toBe('download')
    expect(el.disabled).toBe(true)
  })

  it('variant / size 只影响 class，不改变标签与文案', () => {
    for (const v of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const { container } = render(<Btn variant={v} size="sm">删除</Btn>)
      const el = container.firstElementChild as HTMLElement
      expect(el.tagName).toBe('BUTTON')
      expect(el.textContent).toBe('删除')
    }
  })
})

describe('SelectContainer 基元', () => {
  const noop = (): void => {}
  const handlers = { onMouseDown: noop, onMouseMove: noop, endDrag: noop, onClick: noop }

  it('直接子元素恰好是唯一的 <table>——中间不得插 wrapper', () => {
    const { container } = render(
      <SelectContainer testId="t" containerRef={{ current: null }} marquee={null} {...handlers}>
        <table><tbody><tr><td>x</td></tr></tbody></table>
      </SelectContainer>
    )
    const c = container.firstElementChild as HTMLElement
    expect(c.getAttribute('data-testid')).toBe('t')
    expect(c.firstElementChild!.tagName).toBe('TABLE')
    expect(c.querySelectorAll(':scope > table').length).toBe(1)
  })

  it('有 marquee 时只多渲染一个 div，且它是容器的最后一个子节点（不是 table 的祖先）', () => {
    const rect = { left: 1, top: 2, width: 3, height: 4 }
    const { container } = render(
      <SelectContainer testId="t" containerRef={{ current: null }} marquee={rect} {...handlers}>
        <table><tbody><tr><td>x</td></tr></tbody></table>
      </SelectContainer>
    )
    const c = container.firstElementChild as HTMLElement
    expect(c.children.length).toBe(2)
    expect(c.firstElementChild!.tagName).toBe('TABLE')
    expect(c.lastElementChild!.tagName).toBe('DIV')
  })
})
