import React, { useCallback, useRef, useState } from 'react'

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * 拖动框选 hook（替换式语义：松手后选中集合 = 框内命中的行，框外一律取消）。
 *
 * 用法：
 * - 把返回的 containerRef 和 onMouseDown/onMouseMove/endDrag 绑到包着表格的容器 div 上，
 *   容器需带 `relative select-none overflow-auto`（框选遮罩按容器相对坐标定位）。
 * - 表格行需写 `data-id`（不参与框选的行不写 data-id），松手时 onSelect 收到框内命中行的 id 列表。
 * - mousedown 目标是 button/a/input（或其后代）时不触发框选，保证复选框/按钮/链接交互正常。
 * - didDragRef：本次鼠标手势是否为有效拖拽（≥5px）。跨行拖拽松手后浏览器会在公共祖先
 *   （tbody）派发 click，冒泡到容器被误判为"点空白"；拖拽手势的 click 应跳过该处理，
 *   因此 mousedown 时重置、有效拖拽后置 true，组件在 onClick 处理里读它。
 */
export function useMarqueeSelect<T extends number | string = number>(options: {
  onSelect: (ids: T[]) => void
  /** 行 data-id 存字符串（文件管理里的品类/作者名）时为 true；默认按数字解析 */
  stringIds?: boolean
}): {
  containerRef: React.RefObject<HTMLDivElement>
  marquee: Rect | null
  didDragRef: React.MutableRefObject<boolean>
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  endDrag: () => void
} {
  const { onSelect } = options
  const stringIds = options.stringIds ?? false
  const containerRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const didDragRef = useRef(false)

  // marquee 用容器相对坐标，相交判断时转回视口坐标
  const toViewport = useCallback((r: Rect): Rect => {
    const rect = containerRef.current?.getBoundingClientRect()
    return { x: r.x + (rect?.left ?? 0), y: r.y + (rect?.top ?? 0), w: r.w, h: r.h }
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input')) return // 交互元素不触发框选
    e.preventDefault()
    didDragRef.current = false
    const rect = containerRef.current?.getBoundingClientRect()
    dragStart.current = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
    setMarquee({ x: dragStart.current.x, y: dragStart.current.y, w: 0, h: 0 })
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent): void => {
    if (!dragStart.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    const cx = e.clientX - (rect?.left ?? 0)
    const cy = e.clientY - (rect?.top ?? 0)
    const s = dragStart.current
    setMarquee({
      x: Math.min(s.x, cx), y: Math.min(s.y, cy),
      w: Math.abs(cx - s.x), h: Math.abs(cy - s.y)
    })
  }, [])

  const endDrag = useCallback((): void => {
    // 未开始拖动或矩形过小（<5px 的误触）→ 不产生选择，也不视为拖拽手势
    if (!dragStart.current || !marquee || (marquee.w < 5 && marquee.h < 5)) {
      dragStart.current = null
      setMarquee(null)
      return
    }
    // 有效拖拽：松手后浏览器派发的 click 应被组件忽略（否则误判为"点空白/点行"）
    didDragRef.current = true
    const v = toViewport(marquee)
    const mr = { left: v.x, top: v.y, right: v.x + v.w, bottom: v.y + v.h }
    const rows = containerRef.current?.querySelectorAll('tbody tr') ?? []
    const ids: T[] = []
    rows.forEach(tr => {
      const r = tr.getBoundingClientRect()
      if (r.left < mr.right && r.right > mr.left && r.top < mr.bottom && r.bottom > mr.top) {
        const raw = tr.getAttribute('data-id')
        if (raw !== null && raw !== '') ids.push((stringIds ? raw : Number(raw)) as T)
      }
    })
    onSelect(ids)
    dragStart.current = null
    setMarquee(null)
  }, [marquee, onSelect, toViewport])

  return { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag }
}
