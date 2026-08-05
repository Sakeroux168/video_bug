import { useCallback, useState } from 'react'

export interface RowClickMods {
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * 表格行选择终版语义（需求 2026-08-02d ③，视频表格与作者表格共用）：
 * - 普通点击（无修饰键）：排他——未选中 → 只选该行；已选中 → 清空全部；并更新锚点
 * - ctrl+点击：切换该行选中（不清其它）；不改锚点
 * - shift+点击：范围选中——从锚点到当前行全部选中；锚点为 null 或不在当前可见行
 *   （visibleIds，跨页/被搜索过滤即视为不在当前视图）→ 退化为普通排他点击；并更新锚点
 * 锚点 = 最近一次普通点击或 shift 点击的行（ctrl 点击与框选不改锚点）。
 * 框选（拖动）= 纯替换，由调用方直接替换选中集，不经过本 hook。
 *
 * rowClick 是纯函数式：传入当前选中集 prev 与可见行 id 列表，返回下一个选中集，
 * 调用方用自己的 setState 落地，选中集本体始终由调用方（跨页语义）持有。
 */
export function useTableSelection<T>(): {
  anchor: T | null
  rowClick: (id: T, visibleIds: readonly T[], prev: ReadonlySet<T>, mods: RowClickMods) => Set<T>
} {
  const [anchor, setAnchor] = useState<T | null>(null)

  const rowClick = useCallback(
    (id: T, visibleIds: readonly T[], prev: ReadonlySet<T>, mods: RowClickMods): Set<T> => {
      // ctrl：切换该行，不清其它，不改锚点
      if (mods.ctrlKey) {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      // shift：锚点 → 当前行范围选中（替换其它）；无有效锚点 → 退化为普通排他点击
      if (mods.shiftKey && anchor !== null) {
        const ai = visibleIds.indexOf(anchor)
        const ci = visibleIds.indexOf(id)
        if (ai !== -1 && ci !== -1) {
          const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai]
          setAnchor(id)
          return new Set(visibleIds.slice(lo, hi + 1))
        }
      }
      // 普通点击：排他（已选 → 清空全部；未选 → 只选它），并更新锚点
      setAnchor(id)
      return prev.has(id) ? new Set() : new Set([id])
    },
    [anchor]
  )

  return { anchor, rowClick }
}
