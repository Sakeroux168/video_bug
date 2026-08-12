import { describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import { render, fireEvent } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { useMarqueeSelect } from '../../src/renderer/src/components/useMarqueeSelect'

// useMarqueeSelect 直接测试（TaskList 集成测试只覆盖「框选纯替换」一种行为）：
// 框选相交判定（正/反向拖动、部分相交）、<5px 误触、交互元素不触发、
// stringIds 模式、无 data-id 行跳过、didDragRef 标记、marquee 矩形坐标（容器相对）。

/** 宿主组件：复刻 TaskList TaskVideoTable 的接线（containerRef + 鼠标三件套 + marquee 遮罩渲染） */
function Host({
  rows, onSelect, stringIds = false, register
}: {
  /** 行的 data-id；null = 不写 data-id（filtered 行语义，不参与框选） */
  rows: Array<number | string | null>
  onSelect: (ids: Array<number | string>) => void
  stringIds?: boolean
  register?: (api: { didDrag: MutableRefObject<boolean> }) => void
}): React.ReactElement {
  const { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag } =
    useMarqueeSelect<number | string>({ onSelect, stringIds })
  useEffect(() => { register?.({ didDrag: didDragRef }) }, [register])
  return (
    <div
      ref={containerRef}
      data-testid="host"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <table>
        <tbody>
          {rows.map((id, i) => (
            <tr key={i} data-id={id ?? undefined} data-testid={`row-${i}`} />
          ))}
        </tbody>
      </table>
      {marquee && (
        <div data-testid="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}
    </div>
  )
}

/** jsdom 无布局引擎：stub 容器与行矩形。容器视口 (100,100)-(700,500)；第 i 行 y = 100+20i .. 120+20i */
function patchGeom(container: HTMLElement, rowCount: number): void {
  const cr = { left: 100, top: 100, right: 700, bottom: 500, width: 600, height: 400, x: 100, y: 100, toJSON: () => ({}) }
  ;(container as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => cr as DOMRect
  container.querySelectorAll('tbody tr').forEach((tr, i) => {
    const r = {
      left: 100, top: 100 + i * 20, right: 700, bottom: 120 + i * 20,
      width: 600, height: 20, x: 100, y: 100 + i * 20, toJSON: () => ({})
    }
    ;(tr as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r as DOMRect
  })
}

function setup(rows: Array<number | string | null>, opts: { stringIds?: boolean } = {}): {
  onSelect: ReturnType<typeof vi.fn>
  container: HTMLElement
  didDrag: () => boolean
} {
  const onSelect = vi.fn()
  const api: { didDrag?: MutableRefObject<boolean> } = {}
  const view = render(
    <Host rows={rows} onSelect={onSelect} stringIds={opts.stringIds} register={a => { api.didDrag = a.didDrag }} />
  )
  const container = view.getByTestId('host')
  patchGeom(container, rows.length)
  return { onSelect, container, didDrag: () => api.didDrag?.current ?? false }
}

/** 完整框选手势：从 (cx1,cy1) 拖到 (cx2,cy2)（视口坐标，自动换算容器相对） */
function dragSelect(container: HTMLElement, cx1: number, cy1: number, cx2: number, cy2: number): void {
  fireEvent.mouseDown(container, { clientX: cx1, clientY: cy1 })
  fireEvent.mouseMove(container, { clientX: cx2, clientY: cy2 })
  fireEvent.mouseUp(container, { clientX: cx2, clientY: cy2 })
}

describe('useMarqueeSelect 框选几何', () => {
  it('正方向拖动（左上→右下）：框内行全部命中、框外行排除，按 data-id 顺序返回', () => {
    const { onSelect, container } = setup([1, 2, 3, 4, 5, 6, 7, 8])
    // 容器内 (10,5)→(200,155) → 视口框 (110,105)-(300,255) → 命中行 0..7（y 100..260 与 105..255 相交）
    dragSelect(container, 110, 105, 300, 255)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('反向拖动（右下→左上）：矩形按起点/终点自动翻转，命中集合一致', () => {
    const { onSelect, container } = setup([1, 2, 3, 4, 5, 6, 7, 8])
    dragSelect(container, 300, 255, 110, 105)
    expect(onSelect.mock.calls[0][0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('部分相交（行只有上边缘搭进框内）→ 该行命中；完全不搭 → 排除', () => {
    const { onSelect, container } = setup([1, 2, 3, 4])
    // 框 (110,115)-(180,135)：行 0 完全在框内；行 1（120..140）部分相交；行 2（140..160）在框下
    dragSelect(container, 110, 115, 180, 135)
    expect(onSelect.mock.calls[0][0]).toEqual([1, 2])
  })

  it('marquee 遮罩矩形 = 容器相对坐标（起点与终点翻转后取最小）', () => {
    const { container } = setup([1, 2, 3])
    // 容器 rect left/top = 100：视口 (300,255) → 容器内 (200,155)；视口 (110,105) → 容器内 (10,5)
    fireEvent.mouseDown(container, { clientX: 300, clientY: 255 })
    fireEvent.mouseMove(container, { clientX: 110, clientY: 105 })
    // endDrag 前读：松手时矩形会被清空（setMarquee(null)）
    const m = document.querySelector('[data-testid="marquee"]') as HTMLElement
    expect(m).toBeTruthy()
    expect(m.style.left).toBe('10px')
    expect(m.style.top).toBe('5px')
    expect(m.style.width).toBe('190px')
    expect(m.style.height).toBe('150px')
  })
})

describe('useMarqueeSelect 边界防护', () => {
  it('拖动不足 5px（误触）→ 不产生选择、不标记 didDrag、遮罩不渲染', () => {
    const { onSelect, container, didDrag } = setup([1, 2, 3])
    dragSelect(container, 110, 105, 112, 107) // 2x2 < 5px
    expect(onSelect).not.toHaveBeenCalled()
    expect(didDrag()).toBe(false)
    expect(document.querySelector('[data-testid="marquee"]')).toBeNull()
  })

  it('有效拖拽后 didDrag=true（供容器 onClick 跳过误判「点空白」）', () => {
    const { container, didDrag } = setup([1, 2, 3])
    dragSelect(container, 110, 105, 300, 155)
    expect(didDrag()).toBe(true)
  })

  it('mousedown 落在 button/a/input 上 → 不开始框选，松手无选择', () => {
    const { onSelect, container } = setup([1, 2, 3])
    // 往容器里塞一个交互元素（与 TaskVideoTable 的操作按钮同语义）
    const btn = document.createElement('button')
    btn.setAttribute('data-testid', 'btn')
    container.appendChild(btn)
    fireEvent.mouseDown(btn, { clientX: 110, clientY: 105 })
    fireEvent.mouseMove(container, { clientX: 300, clientY: 155 })
    fireEvent.mouseUp(container, { clientX: 300, clientY: 155 })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('stringIds 模式：data-id 按字符串原样返回（文件管理品类/作者名）', () => {
    const { onSelect, container } = setup(['美食', '搞笑', '未分类'], { stringIds: true })
    dragSelect(container, 110, 105, 300, 155)
    expect(onSelect.mock.calls[0][0]).toEqual(['美食', '搞笑', '未分类'])
  })

  it('无 data-id 的行（filtered 行）不参与框选，即使几何相交', () => {
    // 行 0 无 data-id（filtered），行 1/2 正常：只返回 [2, 3]
    const { onSelect, container } = setup([null, 2, 3])
    dragSelect(container, 110, 105, 300, 155) // 命中几何上的 0..2
    expect(onSelect.mock.calls[0][0]).toEqual([2, 3])
  })

  it('mouseLeave 容器也结束拖拽（等效 mouseUp，跨行移出场景）', () => {
    const { onSelect, container } = setup([1, 2, 3])
    fireEvent.mouseDown(container, { clientX: 110, clientY: 105 })
    fireEvent.mouseMove(container, { clientX: 300, clientY: 155 })
    fireEvent.mouseLeave(container)
    expect(onSelect.mock.calls[0][0]).toEqual([1, 2, 3])
  })
  // 用户实测：表格里的作者名与主页链接无法选中复制。
  // 根因是框选功能给容器加了 select-none。开一个口子：带 data-allow-select
  // 的元素上不启动框选，让浏览器的原生文本选中接管。
  it('在 data-allow-select 元素上按下 → 不启动框选（让位给文本选中）', () => {
    const onSelect = vi.fn()
    const { getByTestId, queryByTestId } = render(<Host rows={[1, 2]} onSelect={onSelect} />)
    const host = getByTestId('host')
    patchGeom(host, 2)

    const cell = document.createElement('span')
    cell.setAttribute('data-allow-select', '')
    host.appendChild(cell)

    fireEvent.mouseDown(cell, { clientX: 110, clientY: 105 })
    fireEvent.mouseMove(host, { clientX: 600, clientY: 400 })
    fireEvent.mouseUp(host, { clientX: 600, clientY: 400 })

    expect(queryByTestId('marquee')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

})
