import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { TaskRow, VideoRow } from '../../../shared/types'
import { Card, btnPrimary, inputCls } from './ui'

const STATUS_LABEL: Record<string, string> = { pending: '等待中', running: '进行中', done: '完成', paused: '已暂停', failed: '失败' }

export default function TaskList() {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [videos, setVideos] = useState<Record<number, VideoRow[]>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const refresh = () => { void api.listTasks().then(setTasks) }

  useEffect(() => {
    refresh()
    const off = api.onTaskProgress(refresh)
    return off
  }, [])

  async function toggleExpand(id: number): Promise<void> {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else {
      next.add(id)
      const vs = await api.listTaskVideos(id)
      setVideos(prev => ({ ...prev, [id]: vs }))
    }
    setExpanded(next)
  }

  function toggleSelect(id: number): void {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const selectedVideoIds = Object.entries(videos).flatMap(([tid, vs]) =>
    selected.has(Number(tid)) ? [] : vs.filter(v => v.status === 'failed' && selected.has(v.id)).map(v => v.id)
  )

  return (
    <Card title="任务列表">
      <div className="space-y-2">
        {tasks.map(t => {
          const pct = t.target_count ? Math.min(100, Math.round((t.fetched_count / t.target_count) * 100)) : 0
          return (
            <div key={t.id} className="rounded-md border border-zinc-200 p-3">
              <div className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} />
                <span className="w-24 truncate text-zinc-500">{t.platform}/{t.type}</span>
                <span className="min-w-0 flex-1 truncate font-medium">"{t.query}"</span>
                <span className="text-zinc-500">{t.fetched_count}/{t.target_count}</span>
                <div className="h-2 w-40 overflow-hidden rounded bg-zinc-200">
                  <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                </div>
                <span className={`w-16 text-center text-xs ${t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-blue-600' : 'text-zinc-500'}`}>
                  {STATUS_LABEL[t.status]}
                </span>
                <button className="text-xs text-zinc-400" onClick={() => void toggleExpand(t.id)}>{expanded.has(t.id) ? '收起' : '展开'}</button>
                <button className="text-xs text-zinc-400" onClick={() => { void (t.status === 'running' ? api.pauseTask(t.id) : api.resumeTask(t.id)).then(refresh) }}>
                  {t.status === 'running' ? '暂停' : t.status === 'paused' ? '继续' : ''}
                </button>
                <button className="text-xs text-red-400" onClick={() => { void api.deleteTask(t.id).then(refresh) }}>删除</button>
              </div>
              {expanded.has(t.id) && (
                <div className="mt-2 max-h-48 overflow-auto border-t border-zinc-100 pl-7 text-xs">
                  {(videos[t.id] ?? []).map(v => (
                    <div key={v.id} className="flex items-center gap-2 py-1">
                      <span className="w-10 text-zinc-400">{v.status}</span>
                      <span className="min-w-0 flex-1 truncate">{v.title}</span>
                      {v.ai_verdict === 'filtered' && <span className="text-amber-500">AI已过滤</span>}
                      {v.status === 'failed' && <button className="text-blue-500" onClick={() => { void api.retryVideos([v.id]).then(refresh) }}>重试</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
