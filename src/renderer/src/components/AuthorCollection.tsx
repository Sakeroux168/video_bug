import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'

export default function AuthorCollection() {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  function flash(m: string): void { setMsg(m); setTimeout(() => setMsg(''), 2500) }
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

  async function deleteSelected(): Promise<void> {
    if (selected.size === 0) return
    await api.deleteAuthors([...selected])
    setSelected(new Set())
    flash(`已删除 ${selected.size} 个作者`)
    refresh()
  }
  async function deleteOne(id: number): Promise<void> {
    await api.deleteAuthors([id])
    flash('已删除该作者')
    refresh()
  }

  async function crawlHome(a: AuthorRow): Promise<void> {
    const r = await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
      aiFilterEnabled: false, aiOrganizeEnabled: false
    })
    if (r.skipped) flash(r.reason ?? '该作者已爬取过')
    else flash(`已开始爬取 ${a.nickname} 的主页`)
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
        {msg && <span className="rounded bg-blue-50 px-2 py-1 text-blue-600">{msg}</span>}
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
      </div>
      {authors.length === 0 ? (
        <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录</span>
      ) : (
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
              <tr key={`${a.platform}:${a.sec_uid}`} className="border-b border-zinc-100">
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
      )}
    </Card>
  )
}
