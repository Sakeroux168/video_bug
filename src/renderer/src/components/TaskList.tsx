import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { TaskRow, VideoRow, TaskStats } from '../../../shared/types'
import { Card, inputClsSm, btn } from './ui'
import { useMarqueeSelect } from './useMarqueeSelect'
import { useTableSelection } from './useTableSelection'
import { useCoalescedRefresh } from './useCoalescedRefresh'
import { describeError } from '../errors'
import { buildVideosCsv, toVideoExportRows, saveCsvFile, csvFileName } from './videosCsv'

const TASK_STATUS_LABEL: Record<string, string> = { pending: '等待中', running: '进行中', done: '完成', paused: '已暂停', failed: '失败' }

const TASK_TYPE_LABEL: Record<string, string> = { keyword: '关键词', author: '作者', hashtag: '话题' }

const STATUS_LABEL: Record<string, string> = {
  pending: '等待', downloading: '下载中', done: '完成', failed: '失败',
  filtered: '已过滤', collected: '待下载', cancelled: '已取消', paused: '已暂停'
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'text-slate-500',
  downloading: 'text-sky-600',
  done: 'text-emerald-600',
  failed: 'text-red-500',
  filtered: 'text-slate-400',
  collected: 'text-amber-600',
  cancelled: 'text-slate-400',
  paused: 'text-amber-500'
}

const DOWNLOAD_BADGES: Array<{ key: keyof TaskStats; label: string; className: string }> = [
  { key: 'pending', label: '等待', className: 'bg-slate-100 text-slate-600' },
  { key: 'done', label: '完成', className: 'bg-success-50 text-success-700' },
  { key: 'downloading', label: '下载中', className: 'bg-sky-50 text-sky-700' },
  { key: 'failed', label: '失败', className: 'bg-danger-50 text-danger-700' },
  { key: 'collected', label: '待下载', className: 'bg-warning-50 text-warning-700' },
  { key: 'filtered', label: '已过滤', className: 'bg-slate-50 text-slate-500' },
  { key: 'cancelled', label: '已取消', className: 'bg-slate-100 text-slate-600' },
  { key: 'paused', label: '已暂停', className: 'bg-warning-100 text-warning-700' }
]

/**
 * P4 签名元素：行首状态色条。
 *
 * **只映射 3 档**，不是 8 个状态各一色——一屏 50 行出现六种左边框不是签名，是噪音，
 * 而且状态文字本来就带色，色条会变成纯冗余。它只回答一个问题：这行需要我注意吗。
 *
 * **必须是完整字面量 Record**，绝不可写成 `border-${x}-400`——
 * 拼接类名会被 Tailwind purge 掉，而那是「测试全绿 + build 成功 + 打包后界面丢色」
 * 的唯一失败模式（交付形态是绿色版发员工，出问题时对方没 DevTools）。
 */
const ROW_BAR: Record<string, string> = {
  failed: 'border-danger-400',
  downloading: 'border-sky-400',
  pending: 'border-sky-400',
  done: 'border-success-400'
}
/** 无状态也必须渲染 border-l-2：条件性加边框会让第一列在状态变化时横移 2px，进度刷新时表格会抖 */
const rowBar = (status: string): string => `border-l-2 ${ROW_BAR[status] ?? 'border-transparent'}`

const PAGE_SIZE = 50

type SortKey = 'title' | 'author' | 'duration' | 'publish_time' | 'likes' | 'comments'

interface Derived {
  filtered: VideoRow[]
  /** 导出范围：选中优先，未选则是当前筛选后的这一批 */
  exportVideos: VideoRow[]
  pageCount: number
  curPage: number
  pageVideos: VideoRow[]
  selectableIds: number[]
  allOnPageSelected: boolean
  someOnPageSelected: boolean
  selDownloadable: number[]
  selCancellable: number[]
  selPausable: number[]
  selResumable: number[]
  selFailed: number[]
  selDeletable: number[]
  collectedIds: number[]
}

const btnSmall = 'rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40'

interface VideoStats {
  likes: number
  comments: number | null
}

function getVideoStats(v: VideoRow): VideoStats {
  try {
    const o = JSON.parse(v.stats || '{}') as Record<string, unknown>
    return {
      likes: typeof o.likes === 'number' && Number.isFinite(o.likes) ? o.likes : 0,
      comments: typeof o.comments === 'number' && Number.isInteger(o.comments) && o.comments >= 0
        ? o.comments
        : null
    }
  } catch {
    return { likes: 0, comments: null }
  }
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

function formatSourceUrl(sourceUrl: string): string {
  try {
    return `${new URL(sourceUrl).hostname} · ${sourceUrl}`
  } catch {
    return sourceUrl
  }
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
  const [onlyFailed, setOnlyFailed] = useState<Record<number, boolean>>({})
  // R11 Task2：任务「已重搜 N 次」计数——progress 瞬时推送携带 reSearchCount，DB 无此列，
  // 故存内存 Map；run 恢复/重跑时调度器重置计数并随 progress 推送 0，自动清零。
  const [reSearchCount, setReSearchCount] = useState<Record<number, number>>({})

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
  const coalescedRefresh = useCoalescedRefresh(() => refreshRef.current(), 800)
  const refreshRef = useRef(refresh)
  // 平台显示名来自 platforms:list（源头是各适配器的 displayName），
  // 界面不写 platform === 'douyin' 这类分支。未知平台或列表尚未到达时回落原始值，不留空白。
  const [platformNames, setPlatformNames] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.listPlatforms().then(list => {
      setPlatformNames(Object.fromEntries(list.map(p => [p.name, p.displayName])))
    })
  }, [])
  const platformLabel = (name: string): string => platformNames[name] ?? name

  /** 导出视频数据表：员工要拿去交差/做选题分析的那份 */
  function exportVideos(rows: VideoRow[]): void {
    saveCsvFile(buildVideosCsv(toVideoExportRows(rows, platformLabel)), csvFileName('视频数据'))
    notify(`已导出 ${rows.length} 条视频数据`)
  }

  useEffect(() => { refreshRef.current = refresh })

  useEffect(() => {
    refreshRef.current()
    // R11 Task2：progress 瞬时推送带 reSearchCount → 先更新徽标计数再照常刷新任务行。
    // R17：徽标计数**不进节流**——它只是一次 setState，且用户需要立刻看到重搜次数变化；
    // 真正昂贵的是下面那次全量重拉（listTasks + N 次 getTaskStats + 展开任务的全部视频），
    // 那个走合并：下载器每个视频至少 emit 3 次，500 个视频 ≈ 1500 次事件。
    const off = api.onTaskProgress(e => {
      if (e.type === 'task:progress' && typeof e.reSearchCount === 'number') {
        setReSearchCount(prev => ({ ...prev, [e.taskId]: e.reSearchCount as number }))
      }
      coalescedRefresh()
    })
    return off
  }, [coalescedRefresh])

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

  function toggleSelectPage(taskId: number, allSelected: boolean, selectableIds: number[]): void {
    setSelected(prev => {
      const next = new Set(prev)
      for (const vid of selectableIds) {
        if (allSelected) next.delete(vid); else next.add(vid)
      }
      return next
    })
  }

  // 框选 = 纯替换：松手后选中集合 = 框内命中的行（框住的全选中，含已选中的保持），
  // 框外一律取消；不更新锚点。函数式 setState 读到的 prev 即 endDrag 时刻的选中快照。
  function replaceSelect(ids: number[]): void {
    setSelected(new Set(ids))
  }

  // 点击表格容器空白区域 → 清空全部选择
  function clearSelection(): void {
    setSelected(new Set())
  }

  // Task3：程序内删除视频（③）——confirm 二次确认后删本地文件+DB 记录。
  // 部分失败（ok:false 但 deleted>0，如个别文件删不掉）：已删的照常刷新并提示条数，避免行残留假象；
  // 全部失败（deleted=0）才只报错误。
  function handleDeleteVideos(ids: number[]): void {
    if (ids.length === 0) return
    const msg = ids.length > 1
      ? `确定删除选中的 ${ids.length} 个视频？将同时删除本地文件`
      : '确定删除该视频？将同时删除本地文件'
    if (!window.confirm(msg)) return
    void api.deleteVideos(ids)
      .then(r => {
        if (!r) return
        if (r.deleted > 0) {
          // 清掉已删除行的勾选，避免 selected 残留失效 id
          setSelected(prev => { const next = new Set(prev); ids.forEach(i => next.delete(i)); return next })
          refresh()
          notify(r.ok === false
            ? `已删除 ${r.deleted} 条，部分失败：${r.error ?? '未知错误'}`
            : `已删除 ${r.deleted} 个视频`)
        } else if (r.ok === false) {
          notify(`删除失败：${r.error ?? '未知错误'}`)
        }
      })
      .catch(err => notify(`删除失败：${String(err)}`))
  }

  function handleSort(taskId: number, key: SortKey): void {
    setSortState(prev => {
      const p = { ...prev }
      if (p[taskId]?.key === key) p[taskId] = { key, dir: p[taskId].dir === 1 ? -1 : 1 }
      else p[taskId] = { key, dir: (key === 'likes' || key === 'publish_time') ? -1 : 1 }
      return p
    })
  }

  // 排序/搜索/分页/勾选全部用 useMemo 派生，避免每次渲染重算
  const derived = useMemo(() => {
    const out: Record<number, Derived> = {}
    for (const id of expanded) {
      const vs = videos[id] ?? []
      const srt = sortState[id]
      const q = (searchText[id] ?? '').trim().toLowerCase()
      let filtered = vs
      // 「只看失败」先过滤状态，再做搜索/排序/分页
      if (onlyFailed[id]) {
        filtered = filtered.filter(v => v.status === 'failed')
      }
      if (q) {
        filtered = filtered.filter(v =>
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
            case 'likes': r = getVideoStats(a).likes - getVideoStats(b).likes; break
            case 'comments': {
              const ac = getVideoStats(a).comments
              const bc = getVideoStats(b).comments
              if (ac === null) return bc === null ? 0 : 1
              if (bc === null) return -1
              r = ac - bc
              break
            }
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
      // 批量操作作用于整个 selected 集合（跨页保留勾选），按各自可选状态集过滤；
      // vmap 只含本任务视频，其它任务的勾选 id 自然被排除。
      const selDownloadable = [...selected].filter(vid => {
        const st = vmap.get(vid)?.status
        return st === 'collected' || st === 'cancelled' || st === 'failed'
      })
      const selCancellable = [...selected].filter(vid => {
        const st = vmap.get(vid)?.status
        return st === 'pending' || st === 'downloading'
      })
      // 批量暂停集 = pending/downloading（与取消集同状态集，语义不同），继续集 = paused，两集互斥
      const selPausable = [...selected].filter(vid => {
        const st = vmap.get(vid)?.status
        return st === 'pending' || st === 'downloading'
      })
      const selResumable = [...selected].filter(vid => vmap.get(vid)?.status === 'paused')
      const selFailed = [...selected].filter(vid => vmap.get(vid)?.status === 'failed')
      // Task3：删除对任何状态都可用，可删项 = 本任务 selected 全集（跨任务勾选经 vmap 排除）
      const selDeletable = [...selected].filter(vid => vmap.has(vid))
      // 导出范围：选中了就导选中的，没选就导当前看到的这一批（受「只看失败」筛选影响，
      // 所见即所得比"偷偷把筛掉的也导出去"更不容易出错）
      const selVideos = [...selected].map(vid => vmap.get(vid)).filter((v): v is VideoRow => !!v)
      const exportVideos = selVideos.length > 0 ? selVideos : filtered
      const collectedIds = vs.filter(v => v.status === 'collected').map(v => v.id)
      out[id] = { filtered, pageCount, curPage, pageVideos, selectableIds, allOnPageSelected, someOnPageSelected, selDownloadable, selCancellable, selPausable, selResumable, selFailed, selDeletable, collectedIds, exportVideos }
    }
    return out
  }, [expanded, videos, sortState, searchText, page, selected, onlyFailed])

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
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            onClick={() => { void api.downloadPause().then(() => { refresh(); notify('已暂停下载') }) }}
          >暂停下载</button>
        )}
      </div>
      {tasks.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400">暂无任务，先在上方「筛选条件」发起抓取</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="whitespace-nowrap py-2 pr-3 font-normal">平台/类型</th>
              <th className="py-2 pr-3 font-normal">关键词</th>
              <th className="w-52 py-2 pr-3 font-normal">进度</th>
              <th className="w-72 py-2 pr-3 font-normal">下载统计</th>
              <th className="w-16 py-2 pr-3 font-normal">状态</th>
              <th className="py-2 font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(t => {
              const pct = t.target_count ? Math.min(100, Math.round((t.fetched_count / t.target_count) * 100)) : 0
              const s = stats[t.id]
              const d = derived[t.id]
              const isOpen = expanded.has(t.id)
              return (
                <React.Fragment key={t.id}>
                  <tr
                    className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 ${isOpen ? 'bg-brand-50/40' : ''}`}
                    onClick={() => void toggleExpand(t.id)}
                  >
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{platformLabel(t.platform)} · {TASK_TYPE_LABEL[t.type] ?? t.type}</td>
                    <td className="max-w-0 py-2 pr-3 font-medium">
                      {/* 作者任务的 query 存的是 sec_uid（P1.5 归一化），直接显示是一串英文认不出是谁；
                          listTasks 已关联带出昵称。库里还没该作者时回落显示原值，不能空白。 */}
                      <span className="block truncate" title={t.query}>"{t.author_nickname ?? t.query}"</span>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">{t.fetched_count}/{t.target_count}</span>
                        {/* R11 Task2：爬不动自救触发过重搜 → 蓝色小标签显示已重搜次数（reSearchCount 来自 progress 瞬时推送） */}
                        {reSearchCount[t.id] > 0 && (
                          <span className="whitespace-nowrap rounded bg-sky-50 px-1 py-0.5 text-[10px] text-sky-700">
                            已重搜 {reSearchCount[t.id]} 次
                          </span>
                        )}
                        <div className="h-2 w-28 overflow-hidden rounded bg-slate-200">
                          <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {s && s.total > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {DOWNLOAD_BADGES.map(badge => s[badge.key] > 0 && (
                            <span
                              key={badge.key}
                              data-badge={badge.key}
                              className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${badge.className}`}
                            >
                              {badge.label} {s[badge.key]}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className={`whitespace-nowrap py-2 pr-3 text-xs ${t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-sky-600' : 'text-slate-500'}`}>
                      {TASK_STATUS_LABEL[t.status]}
                    </td>
                    <td className="whitespace-nowrap py-2" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-2 text-xs">
                        {t.status === 'pending' && (
                          // R11-3：等待中的任务可手动启动（与「继续」同通道 task:resume → scheduler.run；run 对 pending 无阻碍）
                          <button className="font-medium text-brand-600 hover:underline" onClick={() => { void api.resumeTask(t.id).then(refresh) }}>开始</button>
                        )}
                        {t.status === 'running' && (
                          <button className="text-slate-400 hover:text-slate-600" onClick={() => { void api.pauseTask(t.id).then(refresh) }}>暂停</button>
                        )}
                        {t.status === 'paused' && (
                          <button className="text-slate-400 hover:text-slate-600" onClick={() => { void api.resumeTask(t.id).then(refresh) }}>继续</button>
                        )}
                        <button className="text-red-400 hover:text-red-500" onClick={() => { void api.deleteTask(t.id).then(refresh) }}>删除</button>
                        <button className="text-brand-500 hover:underline" onClick={() => void toggleExpand(t.id)}>{isOpen ? '收起' : '展开'}</button>
                      </div>
                    </td>
                  </tr>
                  {t.status === 'paused' && t.error === 'stalled_verify' && (
                    <tr className="border-b border-slate-100 bg-amber-50/60">
                      <td colSpan={6} className="px-2 py-1.5 text-xs text-amber-700">
                        任务可能触发验证，请到「内置浏览器」完成验证（滑块/扫码）后点「继续」
                      </td>
                    </tr>
                  )}
                  {isOpen && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={6} className="px-2 pb-3 pt-2 text-xs">
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
                              className={inputClsSm}
                              placeholder="搜索标题/作者"
                              value={searchText[t.id] ?? ''}
                              onChange={e => {
                                setSearchText(prev => ({ ...prev, [t.id]: e.target.value }))
                                setPage(prev => ({ ...prev, [t.id]: 1 }))
                              }}
                            />
                            <button
                              className={btnSmall}
                              disabled={d.selDownloadable.length === 0}
                              onClick={() => { void api.downloadVideos(d.selDownloadable).then(() => { refresh(); notify(`已开始下载 ${d.selDownloadable.length} 个视频`) }) }}
                            >下载选中({d.selDownloadable.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.selCancellable.length === 0}
                              onClick={() => { void api.cancelVideos(d.selCancellable).then(() => { refresh(); notify(`已取消 ${d.selCancellable.length} 个下载`) }) }}
                            >取消选中({d.selCancellable.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.selPausable.length === 0}
                              onClick={() => { void api.pauseVideos(d.selPausable).then(() => { refresh(); notify(`已暂停 ${d.selPausable.length} 个下载`) }) }}
                            >暂停选中({d.selPausable.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.selResumable.length === 0}
                              onClick={() => { void api.resumeVideos(d.selResumable).then(() => { refresh(); notify(`已恢复 ${d.selResumable.length} 个下载`) }) }}
                            >继续选中({d.selResumable.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.selFailed.length === 0}
                              onClick={() => { void api.retryVideos(d.selFailed).then(() => { refresh(); notify(`已重试 ${d.selFailed.length} 个视频`) }) }}
                            >重试选中失败({d.selFailed.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.selDeletable.length === 0}
                              onClick={() => handleDeleteVideos(d.selDeletable)}
                            >删除选中({d.selDeletable.length})</button>
                            <button
                              className={btnSmall}
                              disabled={d.exportVideos.length === 0}
                              onClick={() => exportVideos(d.exportVideos)}
                            >导出表格({d.exportVideos.length})</button>
                            <button
                              className={onlyFailed[t.id] ? `${btn('secondary', 'sm')} border-danger-300 bg-danger-50 text-danger-600 hover:bg-danger-100` : btn('secondary', 'sm')}
                              onClick={() => {
                                setOnlyFailed(prev => ({ ...prev, [t.id]: !(prev[t.id] ?? false) }))
                                setPage(prev => ({ ...prev, [t.id]: 1 }))
                              }}
                            >{onlyFailed[t.id] ? '只看失败·开' : '只看失败'}</button>
                          </div>
                        )}
                        {!videos[t.id] ? (
                          <div className="py-3 text-center text-slate-400">加载中…</div>
                        ) : videos[t.id].length === 0 ? (
                          <div className="py-3 text-center text-slate-400">（暂无视频）</div>
                        ) : d ? (
                          <TaskVideoTable
                            d={d}
                            sort={sortState[t.id]}
                            selected={selected}
                            onSelectRows={setSelected}
                            onTogglePage={all => toggleSelectPage(t.id, all, d.selectableIds)}
                            onSort={key => handleSort(t.id, key)}
                            onPageChange={p => setPage(prev => ({ ...prev, [t.id]: p }))}
                            onReplaceSelect={replaceSelect}
                            onClearSelection={clearSelection}
                            onDeleteVideos={handleDeleteVideos}
                            notify={notify}
                            refresh={refresh}
                          />
                        ) : null}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/**
 * 任务展开区视频表格（独立组件以便每个任务的表格各自实例化框选 hook 与选择锚点）。
 * 选择交互（终版语义）：点行排他（已选行 → 全不选；未选行 → 只选它）、ctrl+点切换、
 * shift+点范围（锚点 = 最近普通/shift 点击行，ctrl 与框选不改锚点）、
 * 拖动框选 = 纯替换（框住的全选中、框外取消）、点容器空白清空；
 * 勾选框/链接/按钮不触发行选择；didDrag 防拖拽误伤。
 * 跨页选择语义由父组件 selected 集合承载（批量操作按完整 selected 过滤）。
 */
function TaskVideoTable({
  d, sort, selected, onSelectRows, onTogglePage, onSort, onPageChange,
  onReplaceSelect, onClearSelection, onDeleteVideos, notify, refresh
}: {
  d: Derived
  sort: { key: SortKey; dir: 1 | -1 } | undefined
  selected: Set<number>
  onSelectRows: (next: Set<number>) => void
  onTogglePage: (allSelected: boolean) => void
  onSort: (key: SortKey) => void
  onPageChange: (page: number) => void
  onReplaceSelect: (ids: number[]) => void
  onClearSelection: () => void
  onDeleteVideos: (ids: number[]) => void
  notify: (text: string) => void
  refresh: () => void
}): React.ReactElement {
  const { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag } = useMarqueeSelect({ onSelect: onReplaceSelect })
  // 行选择终版语义（排他/ctrl 切换/shift 范围），锚点按表格实例独立
  const { rowClick } = useTableSelection<number>()

  // 点容器内空白区域（非行、非交互元素）→ 清空全部选择；行内点击由行自身的 onClick 处理。
  // 跨行拖拽松手后 click 在公共祖先（tbody）派发并冒泡到这里，需用 didDragRef 跳过。
  function handleContainerClick(e: React.MouseEvent): void {
    if (didDragRef.current) return // 本次手势是拖拽框选，不视为点击
    const t = e.target as HTMLElement
    if (t.closest('tr, button, a, input')) return
    onClearSelection()
  }

  function handleRowClick(v: VideoRow, e: React.MouseEvent): void {
    if (didDragRef.current) return // 行内小拖拽（≥5px）后的 click 不切换选中
    if ((e.target as HTMLElement).closest('button, a, input')) return // 勾选框/链接/按钮不触发行切换
    // 终版语义：普通点排他 / ctrl 切换 / shift 范围；可见行 = 当前页可选行（锚点不在视图则退化）
    onSelectRows(rowClick(v.id, d.selectableIds, selected, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
  }

  async function copySourceUrl(v: VideoRow): Promise<void> {
    if (!v.source_url) {
      notify('作品链接不可用')
      return
    }
    try {
      await api.writeClipboard(v.source_url)
      notify('链接已复制')
    } catch {
      notify('复制链接失败')
    }
  }

  async function copyAuthorName(v: VideoRow): Promise<void> {
    if (!v.author_nickname) {
      notify('作者名不可用')
      return
    }
    try {
      await api.writeClipboard(v.author_nickname)
      notify('作者名已复制')
    } catch {
      notify('复制作者名失败')
    }
  }

  async function openSourceVideo(v: VideoRow): Promise<void> {
    try {
      const result = await api.openVideoSource(v.id)
      if (!result.ok) notify(result.error ?? '无法打开原视频')
    } catch {
      notify('无法打开原视频')
    }
  }

  function sortHeader(key: SortKey, label: string): React.ReactNode {
    const active = sort?.key === key
    const arrow = active ? (sort!.dir === 1 ? ' ↑' : ' ↓') : ''
    return (
      <th className="whitespace-nowrap py-1 px-1 font-normal">
        <button
          className={`${active ? 'text-slate-800' : ''} hover:text-slate-800`}
          onClick={() => onSort(key)}
        >
          {label}{arrow}
        </button>
      </th>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        data-testid="video-table"
        className="relative select-none overflow-x-auto"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onClick={handleContainerClick}
      >
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="w-8 py-1 pr-1 font-normal">
                <input
                  type="checkbox"
                  data-testid="select-all"
                  checked={d.allOnPageSelected}
                  ref={el => { if (el) el.indeterminate = d.someOnPageSelected && !d.allOnPageSelected }}
                  onChange={() => onTogglePage(d.allOnPageSelected)}
                />
              </th>
              {sortHeader('title', '标题')}
              {sortHeader('author', '作者')}
              {sortHeader('duration', '时长')}
              {sortHeader('publish_time', '发布')}
              {sortHeader('likes', '点赞')}
              {sortHeader('comments', '评论')}
              <th className="w-24 py-1 px-1 font-normal">状态</th>
              <th className="py-1 pl-2 pr-1 font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {d.pageVideos.map(v => {
              const isFiltered = v.status === 'filtered'
              const videoStats = getVideoStats(v)
              return (
                <tr
                  key={v.id}
                  data-id={isFiltered ? undefined : v.id}
                  data-selected={!isFiltered && selected.has(v.id) ? 'true' : undefined}
                  className={`border-b border-slate-100 transition-colors ${isFiltered ? 'text-slate-400' : 'cursor-pointer hover:bg-slate-50'} ${!isFiltered && selected.has(v.id) ? 'bg-brand-50' : ''}`}
                  onClick={isFiltered ? undefined : e => handleRowClick(v, e)}
                >
                  <td className={`${rowBar(v.status)} py-1 pl-1 pr-1`}>
                    <input type="checkbox" disabled={isFiltered} checked={selected.has(v.id)} onChange={() => onSelectRows(rowClick(v.id, d.selectableIds, selected, {}))} />
                  </td>
                  <td className="max-w-0 py-1 pr-2">
                    <span className="block truncate">{v.title || '（无标题）'}</span>
                    {v.source_url ? (
                      <span
                        data-source-url
                        className="block truncate text-[10px] leading-tight text-slate-400"
                        title={v.source_url}
                      >
                        {formatSourceUrl(v.source_url)}
                      </span>
                    ) : (
                      <span data-source-url className="block text-[10px] leading-tight text-slate-300">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2">{v.author_nickname ?? '—'}</td>
                  <td className="whitespace-nowrap py-1 pr-2 tabular-nums">{formatDuration(v.duration)}</td>
                  <td className="whitespace-nowrap py-1 pr-2 tabular-nums">{formatDate(v.publish_time)}</td>
                  <td className="whitespace-nowrap py-1 pr-2 tabular-nums">{formatCount(videoStats.likes)}</td>
                  <td data-stat="comments" className="whitespace-nowrap py-1 pr-2 tabular-nums">
                    {videoStats.comments === null ? '—' : formatCount(videoStats.comments)}
                  </td>
                  <td className={`py-1 pr-2 ${STATUS_CLASS[v.status] ?? 'text-slate-500'}`}>
                    <span className="whitespace-nowrap">{STATUS_LABEL[v.status] ?? v.status}</span>
                    {v.status === 'failed' && (
                      <span className="ml-1 text-[10px] leading-tight text-red-400/90">·{describeError(v.error)}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 pl-2">
                    {!isFiltered && (
                      <div className="flex items-center gap-1.5">
                        {(v.status === 'collected' || v.status === 'cancelled' || v.status === 'failed') && (
                          <RowBtn label="下载" action="download" onClick={() => { void api.downloadVideos([v.id]).then(() => { refresh(); notify('已开始下载') }) }} />
                        )}
                        {v.status === 'failed' && (
                          <RowBtn label="重试" action="retry" onClick={() => { void api.retryVideos([v.id]).then(() => { refresh(); notify('已重试') }) }} />
                        )}
                        {(v.status === 'pending' || v.status === 'downloading') && (
                          <RowBtn label="暂停" action="pause" onClick={() => { void api.pauseVideos([v.id]).then(() => { refresh(); notify('已暂停') }) }} />
                        )}
                        {v.status === 'paused' && (
                          <RowBtn label="继续" action="resume" onClick={() => { void api.resumeVideos([v.id]).then(() => { refresh(); notify('已恢复下载') }) }} />
                        )}
                        {(v.status === 'pending' || v.status === 'downloading') && (
                          <RowBtn label="取消" action="cancel" onClick={() => { void api.cancelVideos([v.id]).then(() => { refresh(); notify('已取消') }) }} />
                        )}
                        {v.status === 'done' && v.local_path && (
                          <RowBtn label="定位" action="locate" onClick={() => void api.locateVideo(v.local_path!)} />
                        )}
                        <RowBtn label="打开原视频" action="source" onClick={() => { void openSourceVideo(v) }} />
                        <RowBtn label="复制链接" action="copy-source" onClick={() => { void copySourceUrl(v) }} />
                        <RowBtn label="复制作者名" action="copy-author" onClick={() => { void copyAuthorName(v) }} />
                        <button data-action="delete" className="text-red-400 hover:text-red-500" onClick={() => onDeleteVideos([v.id])}>删除</button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {marquee && (
          <div
            className="pointer-events-none absolute border border-brand-400 bg-brand-200/40"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="tabular-nums text-slate-400">共 {d.filtered.length} 条</span>
        <div className="flex items-center gap-2">
          <button
            className={btnSmall}
            disabled={d.curPage <= 1}
            onClick={() => onPageChange(d.curPage - 1)}
          >上一页</button>
          <span className="tabular-nums text-slate-500">第 {d.curPage} / {d.pageCount} 页</span>
          <button
            className={btnSmall}
            disabled={d.curPage >= d.pageCount}
            onClick={() => onPageChange(d.curPage + 1)}
          >下一页</button>
        </div>
      </div>
    </>
  )
}

/** 行内文字按钮。data-action 供测试断言「这一行提供了什么能力」，与按钮文案解耦
 *  （文案另有一条契约测试单独锁）。必须保持原生 <button>：useMarqueeSelect 的
 *  closest('button, a, input') 守卫靠它区分「点按钮」与「点行/框选」。 */
function RowBtn({ label, action, onClick }: { label: string; action: string; onClick: () => void }): React.ReactElement {
  return <button data-action={action} className="text-brand-500 hover:underline" onClick={onClick}>{label}</button>
}
