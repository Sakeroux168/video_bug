import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { LibraryExportResponse, LibraryQuery, LibraryRow, VideoMark } from '../../../shared/types'
import { Card, btn, inputCls } from './ui'

/**
 * 素材库（2026-10-07 功能 E / N07 / N08）：用封面缩略图浏览所有下载完成的视频。
 * 筛选、排序、分页都在主进程查库（几千条也不卡界面）；封面走 vs-cover://video/<id>，界面不碰文件路径。
 * 标记：星标 / 待用 / 已用（避免重复用同一条素材），备注随手记。
 * 多选（第二部分）：批量标记；「打包交付」= 复制到选的文件夹 + 来源清单，可顺便统一分辨率。
 */

const PAGE_SIZE = 60
const MARK_LABEL: Record<VideoMark, string> = { star: '星标', todo: '待用', used: '已用' }
const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书' }

function stats(v: LibraryRow): { likes: number | null; collects: number | null } {
  try {
    const o = JSON.parse(v.stats || '{}') as Record<string, unknown>
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
    return { likes: num(o.likes), collects: num(o.collects) }
  } catch { return { likes: null, collects: null } }
}
function count(n: number | null): string {
  if (n === null) return '—'
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : String(n)
}
function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 交付结果一句话：复制了几条、找不到 / 失败几条 */
function exportSummary(r: NonNullable<LibraryExportResponse['result']>): string {
  const parts = [`已复制 ${r.copied} 条`]
  if (r.missing) parts.push(`${r.missing} 条找不到文件`)
  if (r.failed) parts.push(`${r.failed} 条复制失败（看看磁盘空间）`)
  return parts.join('，')
}

export default function LibraryPanel({ notify, onOpenProcess }: { notify: (text: string) => void; onOpenProcess?: () => void }): React.ReactElement {
  const [q, setQ] = useState<LibraryQuery>({ sort: 'downloaded', page: 1, pageSize: PAGE_SIZE })
  const [data, setData] = useState<{ rows: LibraryRow[]; total: number } | null>(null)
  const [tasks, setTasks] = useState<Array<{ id: number; platform: string; type: string; query: string; count: number }>>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [exportOpen, setExportOpen] = useState(false)
  const [markUsed, setMarkUsed] = useState(true)
  const [normalize, setNormalize] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState<LibraryExportResponse | null>(null)

  const load = useCallback((query: LibraryQuery) => {
    void api.listLibrary(query).then(setData).catch(() => setData({ rows: [], total: 0 }))
  }, [])
  useEffect(() => { load(q) }, [q, load])
  useEffect(() => { void api.listLibraryTasks().then(setTasks).catch(() => setTasks([])) }, [])

  /** 改筛选条件：回到第 1 页 */
  const update = (patch: Partial<LibraryQuery>): void => setQ(prev => ({ ...prev, ...patch, page: 1 }))

  async function toggleMark(v: LibraryRow, mark: VideoMark): Promise<void> {
    const next = v.mark === mark ? null : mark
    await api.markVideos([v.id], next)
    setData(prev => prev && { ...prev, rows: prev.rows.map(r => r.id === v.id ? { ...r, mark: next } : r) })
  }

  function toggleSelect(id: number): void {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }

  async function markSelected(mark: VideoMark | null): Promise<void> {
    const ids = [...selected]
    await api.markVideos(ids, mark)
    setData(prev => prev && { ...prev, rows: prev.rows.map(r => selected.has(r.id) ? { ...r, mark } : r) })
  }

  async function runExport(): Promise<void> {
    setExporting(true)
    try {
      const r = await api.exportLibrary([...selected], { markUsed, normalize })
      if (r.canceled) return
      if (!r.ok || !r.result) { notify(r.error ?? '打包交付失败'); return }
      setExportDone(r)
      setExportOpen(false)
      setSelected(new Set())
      if (markUsed && r.result.copied > 0) load(q) // 标了「已用」，刷新一下卡片
    } catch {
      notify('打包交付失败')
    } finally {
      setExporting(false)
    }
  }

  async function saveNote(v: LibraryRow): Promise<void> {
    await api.noteVideo(v.id, draft)
    const note = draft.trim() || null
    setData(prev => prev && { ...prev, rows: prev.rows.map(r => r.id === v.id ? { ...r, note } : r) })
    setEditing(null)
  }

  async function play(v: LibraryRow): Promise<void> {
    const r = await api.playVideo(v.id)
    if (!r.ok) notify(r.error ?? '打不开这个视频')
  }
  async function locate(v: LibraryRow): Promise<void> {
    const r = await api.locateLibraryVideo(v.id)
    if (!r.ok) notify(r.error ?? '找不到这个视频文件')
  }

  const page = q.page ?? 1
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div className="space-y-4 pb-6">
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-xs text-slate-500">
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            搜索
            <input className={inputCls} placeholder="搜标题 / 作者 / 备注" value={q.search ?? ''} onChange={e => update({ search: e.target.value })} />
          </label>
          <label htmlFor="lib-platform" className="flex flex-col gap-1">
            平台
            <select id="lib-platform" className={inputCls} value={q.platform ?? ''} onChange={e => update({ platform: e.target.value || undefined })}>
              <option value="">全部</option>
              {Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label htmlFor="lib-task" className="flex max-w-[220px] flex-col gap-1">
            关键词
            <select id="lib-task" className={inputCls} value={q.taskId ?? ''} onChange={e => update({ taskId: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">全部</option>
              {tasks.map(t => <option key={t.id} value={t.id}>{PLATFORM_LABEL[t.platform] ?? t.platform} · {t.query}（{t.count}）</option>)}
            </select>
          </label>
          <label htmlFor="lib-mark" className="flex flex-col gap-1">
            标记
            <select id="lib-mark" className={inputCls} value={q.mark ?? ''} onChange={e => update({ mark: (e.target.value || undefined) as LibraryQuery['mark'] })}>
              <option value="">全部</option>
              <option value="star">星标</option>
              <option value="todo">待用</option>
              <option value="used">已用</option>
              <option value="none">没标记的</option>
            </select>
          </label>
          <label htmlFor="lib-sort" className="flex flex-col gap-1">
            排序
            <select id="lib-sort" className={inputCls} value={q.sort ?? 'downloaded'} onChange={e => update({ sort: e.target.value as LibraryQuery['sort'] })}>
              <option value="downloaded">最近下载</option>
              <option value="likes">点赞最多</option>
              <option value="collects">收藏最多</option>
              <option value="published">最新发布</option>
            </select>
          </label>
        </div>
      </Card>

      {selected.size > 0 && (
        <div data-testid="library-selection" className="sticky top-0 z-10 space-y-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-brand-700">已选 {selected.size} 条</span>
            <button type="button" className={btn('ghost', 'sm')} onClick={() => setSelected(prev => new Set([...prev, ...(data?.rows ?? []).map(r => r.id)]))}>全选本页</button>
            <button type="button" className={btn('ghost', 'sm')} onClick={() => { setSelected(new Set()); setExportOpen(false) }}>清空</button>
            <span className="mx-1 h-4 w-px bg-brand-200" />
            {(['star', 'todo', 'used'] as const).map(m => (
              <button key={m} type="button" className={btn('secondary', 'sm')} onClick={() => void markSelected(m)}>标为{MARK_LABEL[m]}</button>
            ))}
            <button type="button" className={btn('secondary', 'sm')} onClick={() => void markSelected(null)}>清除标记</button>
            <button type="button" className={`${btn('primary', 'sm')} ml-auto`} onClick={() => setExportOpen(o => !o)}>打包交付…</button>
          </div>
          {exportOpen && (
            <div className="flex flex-wrap items-center gap-4 border-t border-brand-200 pt-2 text-slate-600">
              <span className="text-slate-500">把选中的视频复制到一个文件夹，附一份「来源清单」表格；原视频不动。</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={markUsed} onChange={e => setMarkUsed(e.target.checked)} />
                交付后标为「已用」
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={normalize} onChange={e => setNormalize(e.target.checked)} />
                顺便统一分辨率（只处理复制过去的）
              </label>
              <button type="button" className={btn('primary', 'sm')} disabled={exporting} onClick={() => void runExport()}>
                {exporting ? '正在复制…' : '选文件夹并开始'}
              </button>
            </div>
          )}
        </div>
      )}

      {exportDone?.result && (
        <div data-testid="library-export-done" className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <span>
            {exportSummary(exportDone.result)}
            {exportDone.result.csvPath ? '，来源清单也放进去了' : ''}
            {exportDone.processing ? '。正在统一分辨率' : ''}
            {exportDone.processError ? `。统一分辨率没开始：${exportDone.processError}` : ''}
          </span>
          <button type="button" className={btn('secondary', 'sm')} onClick={() => void api.openDir(exportDone.result!.dir)}>打开文件夹</button>
          {exportDone.processing && onOpenProcess && (
            <button type="button" className={btn('secondary', 'sm')} onClick={onOpenProcess}>去看进度</button>
          )}
          <button type="button" className="ml-auto text-emerald-700 hover:underline" onClick={() => setExportDone(null)}>知道了</button>
        </div>
      )}

      {!data ? (
        <div className="py-8 text-center text-sm text-slate-400">加载中…</div>
      ) : data.total === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400">
          {q.search || q.platform || q.taskId || q.mark ? '没有符合条件的视频' : '还没有下载完成的视频，先去「任务」页抓一些'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.rows.map(v => {
              const st = stats(v)
              return (
                <div key={v.id} data-library-card className={`relative flex flex-col overflow-hidden rounded-lg border bg-white ${selected.has(v.id) ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200'} ${v.mark === 'used' ? 'opacity-60' : ''}`}>
                  <input type="checkbox" aria-label={`选中 ${v.title || '（无标题）'}`} checked={selected.has(v.id)} onChange={() => toggleSelect(v.id)}
                    className="absolute right-1.5 top-1.5 z-10 h-4 w-4 cursor-pointer" />
                  <button type="button" className="relative block aspect-[3/4] w-full bg-slate-100" title="播放" onClick={() => void play(v)}>
                    {v.cover_path
                      ? <img src={`vs-cover://video/${v.id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                      : <span className="flex h-full items-center justify-center text-xs text-slate-400">没有封面</span>}
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] tabular-nums text-white">{duration(v.duration)}</span>
                    {v.mark && <span className="absolute left-1 top-1 rounded bg-brand-600 px-1 text-[10px] text-white">{MARK_LABEL[v.mark]}</span>}
                  </button>
                  <div className="flex flex-1 flex-col gap-1 p-2 text-xs">
                    <div className="line-clamp-2 font-medium text-slate-800" title={v.title}>{v.title || '（无标题）'}</div>
                    <div className="truncate text-slate-500">{v.author_nickname ?? '—'} · {PLATFORM_LABEL[v.platform] ?? v.platform}{v.task_query ? ` · ${v.task_query}` : ''}</div>
                    <div className="flex flex-wrap gap-x-2 tabular-nums text-slate-500">
                      <span>赞 {count(st.likes)}</span>
                      <span>藏 {count(st.collects)}</span>
                      {v.video_width > 0 && <span>{v.video_width}×{v.video_height}</span>}
                    </div>
                    {v.note && editing !== v.id && <div className="truncate text-amber-700" title={v.note}>✎ {v.note}</div>}
                    {editing === v.id && (
                      <input autoFocus className={`${inputCls} py-1 text-xs`} placeholder="写点备注，回车保存" value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveNote(v); if (e.key === 'Escape') setEditing(null) }}
                        onBlur={() => void saveNote(v)} />
                    )}
                    <div className="mt-auto flex flex-wrap gap-1 pt-1">
                      {(['star', 'todo', 'used'] as const).map(m => (
                        <button key={m} type="button" aria-pressed={v.mark === m}
                          className={`rounded border px-1.5 py-0.5 ${v.mark === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                          onClick={() => void toggleMark(v, m)}>{MARK_LABEL[m]}</button>
                      ))}
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-slate-500 hover:bg-slate-50"
                        onClick={() => { setEditing(v.id); setDraft(v.note ?? '') }}>备注</button>
                    </div>
                    <div className="flex gap-2 text-brand-600">
                      <button type="button" className="hover:underline" onClick={() => void play(v)}>播放</button>
                      <button type="button" className="hover:underline" onClick={() => void locate(v)}>在文件夹中显示</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="tabular-nums text-slate-400">共 {data.total} 条</span>
            <div className="flex items-center gap-2">
              <button type="button" className={btn('secondary', 'sm')} disabled={page <= 1} onClick={() => setQ(prev => ({ ...prev, page: page - 1 }))}>上一页</button>
              <span className="tabular-nums text-slate-500">第 {page} / {pageCount} 页</span>
              <button type="button" className={btn('secondary', 'sm')} disabled={page >= pageCount} onClick={() => setQ(prev => ({ ...prev, page: page + 1 }))}>下一页</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
