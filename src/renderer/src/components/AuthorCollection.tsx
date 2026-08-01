import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'

interface Rect { x: number; y: number; w: number; h: number }

export default function AuthorCollection({ notify }: { notify: (text: string) => void }) {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  function refresh(): void { void api.listAuthors().then(setAuthors) }

  function toggle(id: number): void {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const allSelected = authors.length > 0 && authors.every(a => selected.has(a.id))
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(authors.map(a => a.id)))
  }

  // —— 拖拽框选（marquee 用容器相对坐标，相交判断时转回视口坐标）——
  const toViewport = (r: Rect): Rect => {
    const rect = boxRef.current?.getBoundingClientRect()
    return { x: r.x + (rect?.left ?? 0), y: r.y + (rect?.top ?? 0), w: r.w, h: r.h }
  }
  function onMouseDown(e: React.MouseEvent): void {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input')) return // 交互元素不触发框选
    e.preventDefault()
    const rect = boxRef.current?.getBoundingClientRect()
    dragStart.current = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
    setMarquee({ x: dragStart.current.x, y: dragStart.current.y, w: 0, h: 0 })
  }
  function onMouseMove(e: React.MouseEvent): void {
    if (!dragStart.current) return
    const rect = boxRef.current?.getBoundingClientRect()
    const cx = e.clientX - (rect?.left ?? 0)
    const cy = e.clientY - (rect?.top ?? 0)
    const s = dragStart.current
    setMarquee({
      x: Math.min(s.x, cx), y: Math.min(s.y, cy),
      w: Math.abs(cx - s.x), h: Math.abs(cy - s.y)
    })
  }
  function endDrag(): void {
    if (!dragStart.current || !marquee || (marquee.w < 5 && marquee.h < 5)) { dragStart.current = null; setMarquee(null); return }
    const v = toViewport(marquee)
    const mr = { left: v.x, top: v.y, right: v.x + v.w, bottom: v.y + v.h }
    const rows = boxRef.current?.querySelectorAll('tbody tr') ?? []
    const newly = new Set<number>()
    rows.forEach(tr => {
      const r = tr.getBoundingClientRect()
      if (r.left < mr.right && r.right > mr.left && r.top < mr.bottom && r.bottom > mr.top) {
        newly.add(Number(tr.getAttribute('data-id')))
      }
    })
    if (newly.size) setSelected(prev => new Set([...prev, ...newly]))
    dragStart.current = null
    setMarquee(null)
  }

  async function deleteSelected(): Promise<void> {
    if (selected.size === 0) return
    await api.deleteAuthors([...selected])
    setSelected(new Set())
    notify(`已删除 ${selected.size} 个作者`)
    refresh()
  }
  async function deleteOne(id: number): Promise<void> {
    await api.deleteAuthors([id])
    notify('已删除该作者')
    refresh()
  }

  async function crawlHome(a: AuthorRow): Promise<void> {
    // Fix5: 点击立即反馈，让用户知道主页爬取已开始（此前静默启动，用户不知道）
    notify(`正在爬取 ${a.nickname} 的主页…`)
    const r = await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
      aiFilterEnabled: false, aiOrganizeEnabled: false
    })
    if (r.skipped) notify(r.reason ?? '该作者主页已爬取过')
    else notify(`已开始爬取 ${a.nickname} 的主页，可在任务列表查看进度`)
  }

  async function saveCategory(a: AuthorRow): Promise<void> {
    const v = editVal.trim()
    if (v !== (a.category ?? '')) {
      await api.updateAuthorCategory(a.id, v)
      setAuthors(prev => prev.map(x => (x.id === a.id ? { ...x, category: v || null } : x)))
    }
    setEditingId(null)
  }

  return (
    <Card title="作者收藏">
      <div className="mb-2 flex items-center gap-3 text-xs">
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
        <span className="text-zinc-300">提示：在表格上按住左键拖动可框选多个作者</span>
      </div>
      {authors.length === 0 ? (
        <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录</span>
      ) : (
        <div
          ref={boxRef} className="relative select-none overflow-auto"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endDrag} onMouseLeave={endDrag}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-400">
                <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th className="py-2 pr-2 font-medium">作者</th>
                <th className="py-2 pr-2 font-medium">主页链接</th>
                <th className="py-2 pr-2 font-medium">品类</th>
                <th className="py-2 pr-2 font-medium">视频数</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {authors.map(a => (
                <tr key={`${a.platform}:${a.sec_uid}`} data-id={a.id} className={`border-b border-zinc-100 ${selected.has(a.id) ? 'bg-blue-50' : ''}`}>
                  <td className="py-2 pr-1"><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} /></td>
                  <td className="py-2 pr-2 font-medium">{a.nickname}</td>
                  <td className="max-w-[240px] truncate py-2 pr-2">
                    <a className="text-blue-500 hover:underline" href={a.home_url ?? '#'} target="_blank" rel="noreferrer">
                      {a.home_url ?? '—'}
                    </a>
                  </td>
                  <td className="py-2 pr-2">
                    {editingId === a.id ? (
                      <input
                        autoFocus className="w-32 rounded border border-blue-400 px-2 py-1 text-xs outline-none"
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={() => void saveCategory(a)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveCategory(a); if (e.key === 'Escape') setEditingId(null) }}
                      />
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                        title="点击编辑品类"
                        onClick={() => { setEditingId(a.id); setEditVal(a.category ?? '') }}
                      >
                        {a.category ?? <span className="text-zinc-300">未设置</span>}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-zinc-500">{a.video_count}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      <button className={`${btnPrimary} !px-2 !py-1 !text-xs`} onClick={() => void crawlHome(a)}>爬主页</button>
                      <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50" onClick={() => void deleteOne(a.id)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {marquee && (
            <div
              className="pointer-events-none absolute border border-blue-400 bg-blue-200/40"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}
        </div>
      )}
    </Card>
  )
}
