import type { DatabaseSync } from 'node:sqlite'
import { listAuthors } from './db'
import { getAdapter } from './adapters'
import { createTaskChecked } from './taskCreate'
import { crawlRequest, crawledBefore } from '../shared/followCrawl'
import type { AppSettings } from '../shared/types'

/**
 * 自动化（2026-10-07 功能 3）：系统通知 + 每天定时追更。托盘和关窗行为在 index.ts（要碰窗口）。
 * 这里只放不依赖 Electron 的逻辑，方便测：什么时候该追更、给谁建任务、通知怎么写、怎么不刷屏。
 */

type Schedule = Pick<AppSettings, 'autoFollowEnabled' | 'autoFollowTime'>

/** 'HH:MM' → 今天这个钟点（本机时间）；写错了返回 null */
function dueToday(now: Date, time: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  return d
}

/** 到点了、今天到点之后还没跑过 → 跑。错过了点（下午才开电脑）开机后补跑一次。 */
export function shouldRunFollow(now: Date, s: Schedule, lastRunAt: string | null): boolean {
  if (!s.autoFollowEnabled) return false
  const due = dueToday(now, s.autoFollowTime)
  if (!due || now < due) return false
  const last = lastRunAt ? new Date(lastRunAt) : null
  return !last || !Number.isFinite(last.getTime()) || last < due
}

/** 会被追更的作者（平台要能建任务）：
 *  all = 爬过主页的（关键词搜索时顺带收进来的不算）；picked = 作者收藏里标了「定时追更」的（没爬过的也算，按全部抓） */
export function followAuthors(db: DatabaseSync, scope: AppSettings['autoFollowScope'] = 'all'): ReturnType<typeof listAuthors> {
  return listAuthors(db).filter(a => getAdapter(a.platform)?.taskReady !== false &&
    (scope === 'picked' ? a.auto_follow === 1 : crawledBefore(a)))
}

export interface AutoFollowResult { authors: number; created: number; skipped: number; taskIds: number[] }

/** 给每个爬过主页的作者建一个「只抓新视频」任务，排队一个个跑；已经在排队 / 在爬的跳过 */
export function runAutoFollow(db: DatabaseSync, enqueue: (id: number) => void, opts: { count: number; scope?: AppSettings['autoFollowScope'] }): AutoFollowResult {
  const authors = followAuthors(db, opts.scope)
  const taskIds: number[] = []
  let skipped = 0
  for (const a of authors) {
    try {
      const r = createTaskChecked(db, crawlRequest(a, 'new', opts.count, true), enqueue)
      if (r.id !== null && !r.skipped) taskIds.push(r.id)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { authors: authors.length, created: taskIds.length, skipped, taskIds }
}

/** 通知里怎么称呼这个任务：「抖音 · 「猫咪」」「抖音 · 某作者」「抖音 · #美食」 */
export function taskLabel(db: DatabaseSync, taskId: number): string {
  const t = db.prepare('SELECT platform, type, query FROM tasks WHERE id = ?').get(taskId) as { platform: string; type: string; query: string } | undefined
  if (!t) return '任务'
  const site = getAdapter(t.platform)?.displayName ?? t.platform
  if (t.type === 'author') {
    const a = db.prepare('SELECT nickname FROM authors WHERE platform = ? AND sec_uid = ?').get(t.platform, t.query) as { nickname: string } | undefined
    return `${site} · ${a?.nickname || '作者主页'}`
  }
  return t.type === 'hashtag' ? `${site} · #${t.query}` : `${site} · 「${t.query}」`
}

export function platformNameOf(db: DatabaseSync, taskId: number): string {
  const t = db.prepare('SELECT platform FROM tasks WHERE id = ?').get(taskId) as { platform: string } | undefined
  return t ? getAdapter(t.platform)?.displayName ?? t.platform : '平台'
}

export interface Notice { title: string; body: string }
type TaskEvent = { type: string; taskId?: number; fetched?: number; reason?: string; status?: string }

/** 任务事件 → 系统通知；自己点的暂停、进度之类不通知 */
export function noticeForEvent(evt: TaskEvent, info: { label: string; platformName: string }): Notice | null {
  if (evt.type === 'task:done') return { title: '抓完了', body: `${info.label}：抓到 ${evt.fetched ?? 0} 条` }
  if (evt.type !== 'task:paused') return null
  switch (evt.reason) {
    case 'login_required': return { title: '需要登录', body: `${info.platformName}没登录，登录后在任务列表点「继续」` }
    case 'stalled_verify': return { title: '需要验证', body: `${info.platformName}要过验证码，验证完点「继续」` }
    case 'risk': return { title: '平台限流了', body: `${info.label} 已暂停，过一阵再点「继续」` }
    case 'stalled': return { title: '任务卡住了', body: `${info.label} 爬不动了，已暂停` }
    case 'scheduler_error': return { title: '任务出错了', body: `${info.label} 已暂停，可以在任务列表点「继续」重试` }
    default: return null
  }
}

/** 同一条通知 10 分钟内只弹一次（比如没登录时排队的任务一个接一个暂停） */
export class Notifier {
  private sent = new Map<string, number>()
  constructor(private deps: { show: (n: Notice) => void; now?: () => number; windowMs?: number }) {}
  notify(n: Notice): void {
    const now = (this.deps.now ?? Date.now)()
    const key = `${n.title}\n${n.body}`
    const last = this.sent.get(key)
    if (last !== undefined && now - last < (this.deps.windowMs ?? 10 * 60 * 1000)) return
    this.sent.set(key, now)
    this.deps.show(n)
  }
}

/** 定时追更建的那批任务：各自抓完不单独弹，全部结束后弹一条汇总 */
export class FollowTracker {
  private pending = new Set<number>()
  private total = 0
  private fetched = 0
  private unfinished = 0

  start(ids: number[]): void {
    this.pending = new Set(ids)
    this.total = ids.length
    this.fetched = 0
    this.unfinished = 0
  }

  owns(taskId: number | undefined): boolean {
    return taskId !== undefined && this.pending.has(taskId)
  }

  onEvent(evt: TaskEvent): Notice | null {
    if (!this.owns(evt.taskId)) return null
    if (evt.type === 'task:done') this.fetched += evt.fetched ?? 0
    else if (evt.type === 'task:paused') this.unfinished++
    else return null
    this.pending.delete(evt.taskId!)
    if (this.pending.size > 0) return null
    const tail = this.unfinished ? `；${this.unfinished} 个没跑完，去任务列表看看` : ''
    return { title: '定时追更完成', body: `追了 ${this.total} 个作者，新抓到 ${this.fetched} 条${tail}` }
  }
}

/** 每分钟看一眼该不该追更；跑之前先记下时间，跑出错也不会一分钟后又跑 */
export class AutoFollowTimer {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  constructor(private deps: {
    getSchedule: () => Schedule
    getLastRun: () => string | null
    setLastRun: (iso: string) => void
    run: () => Promise<void>
    now?: () => Date
  }) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    void this.tick() // 开机就看一次：错过的点补跑
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.busy) return
    const now = (this.deps.now ?? (() => new Date()))()
    if (!shouldRunFollow(now, this.deps.getSchedule(), this.deps.getLastRun())) return
    this.busy = true
    try {
      this.deps.setLastRun(now.toISOString())
      await this.deps.run()
    } catch (e) {
      console.error('[定时追更] 出错：', e)
    } finally {
      this.busy = false
    }
  }
}
