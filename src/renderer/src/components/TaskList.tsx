import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { TaskRow, VideoRow, TaskStats } from '../../../shared/types'
import { Card, inputCls } from './ui'

const TASK_STATUS_LABEL: Record<string, string> = { pending: '等待中', running: '进行中', done: '完成', paused: '已暂停', failed: '失败' }

const STATUS_LABEL: Record<string, string> = {
  pending: '等待', downloading: '下载中', done: '完成', failed: '失败',
  filtered: '已过滤', collected: '待下载', cancelled: '已取消'
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'text-zinc-500',
  downloading: 'text-blue-600',
  done: 'text-emerald-600',
  failed: 'text-red-500',
  filtered: 'text-zinc-400',
  collected: 'text-amber-600',
  cancelled: 'text-zinc-400'
}

const PAGE_SIZE = 50

type SortKey = 'title' | 'author' | 'duration' | 'publish_time' | 'likes'

const btnSmall = 'rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40'

function getLikes(v: VideoRow): number {
  try {
    const o = JSON.parse(v.stats || '{}') as { likes?: number }
    return typeof o.likes === 'number' ? o.likes : 0
  } catch {
    return 0
  }
}

function formatLikes(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

export default function TaskList({ notify }: { notify: (text: string) => void }): React.ReactElement {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [videos, setVideos] = useState<Record<number, VideoRow[]>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [stats, setStats] = useState<Record<number, TaskStats>>({})
  const [downloadPaused, setDownloadPaused] = useState(false)
  const [sortState, setSortState] = useState<Record<number, { key: SortKey; dir: 1 | -1 }>>({})
  const [searchText, setSearchText] = useState<Record<number, string>>({})
  const [page, setPage] = useState<Record<number, number>>({})

  const refresh = () => {
    void api.getDownloadState().then(s => setDownloadPaused(s.paused))
    void api.listTasks().then(ts => {
      setTasks(ts)
      void Promise.all(ts.map(t => api.getTaskStats(t.id))).then(all => {
        const m: Record<number, TaskStats> = {}
        ts.forEach((t, i) => { m[t.id] = all[i] })
        setStats(m)
      })
      // 刷新时同步拉取已展开任务的视频（进度事件会让状态变化，需重新拉最新）
      const expandedTasks = ts.filter(t => expanded.has(t.id))
      if (expandedTasks.length > 0) {
        void Promise.all(expandedTasks.map(t => api.listTaskVideos(t.id))).then(vv => {
          expandedTasks.forEach((t, i) => {
            setVideos(prev => ({ ...prev, [t.id]: vv[i] }))
          })
        })
      }
    })
  }

  // 用 ref 持有最新 refresh，避免 onTaskProgress 闭包捕获过期 expanded
  const refreshRef = useRef(refresh)
  useEffect(() => { refreshRef.current = refresh })

  useEffect(() => {
    refreshRef.current()
    const off = api.onTaskProgress(() => refreshRef.current())
    return off
  }, [])

  async function toggleExpand(id: number): Promise<void> {
    const next = new Set(expanded)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
      try {
        const vs = await api.listTaskVideos(id)
        setVideos(prev => ({ ...prev, [id]: vs }))
      } catch {
        setVideos(prev => ({ ...prev, [id]: [] }))
      }
    }
    setExpanded(next)
  }

  function toggleSelectVideo(id: number): void {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectPage(taskId: number, allSelected: boolean, selectableIds: number[]): void {
    setSelected(prev => {
      const next = new Set(prev)
      for (const vid of selectableIds) {
        if (allSelected) next.delete(vid); else next.add(vid)
      }
      return next
    })
  }

  interface Derived {
    filtered: VideoRow[]
    pageCount: number
    curPage: number
    pageVideos: VideoRow[]
    selectableIds: number[]
    allOnPageSelected: boolean
    someOnPageSelected: boolean
    selDownloadable: number[]
    selCancellable: number[]
    selFailed: number[]
    collectedIds: number[]
  }

  // 排序/搜索/分页/勾选全部用 useMemo 派生，避免每次渲染重算
  const derived = useMemo(() => {
    const out: Record<number, Derived> = {}
    for (const id of expanded) {
      const vs = videos[id] ?? []
      const srt = sortState[id]
      const q = (searchText[id] ?? '').trim().toLowerCase()
      let filtered = vs
      if (q) {
        filtered = vs.filter(v =>
          v.title.toLowerCase().includes(q) || (v.author_nickname ?? '').toLowerCase().includes(q)
        )
      }
      if (srt) {
        filtered = [...filtered].sort((a, b) => {
          let r = 0
          switch (srt.key) {
            case 'title': r = a.title.localeCompare(b.title, 'zh'); break
            case 'author': r = (a.author_nickname ?? '').localeCompare(b.author_nickname ?? '', 'zh'); break
            case 'duration': r = a.duration - b.duration; break
            case 'publish_time': r = (a.publish_time ?? '').localeCompare(b.publish_time ?? ''); break
            case 'likes': r = getLikes(a) - getLikes(b); break
          }
          return r * srt.dir
        })
      }
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const curPage = Math.min(Math.max(1, page[id] ?? 1), pageCount)
      const pageVideos = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
      const selectableIds = pageVideos.filter(v => v.status !== 'filtered').map(v => v.id)
      const vmap = new Map(vs.map(v => [v.id, v]))
      const onSel = selectableIds.filter(vid => selected.has(vid))
      const allOnPageSelected = selectableIds.length > 0 && onSel.length === selectableIds.length
      const someOnPageSelected = onSel.length > 0
      const selDownloadable = selectableIds.filter(vid => {
        const st = vmap.get(vid)!.status
        return st === 'collected' || st === 'cancelled' || st === 'failed'
      })
      const selCancellable = selectableIds.filter(vid => {
        const st = vmap.get(vid)!.status
        return st === 'pending' || st === 'downloading'
      })
      const selFailed = selectableIds.filter(vid => vmap.get(vid)!.status === 'failed')
      const collectedIds = vs.filter(v => v.status === 'collected').map(v => v.id)
      out[id] = { filtered, pageCount, curPage, pageVideos, selectableIds, allOnPageSelected, someOnPageSelected, selDownloadable, selCancellable, selFailed, collectedIds }
    }
    return out
  }, [expanded, videos, sortState, searchText, page, selected])

  function sortHeader(taskId: number, key: SortKey, label: string): React.ReactNode {
    const cur = sortState[taskId]
    const active = cur?.key === key
    const arrow = active ? (cur!.dir === 1 ? ' ↑' : ' ↓') : ''
    return (
      <th className="whitespace-nowrap py-1 px-1 font-normal">
        <button
          className={`${active ? 'text-zinc-800' : ''} hover:text-zinc-800`}
          onClick={() => setSortState(prev => {
            const p = { ...prev }
            if (p[taskId]?.key === key) p[taskId] = { key, dir: p[taskId].dir === 1 ? -1 : 1 }
            else p[taskId] = { key, dir: (key === 'likes' || key === 'publish_time') ? -1 : 1 }
            return p
          })}
        >
          {label}{arrow}
        </button>
      </th>
    )
  }

  return (
    <Card title="任务列表">
      <div className="mb-3 flex items-center gap-2">
        {downloadPaused ? (
          <button
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            onClick={() => { void api.downloadResume().then(() => { refresh(); notify('已恢复下载') }) }}
          >继续下载</button>
        ) : (
          <button
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
            onClick={() => { void api.downloadPause().then(() => { refresh(); notify('已暂停下载') }) }}
          >暂停下载</button>
        )}
      </div>
      <div className="space-y-2">
        {tasks.map(t => {
          const pct = t.target_count ? Math.min(100, Math.round((t.fetched_count / t.target_count) * 100)) : 0
          const s = stats[t.id]
          const dp = s && s.total ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0
          const d = derived[t.id]
          return (
            <div key={t.id} className="rounded-md border border-zinc-200 p-3">
              <div className="flex items-center gap-3 text-sm">
                <span className="w-24 truncate text-zinc-500">{t.platform}/{t.type}</span>
                <span className="min-w-0 flex-1 truncate font-medium">"{t.query}"</span>
                <span className="text-zinc-500">{t.fetched_count}/{t.target_count}</span>
                <div className="h-2 w-40 overflow-hidden rounded bg-zinc-200">
                  <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                </div>
                <span className={`w-16 text-center text-xs ${t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-blue-600' : 'text-zinc-500'}`}>
                  {TASK_STATUS_LABEL[t.status]}
                </span>
                <button className="text-xs text-zinc-400" onClick={() => void toggleExpand(t.id)}>{expanded.has(t.id) ? '收起' : '展开'}</button>
                {t.status === 'running' && (
                  <button className="text-xs text-zinc-400" onClick={() => { void api.pauseTask(t.id).then(refresh) }}>暂停</button>
                )}
                {t.status === 'paused' && (
                  <button className="text-xs text-zinc-400" onClick={() => { void api.resumeTask(t.id).then(refresh) }}>继续</button>
                )}
                <button className="text-xs text-red-400" onClick={() => { void api.deleteTask(t.id).then(refresh) }}>删除</button>
              </div>
              {s && s.total > 0 && (
                <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>
                    下载 {s.done}/{s.total}
                    {s.downloading > 0 ? `（下载中 ${s.downloading}）` : ''}
                    {s.failed > 0 ? `（失败 ${s.failed}）` : ''}
                    {s.collected > 0 ? ` 待下载 ${s.collected}` : ''}
                    {s.cancelled > 0 ? ` 已取消 ${s.cancelled}` : ''}
                  </span>
                  <div className="h-1.5 w-32 overflow-hidden rounded bg-zinc-200">
                    <div className="h-full bg-emerald-500" style={{ width: `${dp}%` }} />
                  </div>
                </div>
              )}
              {t.status === 'paused' && t.error === 'stalled_verify' && (
                <div className="mt-2 rounded bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                  任务可能触发验证，请到「内置浏览器」完成验证（滑块/扫码）后点「继续」
                </div>
              )}
              {expanded.has(t.id) && (
                <div className="mt-2 border-t border-zinc-100 pt-2 text-xs">
                  {d && s && s.collected > 0 && (
                    <div className="mb-2 flex items-center justify-between rounded bg-amber-50 px-3 py-1.5 text-amber-700">
                      <span>已抓取 {s.collected} 条，尚未下载</span>
                      {d.collectedIds.length > 0 && (
                        <button
                          className="font-medium underline"
                          onClick={() => { void api.downloadVideos(d.collectedIds).then(() => { refresh(); notify(`已开始下载 ${d.collectedIds.length} 个视频`) }) }}
                        >全部下载</button>
                      )}
                    </div>
                  )}
                  {d && (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputCls} !py-1 !text-xs`}
                        placeholder="搜索标题/作者"
                        value={searchText[t.id] ?? ''}
                        onChange={e => {
                          setSearchText(prev => ({ ...prev, [t.id]: e.target.value }))
                          setPage(prev => ({ ...prev, [t.id]: 1 }))
                        }}
                      />
                      {d.selDownloadable.length > 0 && (
                        <button
                          className={btnSmall}
                          onClick={() => { void api.downloadVideos(d.selDownloadable).then(() => { refresh(); notify(`已开始下载 ${d.selDownloadable.length} 个视频`) }) }}
                        >下载选中({d.selDownloadable.length})</button>
                      )}
                      {d.selCancellable.length > 0 && (
                        <button
                          className={btnSmall}
                          onClick={() => { void api.cancelVideos(d.selCancellable).then(() => { refresh(); notify(`已取消 ${d.selCancellable.length} 个下载`) }) }}
                        >取消选中({d.selCancellable.length})</button>
                      )}
                      {d.selFailed.length > 0 && (
                        <button
                          className={btnSmall}
                          onClick={() => { void api.retryVideos(d.selFailed).then(() => { refresh(); notify(`已重试 ${d.selFailed.length} 个视频`) }) }}
                        >重试选中失败({d.selFailed.length})</button>
                      )}
                    </div>
                  )}
                  {!videos[t.id] ? (
                    <div className="py-3 text-center text-zinc-400">加载中…</div>
                  ) : videos[t.id].length === 0 ? (
                    <div className="py-3 text-center text-zinc-400">（暂无视频）</div>
                  ) : d ? (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse">
                          <thead>
                            <tr className="border-b border-zinc-200 text-left text-zinc-500">
                              <th className="w-8 py-1 pr-1 font-normal">
                                <input
                                  type="checkbox"
                                  checked={d.allOnPageSelected}
                                  ref={el => { if (el) el.indeterminate = d.someOnPageSelected && !d.allOnPageSelected }}
                                  onChange={() => toggleSelectPage(t.id, d.allOnPageSelected, d.selectableIds)}
                                />
                              </th>
                              {sortHeader(t.id, 'title', '标题')}
                              {sortHeader(t.id, 'author', '作者')}
                              {sortHeader(t.id, 'duration', '时长')}
                              {sortHeader(t.id, 'publish_time', '发布')}
                              {sortHeader(t.id, 'likes', '点赞')}
                              <th className="w-14 py-1 px-1 font-normal">状态</th>
                              <th className="py-1 pl-2 pr-1 font-normal">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.pageVideos.map(v => {
                              const isFiltered = v.status === 'filtered'
                              return (
                                <tr key={v.id} className={`border-b border-zinc-100 ${isFiltered ? 'text-zinc-400' : ''}`}>
                                  <td className="py-1 pr-1">
                                    <input type="checkbox" disabled={isFiltered} checked={selected.has(v.id)} onChange={() => toggleSelectVideo(v.id)} />
                                  </td>
                                  <td className="max-w-0 py-1 pr-2"><span className="block truncate">{v.title || '（无标题）'}</span></td>
                                  <td className="whitespace-nowrap py-1 pr-2">{v.author_nickname ?? '—'}</td>
                                  <td className="whitespace-nowrap py-1 pr-2">{formatDuration(v.duration)}</td>
                                  <td className="whitespace-nowrap py-1 pr-2">{formatDate(v.publish_time)}</td>
                                  <td className="whitespace-nowrap py-1 pr-2">{formatLikes(getLikes(v))}</td>
                                  <td className={`whitespace-nowrap py-1 pr-2 ${STATUS_CLASS[v.status] ?? 'text-zinc-500'}`}>{STATUS_LABEL[v.status] ?? v.status}</td>
                                  <td className="whitespace-nowrap py-1 pl-2">
                                    {!isFiltered && (
                                      <div className="flex items-center gap-1.5">
                                        {(v.status === 'collected' || v.status === 'cancelled' || v.status === 'failed') && (
                                          <RowBtn label="下载" onClick={() => { void api.downloadVideos([v.id]).then(() => { refresh(); notify('已开始下载') }) }} />
                                        )}
                                        {v.status === 'failed' && (
                                          <RowBtn label="重试" onClick={() => { void api.retryVideos([v.id]).then(() => { refresh(); notify('已重试') }) }} />
                                        )}
                                        {(v.status === 'pending' || v.status === 'downloading') && (
                                          <RowBtn label="取消" onClick={() => { void api.cancelVideos([v.id]).then(() => { refresh(); notify('已取消') }) }} />
                                        )}
                                        {v.status === 'done' && v.local_path && (
                                          <RowBtn label="定位" onClick={() => void api.locateVideo(v.local_path!)} />
                                        )}
                                        <a className="text-blue-500 hover:underline" href={`https://www.douyin.com/video/${v.aweme_id}`} target="_blank" rel="noreferrer">原视频</a>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-zinc-400">共 {d.filtered.length} 条</span>
                        <div className="flex items-center gap-2">
                          <button
                            className={btnSmall}
                            disabled={d.curPage <= 1}
                            onClick={() => setPage(prev => ({ ...prev, [t.id]: d.curPage - 1 }))}
                          >上一页</button>
                          <span className="text-zinc-500">第 {d.curPage} / {d.pageCount} 页</span>
                          <button
                            className={btnSmall}
                            disabled={d.curPage >= d.pageCount}
                            onClick={() => setPage(prev => ({ ...prev, [t.id]: d.curPage + 1 }))}
                          >下一页</button>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function RowBtn({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return <button className="text-blue-500 hover:underline" onClick={onClick}>{label}</button>
}
