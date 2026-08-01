import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'

export default function AuthorCollection() {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  function flash(m: string): void { setMsg(m); setTimeout(() => setMsg(''), 2500) }

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
      {msg && <div className="mb-2 rounded bg-blue-50 px-3 py-1.5 text-xs text-blue-600">{msg}</div>}
      {authors.length === 0 ? (
        <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录</span>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs text-zinc-400">
              <th className="py-2 pr-2 font-medium">作者</th>
              <th className="py-2 pr-2 font-medium">主页链接</th>
              <th className="py-2 pr-2 font-medium">品类</th>
              <th className="py-2 pr-2 font-medium">视频数</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {authors.map(a => (
              <tr key={`${a.platform}:${a.sec_uid}`} className="border-b border-zinc-100">
                <td className="py-2 pr-2 font-medium">{a.nickname}</td>
                <td className="max-w-[260px] truncate py-2 pr-2">
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
                  <button className={`${btnPrimary} !px-2 !py-1 !text-xs`} onClick={() => void crawlHome(a)}>爬主页</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
