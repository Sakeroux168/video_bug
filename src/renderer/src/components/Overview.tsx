import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, btn } from './ui'
import { Icon, type IconName } from './icons'
import { useCoalescedRefresh } from './useCoalescedRefresh'
import type { GlobalStats, RecentDownload, TaskRow, AuthorRow, FilesTree, AsrStatus, AppSettings } from '../../../shared/types'

/**
 * 概览页 —— 默认落地页。
 *
 * 刷新策略是这一页的核心约束，分三档：
 *  1. **事件驱动 + 合并**：全站计数、进行中任务、最近完成。走 useCoalescedRefresh，
 *     否则下载时每个视频至少 3 次事件会把 IPC 打爆。
 *  2. **挂载一次**：环境自检、作者统计。前者只在改设置后变；后者是 SELECT * 全表，
 *     而作者数变化频率极低。
 *  3. **只能手动**：磁盘占用。scanFilesTree 是同步 readdirSync + statSync 跑在主进程上，
 *     扫描期间所有 IPC、窗口事件、下载器回调全部排队 —— 它不只是慢，是会卡住整个程序。
 *     所以首次进页也不自动扫，必须用户点。
 */

function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

const hhmm = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'

const TONE: Record<string, string> = {
  slate: 'text-slate-700',
  sky: 'text-sky-600',
  success: 'text-success-600',
  danger: 'text-danger-600',
  amber: 'text-amber-600'
}

/** 一行统计：标签 + 数字。数字等宽，便于竖向扫读 */
function Stat({ label, value, tone = 'slate' }: { label: string; value: number; tone?: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${TONE[tone] ?? TONE.slate}`}>{value}</span>
    </div>
  )
}

function StatCard({ icon, title, onGoto, children }: {
  icon: IconName
  title: string
  onGoto?: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Icon name={icon} className="h-4 w-4 text-slate-400" />{title}
        </span>
        {onGoto && (
          <button type="button" className="flex items-center gap-0.5 text-xs text-slate-400 hover:text-brand-600" onClick={onGoto}>
            查看全部<Icon name="chevronRight" className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Check({ ok, label, okText, badText }: {
  ok: boolean; label: string; okText: string; badText: string
}): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <Icon name={ok ? 'checkCircle' : 'alertTriangle'} className={`h-3.5 w-3.5 ${ok ? 'text-success-600' : 'text-amber-600'}`} />
      <span className="text-slate-500">{label}</span>
      <span className={ok ? 'text-slate-700' : 'text-amber-600'}>{ok ? okText : badText}</span>
    </span>
  )
}

export default function Overview({ onGoto }: { onGoto: (tab: string) => void }): React.ReactElement {
  const [g, setG] = useState<GlobalStats | null>(null)
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [recent, setRecent] = useState<RecentDownload[]>([])
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [asr, setAsr] = useState<AsrStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dl, setDl] = useState<{ paused: boolean } | null>(null)
  const [tree, setTree] = useState<FilesTree | null>(null)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  // 第 1 档：事件驱动 + 合并
  const pull = useCallback((): void => {
    void api.getGlobalStats().then(setG)
    void api.listTasks().then(setTasks)
    void api.getRecentDownloads(8).then(setRecent)
    void api.getDownloadState().then(setDl)
  }, [])
  const refresh = useCoalescedRefresh(pull, 800)

  useEffect(() => {
    pull()
    // 第 2 档：挂载一次
    void api.listAuthors().then(setAuthors)
    void api.getAsrStatus().then(setAsr)
    void api.getSettings().then(setSettings)
    return api.onTaskProgress(() => refresh())
  }, [pull, refresh])

  // 第 3 档：只能手动。见文件头注释——同步扫描会阻塞主进程
  async function scanDisk(): Promise<void> {
    setScanning(true)
    try {
      setTree(await api.getFilesTree())
      setScannedAt(new Date().toISOString())
    } finally {
      setScanning(false)
    }
  }

  const running = tasks.filter(t => t.status === 'running' || t.status === 'pending')
  const pendingVerify = authors.filter(a => a.verify_state === 'pending').length
  const uncategorized = authors.filter(a => !a.category).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs">
        <Check ok={!!settings?.downloadDir} label="下载目录" okText="已设置" badText="未设置" />
        <Check ok={!!asr?.ready} label="语音模型" okText="已就绪" badText="未下载" />
        <Check ok={!!settings?.aiApiKey} label="AI 分类" okText="已配置" badText="未配置（不影响爬取下载）" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="tasks" title="任务" onGoto={() => onGoto('tasks')}>
          <Stat label="进行中" value={g?.tasks.running ?? 0} tone="sky" />
          <Stat label="等待中" value={g?.tasks.pending ?? 0} />
          <Stat label="已完成" value={g?.tasks.done ?? 0} tone="success" />
          <Stat label="已暂停" value={g?.tasks.paused ?? 0} tone="amber" />
        </StatCard>

        <StatCard icon="download" title="视频" onGoto={() => onGoto('tasks')}>
          <Stat label="已完成" value={g?.videos.done ?? 0} tone="success" />
          <Stat label="下载中" value={g?.videos.downloading ?? 0} tone="sky" />
          <Stat label="待下载" value={g?.videos.pending ?? 0} />
          <Stat label="失败" value={g?.videos.failed ?? 0} tone="danger" />
        </StatCard>

        <StatCard icon="authors" title="作者" onGoto={() => onGoto('authors')}>
          <Stat label="总数" value={authors.length} />
          <Stat label="待校验" value={pendingVerify} tone="amber" />
          <Stat label="未分类" value={uncategorized} />
        </StatCard>

        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Icon name="hardDrive" className="h-4 w-4 text-slate-400" />磁盘占用
            </span>
            <button type="button" className={btn('ghost', 'xs')} disabled={scanning} onClick={() => void scanDisk()}>
              {scanning ? '扫描中…' : '扫描'}
            </button>
          </div>
          {tree ? (
            <>
              <div className="text-xl font-semibold tabular-nums text-slate-800">{fmtSize(tree.totalSize)}</div>
              <div className="mt-1 space-y-1">
                {tree.categories.slice(0, 3).map(c => (
                  <div key={c.name} className="flex items-baseline justify-between text-xs">
                    <span className="truncate text-slate-500">{c.name}</span>
                    <span className="tabular-nums text-slate-600">{fmtSize(c.size)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">更新于 {hhmm(scannedAt)}</div>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-slate-400">
              未扫描。统计磁盘要遍历整个下载目录，比较慢，所以不自动执行 —— 需要时点上面的「扫描」。
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="当前进行中">
          {running.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">没有正在跑的任务</p>
          ) : (
            <div className="space-y-3">
              {running.slice(0, 5).map(t => {
                const pct = t.target_count ? Math.min(100, Math.round((t.fetched_count / t.target_count) * 100)) : 0
                return (
                  <button key={t.id} type="button" className="block w-full text-left" onClick={() => onGoto('tasks')}>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="truncate font-medium text-slate-700">「{t.author_nickname ?? t.query}」</span>
                      <span className="ml-2 shrink-0 tabular-nums text-slate-500">{t.fetched_count}/{t.target_count}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-200">
                      <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                )
              })}
              <div className="flex items-center justify-between pt-1 text-xs text-slate-500">
                {/* 刻意不写「队列深度」：downloader 的内部队列没有 IPC，这是用视频状态做的近似 */}
                <span className="tabular-nums">待下载 {g?.videos.pending ?? 0} · 下载中 {g?.videos.downloading ?? 0}</span>
                {dl && <span className={dl.paused ? 'text-amber-600' : 'text-success-600'}>{dl.paused ? '下载已暂停' : '下载进行中'}</span>}
              </div>
            </div>
          )}
        </Card>

        <Card title="最近完成">
          {recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">还没有下载完成的视频</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {recent.map(r => (
                <div key={r.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <Icon name="checkCircle" className="h-3.5 w-3.5 shrink-0 text-success-600" />
                  <span className="min-w-0 flex-1 truncate text-slate-700">{r.title || '（无标题）'}</span>
                  <span className="shrink-0 text-slate-400">{r.author_nickname ?? '—'}</span>
                  <span className="shrink-0 tabular-nums text-slate-400">{hhmm(r.downloaded_at)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
