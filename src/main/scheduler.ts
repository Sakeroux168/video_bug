import type { DatabaseSync } from 'node:sqlite'
import type { PlatformAdapter } from './adapters/types'
import type { TaskRow, TaskStatus, Filters } from '../shared/types'
import { ERROR } from '../shared/types'
import { filterVideos, dedupeVideos } from './extractor'
import { isRiskSignal } from './errors'
import { upsertAuthor } from './db'
import type { Analyzer } from './analyzer'
import type { Downloader } from './downloader'
import type { VideoBrowser } from './browser'
import { getAdapter } from './adapters'

export function buildStopDecision(fetched: number, target: number, emptyRounds: number): 'continue' | 'reached' | 'stop' {
  if (fetched >= target) return 'reached'
  if (emptyRounds >= 5) return 'stop'
  return 'continue'
}

export type SchedulerEvent =
  | { type: 'task:progress'; taskId: number; fetched: number; status: TaskStatus }
  | { type: 'task:done'; taskId: number; fetched: number }
  | { type: 'task:paused'; taskId: number; reason: string }

interface SchedulerDeps {
  db: DatabaseSync
  browser: VideoBrowser
  analyzer: Analyzer | null
  downloader: Downloader
  emit: (e: SchedulerEvent) => void
  scrollIntervalMs: number
}

export class Scheduler {
  private aborted = false
  private taskId = 0
  private adapter: PlatformAdapter | null = null
  private filters: Filters | null = null
  private seen = new Set<string>()
  private fetched = 0
  private emptyRounds = 0
  private aiEnabled = false
  private pendingVideoIds: number[] = []
  private running = false
  private lastRawAt = 0

  constructor(private deps: SchedulerDeps) {
    // 只订阅一次下载器事件；video 完成/失败后从 pendingVideoIds 移除，避免下载堆积放慢永久生效
    this.deps.downloader.onEvent(e => {
      if (e.type === 'video:status' && (e.status === 'done' || e.status === 'failed')) {
        const i = this.pendingVideoIds.indexOf(e.id)
        if (i >= 0) this.pendingVideoIds.splice(i, 1)
      }
    })
  }

  stop(): void { this.aborted = true }
  pause(): void { this.aborted = true }
  async resume(taskId: number): Promise<void> { await this.run(taskId) }

  async run(taskId: number): Promise<void> {
    if (this.running) return
    this.aborted = false
    const db = this.deps.db
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) return
    const adapter = getAdapter(task.platform)
    if (!adapter) { this.fail(taskId, ERROR.PARSE_ERROR); return }

    this.running = true
    try {
      this.taskId = taskId
      this.adapter = adapter
      this.filters = JSON.parse(task.filters) as Filters
      this.seen = new Set<string>((db.prepare('SELECT aweme_id FROM videos WHERE platform=?').all(task.platform) as Array<{ aweme_id: string }>).map(r => r.aweme_id))
      this.fetched = task.fetched_count
      this.emptyRounds = 0
      this.pendingVideoIds = []
      this.aiEnabled = !!(this.deps.analyzer) && !!this.filters.aiFilterEnabled

      db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)

      const url = task.type === 'author'
        ? adapter.buildAuthorUrl(task.query)
        : task.type === 'hashtag'
          ? adapter.buildHashtagUrl(task.query)
          : adapter.buildSearchUrl(task.query, this.filters)
      await this.deps.browser.load(adapter, url)
      this.lastRawAt = Date.now()

      const target = this.filters.targetCount ?? 200
      while (!this.aborted) {
        // 页面静默（接口长时间无 raw 响应）时强制触发 stop，防止无限空转
        if (Date.now() - this.lastRawAt > this.deps.scrollIntervalMs * 5) this.emptyRounds = 5
        await sleep(this.deps.scrollIntervalMs + Math.random() * 1500)
        await this.deps.browser.scrollToBottom()
        const decision = buildStopDecision(this.fetched, target, this.emptyRounds)
        if (decision === 'reached' || decision === 'stop') break
        if (this.pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await sleep(2000) }
      }

      if (this.aborted) {
        db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: '用户暂停或风控' })
      } else {
        db.prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId)
        this.deps.emit({ type: 'task:done', taskId, fetched: this.fetched })
      }
    } catch {
      this.fail(taskId, 'network')
      this.deps.emit({ type: 'task:paused', taskId, reason: 'scheduler_error' })
    } finally {
      this.running = false
    }
  }

  /** 主进程从 ipcMain 'dy:raw' 调用来处理一个原始 JSON（任务期间持续被调用）。browser.onRaw 方法不存在，消息统一走这里。 */
  async handleRaw(adapter: PlatformAdapter, rawUrl: string, json: unknown): Promise<void> {
    if (this.taskId === 0 || this.adapter !== adapter) return
    if (!adapter.apiUrlPatterns.some(r => r.test(rawUrl))) return
    this.lastRawAt = Date.now()
    const db = this.deps.db
    const filters = this.filters
    if (!filters) return
    const items = adapter.parseApiJson(rawUrl, json)
    const kept = dedupeVideos(filterVideos(items, filters), this.seen)
    if (kept.length === 0) {
      this.emptyRounds++
      if (isRiskSignal(this.emptyRounds) && filters.timeRange !== 'all') {
        // 保守起见：连续空数据→风控，暂停任务（真实风控判定以"连续N轮无有效数据"为信号，不额外发探针请求）
        this.aborted = true
      }
      return
    }
    this.emptyRounds = 0

    for (const item of kept) {
      if (this.aborted) return
      if (this.aiEnabled && this.deps.analyzer) {
        try {
          const text = `${item.title}\n作者:${item.authorNickname}\n时长:${item.durationSec}s`
          const v = await this.deps.analyzer.judgeFilter(text, filters.aiFilterRule ?? '', `${item.awemeId}:filter`)
          if (!v.pass) {
            const insertedId = db.prepare(
              "INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,play_addr,duration,publish_time,status,ai_verdict,fetched_at) VALUES (?,?,?,?,?,?,?,'filtered','filtered',?)"
            ).run(adapter.name, this.taskId, item.awemeId, item.title, item.playUrl, item.durationSec,
                 new Date(item.publishTime * 1000).toISOString(), new Date().toISOString())
            if (insertedId.changes > 0) {
              this.fetched++
              db.prepare('UPDATE tasks SET fetched_count=? WHERE id=?').run(this.fetched, this.taskId)
            }
            continue
          }
        } catch { /* AI 失败降级：视为通过 */ }
      }
      const author = upsertAuthor(db, item, adapter.name)
      const info = db.prepare(
        `INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,author_id,play_addr,duration,publish_time,stats,status,ai_verdict,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'pending','pass',?)`
      ).run(adapter.name, this.taskId, item.awemeId, item.title, author.id, item.playUrl,
           item.durationSec, new Date(item.publishTime * 1000).toISOString(), JSON.stringify({ likes: item.likes }),
           new Date().toISOString())
      if (info.changes > 0) {
        this.fetched++
        if (!author.created) db.prepare('UPDATE authors SET video_count = video_count + 1 WHERE id = ?').run(author.id)
        const vid = Number(info.lastInsertRowid)
        this.pendingVideoIds.push(vid)
        this.deps.downloader.enqueue(vid)
      }
    }
    db.prepare('UPDATE tasks SET fetched_count=? WHERE id=?').run(this.fetched, this.taskId)
    this.deps.emit({ type: 'task:progress', taskId: this.taskId, fetched: this.fetched, status: 'running' })
  }

  private fail(taskId: number, code: string): void {
    this.deps.db.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?").run(code, taskId)
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
