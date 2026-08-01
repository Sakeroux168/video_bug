import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { rename } from 'fs/promises'
import { join, dirname, basename } from 'path'
import type { PlatformAdapter } from './adapters/types'
import type { TaskRow, TaskStatus, Filters, VideoRow } from '../shared/types'
import { ERROR } from '../shared/types'
import { filterVideos, dedupeVideos, extractCategory } from './extractor'
import { isRiskSignal } from './errors'
import { upsertAuthor } from './db'
import { ensureUniqueName } from './filename'
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
  private silentRounds = 0
  private rawSinceLastRound = false
  private aiEnabled = false
  private organizeEnabled = false
  private organizeTaskId = 0
  private pendingVideoIds: number[] = []
  private running = false
  private task: TaskRow | null = null

  /** 供主进程任务队列判断当前是否有任务在跑（避免重复入队/串行丢任务） */
  get isRunning(): boolean { return this.running }

  constructor(private deps: SchedulerDeps) {
    // 只订阅一次下载器事件；video 完成/失败后从 pendingVideoIds 移除，避免下载堆积放慢永久生效
    this.deps.downloader.onEvent(e => {
      if (e.type === 'video:status') {
        if (e.status === 'done' || e.status === 'failed') {
          const i = this.pendingVideoIds.indexOf(e.id)
          if (i >= 0) this.pendingVideoIds.splice(i, 1)
        }
        // I7 下载后整理：视频 done 且任务开启 AI 整理时分类归档 + 打标签；AI 未配置/失败静默跳过
        if (e.status === 'done' && this.organizeEnabled && this.deps.analyzer) {
          void this.organizeVideo(e.id)
        }
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
      this.task = task
      this.adapter = adapter
      this.filters = JSON.parse(task.filters) as Filters
      this.seen = new Set<string>((db.prepare('SELECT aweme_id FROM videos WHERE platform=?').all(task.platform) as Array<{ aweme_id: string }>).map(r => r.aweme_id))
      this.fetched = task.fetched_count
      this.emptyRounds = 0
      this.silentRounds = 0
      this.rawSinceLastRound = false
      this.pendingVideoIds = []
      this.aiEnabled = !!(this.deps.analyzer) && !!this.filters.aiFilterEnabled
      this.organizeEnabled = !!this.filters.aiOrganizeEnabled
      this.organizeTaskId = taskId

      db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)

      const url = task.type === 'author'
        ? adapter.buildAuthorUrl(task.query)
        : task.type === 'hashtag'
          ? adapter.buildHashtagUrl(task.query)
          : adapter.buildSearchUrl(task.query, this.filters)
      await this.deps.browser.load(adapter, url)
      // 首轮不计静默，避免加载后立即以 0 抓取误停
      this.rawSinceLastRound = true

      const target = this.filters.targetCount ?? 200
      let stopReason: 'reached' | 'stalled' | null = null
      while (!this.aborted) {
        await sleep(this.deps.scrollIntervalMs + Math.random() * 1500)
        await this.deps.browser.scrollToBottom()
        // 按轮次计静默：本轮收到 raw 则重置，否则累加；与空解析轮合并判断停止
        if (this.rawSinceLastRound) this.silentRounds = 0
        else this.silentRounds++
        this.rawSinceLastRound = false
        const decision = buildStopDecision(this.fetched, target, this.emptyRounds + this.silentRounds)
        if (decision === 'reached') { stopReason = 'reached'; break }
        if (decision === 'stop') { stopReason = 'stalled'; break }
        if (this.pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await sleep(2000) }
      }

      if (this.aborted) {
        db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: '用户暂停或风控' })
      } else if (stopReason === 'stalled' && this.fetched < target) {
        // 未达目标却停滞：多半触发验证/风控（滑块/验证码），自动暂停，等用户到内置浏览器过验证后点继续
        db.prepare("UPDATE tasks SET status='paused', error='stalled_verify' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: 'stalled_verify' })
      } else {
        db.prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId)
        this.deps.emit({ type: 'task:done', taskId, fetched: this.fetched })
      }
    } catch {
      this.fail(taskId, 'network')
      this.deps.emit({ type: 'task:paused', taskId, reason: 'scheduler_error' })
    } finally {
      this.running = false
      // I5 清理残留任务上下文：handleRaw 的 taskId===0 守卫会拒绝任务结束后的任何流量，
      // 避免浏览流量污染已完成任务。organizeEnabled/TaskId 保留供迟到的下载完成继续整理。
      this.taskId = 0
      this.task = null
      this.adapter = null
      this.filters = null
      this.pendingVideoIds = []
    }
  }

  /** 只处理当前任务类型对应的接口响应，避免把推荐页/自己主页等无关 feed 当结果爬进来（用户反馈爬到了不该爬的内容）。
   *  匹配放宽：搜索接口路径多变（/search/item/、/general/search/ 等），用宽松的 /search/ 判断；
   *  推荐feed(/tab/feed/ 等)与个人主页(/user/profile/ 或 /aweme/post/ 之外的)不会含 /search/。 */
  private matchesTaskEndpoint(rawUrl: string): boolean {
    if (!this.task) return false
    switch (this.task.type) {
      case 'keyword': return /\/search\//.test(rawUrl) // 关键词搜索（宽匹配）
      case 'author': return /\/aweme\/post\//.test(rawUrl) // 作者主页视频列表
      case 'hashtag': return /\/challenge\//.test(rawUrl) || /\/search\//.test(rawUrl)
      default: return false
    }
  }

  /** 主进程从 ipcMain 'dy:raw' 调用来处理一个原始 JSON（任务期间持续被调用）。browser.onRaw 方法不存在，消息统一走这里。 */
  async handleRaw(adapter: PlatformAdapter, rawUrl: string, json: unknown): Promise<void> {
    if (this.taskId === 0 || this.adapter !== adapter) return
    if (!adapter.apiUrlPatterns.some(r => r.test(rawUrl))) return
    if (!this.matchesTaskEndpoint(rawUrl)) return
    this.rawSinceLastRound = true
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
      // #4 关键词任务：品类直接用搜索词（如搜"农村搞笑"→品类"农村搞笑"）；其它类型用视频第一个 #话题
      const category = this.task?.type === 'keyword' && this.task.query
        ? this.task.query.slice(0, 20)
        : extractCategory(item.title)
      const author = upsertAuthor(db, item, adapter.name, category)
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

  /** I7 下载后整理：AI 分类 → 打标签 → 文件移入 {downloadDir}/{category}/ 并更新 local_path */
  private async organizeVideo(id: number): Promise<void> {
    const db = this.deps.db
    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined
    if (!row || row.task_id !== this.organizeTaskId || !row.local_path) return
    const task = db.prepare('SELECT filters FROM tasks WHERE id = ?').get(row.task_id) as { filters: string } | undefined
    if (!task) return
    const filters = JSON.parse(task.filters) as Filters
    if (!filters.aiOrganizeEnabled || !this.deps.analyzer) return
    const author = row.author_id
      ? (db.prepare('SELECT nickname FROM authors WHERE id = ?').get(row.author_id) as { nickname: string } | undefined)?.nickname ?? ''
      : ''
    const text = `${row.title}\n作者:${author}\n时长:${row.duration}s`
    try {
      const result = await this.deps.analyzer.classify(text, `${row.platform}:${row.aweme_id}:organize`)
      const category = sanitizeCategory(result.category)
      const src = row.local_path
      const destDir = join(dirname(src), category)
      mkdirSync(destDir, { recursive: true })
      const finalName = ensureUniqueName(destDir, basename(src))
      const dest = join(destDir, finalName)
      await rename(src, dest)
      db.prepare('UPDATE videos SET ai_tags=?, local_path=? WHERE id=?').run(JSON.stringify(result), dest, id)
    } catch { /* AI 失败/未配置/文件缺失 → 静默跳过整理，不影响下载 */ }
  }

  private fail(taskId: number, code: string): void {
    this.deps.db.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?").run(code, taskId)
  }
}

/** 分类名清洗为合法目录名（Windows 非法字符替换，限长，空则回落"未分类"） */
function sanitizeCategory(category: string): string {
  const cleaned = category.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 32)
  return cleaned || '未分类'
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
