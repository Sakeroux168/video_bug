import type { DatabaseSync } from 'node:sqlite'
import type { PlatformAdapter } from './adapters/types'
import type { AppSettings, TaskRow, TaskStatus, Filters } from '../shared/types'
import { ERROR } from '../shared/types'
import { filterVideos, dedupeVideos, extractCategory } from './extractor'
import { isRiskSignal } from './errors'
import { upsertAuthor } from './db'
import type { Analyzer } from './analyzer'
import type { Downloader } from './downloader'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { getAdapter } from './adapters'
import { FILTER_SELECTORS } from './adapters/douyin'

/** R11：遗留的空轮数停滞判定（保留导出与测试；调度循环已改用秒数制停滞检测，不再依赖空轮数） */
export function buildStopDecision(fetched: number, target: number, emptyRounds: number): 'continue' | 'reached' | 'stop' {
  if (fetched >= target) return 'reached'
  if (emptyRounds >= 5) return 'stop'
  return 'continue'
}

export type SchedulerEvent =
  | { type: 'task:progress'; taskId: number; fetched: number; status: TaskStatus; reSearchCount?: number }
  | { type: 'task:done'; taskId: number; fetched: number }
  | { type: 'task:paused'; taskId: number; reason: string }
  | { type: 'task:notice'; text: string }

interface SchedulerDeps {
  db: DatabaseSync
  browser: VideoBrowser
  analyzer: Analyzer | null
  downloader: Downloader
  emit: (e: SchedulerEvent) => void
  scrollIntervalMs: number
  /** T2：每次 run 现读滚动参数（设置保存即生效，无需重启） */
  getScrollParams: () => Pick<AppSettings, 'scrollSpeed' | 'scrollPageWaitMs'>
  /** R11：停滞判定阈值秒数（每次 run 现读，不构造时缓存；Date.now()-lastFetchedAt > 秒数*1000 即判爬不动） */
  getStallThresholdSec: () => number
  /** Task5：按作者整理器（可选；未注入则下载完成不触发整理） */
  organizer?: Organizer | null
  /** Task5：下载完成→按作者归档去抖毫秒；<=0 表示立即归档 */
  organizeDebounceMs?: number
  /** 筛选续爬全链路日志回调（触发决策/browser CDP 步骤），主进程汇入界面「查看拦截日志」面板 */
  onFilterLog?: (msg: string) => void
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
  /** T2：当前任务的每页最大等待毫秒（每次 run 从设置现读） */
  private scrollWaitMs = 8000
  /** T3：本任务是否已应用过抖音筛选续爬（只应用一次，无论成败） */
  private filterApplied = false
  /** T4：最近一次有新视频入库的时刻（handleRaw fetched++ 时更新）；停滞判定用它算"X 秒无新视频" */
  private lastFetchedAt = 0
  /** R11：本任务已自动重搜关键词的次数（每次 run 重置；>=3 后不再重搜，直接暂停） */
  private reSearchCount = 0
  /** R11：非到底停滞的连续轮数（连续 2 轮才重搜，防页面加载慢误判；到底时立即重搜） */
  private stuckRounds = 0
  /** R11：当前任务初始 URL（run 开头计算，重搜时复用——关键词=搜索页/作者=主页/话题=话题页） */
  private taskUrl = ''
  private aiEnabled = false
  private autoDownload = true
  private pendingVideoIds: number[] = []
  private running = false
  private task: TaskRow | null = null
  /** Task5：下载完成→按作者归档的去抖计时器句柄 */
  private organizeTimer: ReturnType<typeof setTimeout> | null = null
  /** A1：当前 sleep 的中断回调；stop()/pause() 调用它以即时唤醒，让 run 尽快检查 aborted */
  private abortWait: (() => void) | null = null
  /** A1：当前 run 的退出信号；pause() 等它确认 run 完全退出（run 的 finally 里 resolve） */
  private runExit: Promise<void> | null = null
  private runExitResolve: (() => void) | null = null

  /** 供主进程任务队列判断当前是否有任务在跑（避免重复入队/串行丢任务） */
  get isRunning(): boolean { return this.running }

  constructor(private deps: SchedulerDeps) {
    // 只订阅一次下载器事件；video 完成/失败后从 pendingVideoIds 移除，避免下载堆积放慢永久生效
    this.deps.downloader.onEvent(e => {
      if (e.type !== 'video:status') return
      if (e.status === 'done' || e.status === 'failed') {
        const i = this.pendingVideoIds.indexOf(e.id)
        if (i >= 0) this.pendingVideoIds.splice(i, 1)
      }
      // 下载后整理（按作者）：视频 done → 标记作者 pending + 去抖归档（总是自动，不再依赖任务 aiOrganizeEnabled 勾选）
      if (e.status === 'done') this.scheduleAuthorOrganize(e.id)
    })
  }

  /** Task14：设置保存后重建整理器（downloadDir / resolveCategory 热更新，如 asr 模型就绪状态变化） */
  updateOrganizer(o: Organizer | null): void {
    this.deps.organizer = o
  }

  stop(): void {
    this.aborted = true
    this.abortWait?.() // 即时唤醒当前 sleep，不等它自然结束
    this.clearOrganizeTimer()
  }
  /** A1：暂停——置 aborted + 即时唤醒当前 sleep + 通知页面滚动脚本立即中止（不等 scrollToBottom 跑完）
   *  + 等 run() 完全退出后才返回（跑完收尾，避免状态/上下文竞态） */
  async pause(): Promise<void> {
    this.aborted = true
    this.abortWait?.()
    this.deps.browser.abortScroll?.() // 页面级中止信号：滚动脚本下个检查点即退出，1 秒内停止滚动
    const exit = this.runExit
    if (exit) await exit
  }
  /** A1：继续任务。若上一轮 run 正因暂停退出，先等它完全退出再重跑，避免被 running 挡回 */
  async resume(taskId: number): Promise<void> {
    if (this.aborted && this.running && this.runExit) await this.runExit
    await this.run(taskId)
  }

  async run(taskId: number): Promise<void> {
    if (this.running) return
    this.aborted = false
    const db = this.deps.db
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) return
    const adapter = getAdapter(task.platform)
    if (!adapter) { this.fail(taskId, ERROR.PARSE_ERROR); return }

    this.running = true
    // A1：登记 run 退出信号（在首个 await 前同步建立），pause() 通过它等 run 完全退出
    this.runExit = new Promise<void>(resolve => { this.runExitResolve = resolve })
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
      this.filterApplied = false // 每次 run 重置：筛选续爬只应用一次，恢复任务后可再次尝试
      this.reSearchCount = 0 // R11：每次 run 重置重搜计数（恢复任务后可重新自救）
      this.stuckRounds = 0 // R11：每次 run 重置非到底停滞轮数
      this.lastFetchedAt = Date.now() // T4/R11：X 秒无新视频计时的起点
      this.pendingVideoIds = []
      this.aiEnabled = !!(this.deps.analyzer) && !!this.filters.aiFilterEnabled
      this.autoDownload = !!task.auto_download

      db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)

      // R11-2：任务一启动立即发首个进度事件（UI 马上显示"进行中"；否则排队任务要等第一轮
      // 抓到数据才从"等待"变"进行中"，用户看到长时间无反应）
      this.deps.emit({ type: 'task:progress', taskId, fetched: this.fetched, status: 'running' })

      const url = task.type === 'author'
        ? adapter.buildAuthorUrl(task.query)
        : task.type === 'hashtag'
          ? adapter.buildHashtagUrl(task.query)
          : adapter.buildSearchUrl(task.query, this.filters)
      this.taskUrl = url // R11：重搜时复用（重新加载任务首屏，结果集重置；seen 去重保证只收新条目）
      await this.deps.browser.load(adapter, url)
      // 首轮不计静默，避免加载后立即以 0 抓取误停
      this.rawSinceLastRound = true

      const target = this.filters.targetCount ?? 200
      // T2：滚动参数每次 run 现读（设置保存即生效）；scrollSpeed 提供默认（慢8s/中5s/快3s），数字微调优先
      const p = this.deps.getScrollParams()
      const speedDefault = { slow: 8000, medium: 5000, fast: 3000 }[p.scrollSpeed] ?? 8000
      this.scrollWaitMs = p.scrollPageWaitMs > 0 ? p.scrollPageWaitMs : speedDefault
      let stopReason: 'reached' | 'stalled' | null = null
      // R11：停滞阈值秒数每次 run 现读（设置保存即生效，不构造时缓存）
      const stallSec = this.deps.getStallThresholdSec() ?? 5
      // T3/T4：轮次计数器（触发检查点日志标注第几轮用）
      let roundCount = 0
      while (!this.aborted) {
        await this.sleep(this.deps.scrollIntervalMs + Math.random() * 1500)
        // A1：暂停时不跑滚动（滚动是长任务且不可中断，提前检查避免多滚一轮）
        if (this.aborted) break
        await this.deps.browser.scrollToBottom({ waitMs: this.scrollWaitMs })
        // 暂停即时：pause 可能落在 scrollToBottom 内（abortWait 为 null，收尾 sleep 无人唤醒）——
        // 滚动被 abortScroll 中断返回后立即检查 aborted，跳过收尾 sleep 直接进 finally（~1 秒内进暂停态）
        if (this.aborted) break
        // R11-2：爬满即停——handleRaw 已通过 abortScroll 中断在途滚动，返回后立即收尾，
        // 不再经过收尾 sleep 白等一轮（此前整轮滚动+收尾 sleep 后才检查 reached，完成要拖 ~15-20s）
        if (this.fetched >= target) { stopReason = 'reached'; break }
        // 放慢节奏：滚动后多等一拍让当页结果加载完再进下一轮（默认约1.5s，随每页等待时长缩放；测试环境按间隔缩放保持快速）
        await this.sleep(Math.min(1500, this.scrollWaitMs / 4, this.deps.scrollIntervalMs * 2))
        // 按轮次计静默：本轮收到 raw 则重置，否则累加；与空解析轮合并判断停止
        if (this.rawSinceLastRound) this.silentRounds = 0
        else this.silentRounds++
        this.rawSinceLastRound = false

        // R11：停滞自救检查点（每轮）——停滞判定改秒数制：Date.now()-lastFetchedAt > 阈值即"爬不动"，
        // 不再依赖空轮数（emptyRounds/silentRounds 仅作日志）。停滞时按 筛选→重搜→暂停 自救：
        //  ① 到底 + 启用筛选 + 本任务未筛过（keyword）→ 应用抖音筛选（每任务一次；失败降级到重搜）
        //  ② 未启用筛选续爬 → 无自救策略，直接暂停（不再无限"进行中"；用户没开这个功能就不自救）
        //  ③ 非到底 → 连续 2 轮停滞才重搜（防页面加载慢误判，第一轮先继续观察；到底时立即）
        //  ④ 重搜（≤3 次）→ 重新加载任务首屏 URL；seen 去重保证只收新条目
        //  ⑤ 重搜超限 → 暂停 + notice 提示调整关键词或筛选条件
        roundCount++
        const df = this.filters?.douyinFilter
        const log = (msg: string): void => { this.deps.onFilterLog?.(msg) }
        const elapsed = Date.now() - this.lastFetchedAt
        const stalled = elapsed > stallSec * 1000
        log(`停滞检测（第${roundCount}轮）：${(elapsed / 1000).toFixed(1)} 秒无新视频（阈值 ${stallSec} 秒）→ ${stalled ? '已停滞' : '未停滞'}（空轮=${this.emptyRounds} 静默轮=${this.silentRounds}）`)
        if (this.fetched >= target) { stopReason = 'reached'; break }
        if (!stalled) {
          this.stuckRounds = 0
        } else {
          const bottomText = await this.deps.browser.findBottomText().catch(() => null)
          log(bottomText !== null ? `到底文案命中：「${bottomText}」` : '未找到到底文案（findBottomText 返回 null）')
          const atBottom = bottomText !== null

          // ① 到底 + 启用 + 未筛过（keyword 才有筛选面板）→ 应用抖音筛选（每任务只一次）
          if (atBottom && df?.enabled && this.task?.type === 'keyword' && !this.filterApplied) {
            log('条件满足，开始执行筛选流程')
            let applied = false
            let errMsg: string | null = null
            let busy = false
            try {
              applied = await this.deps.browser.applyDouyinFilter(FILTER_SELECTORS, df, log)
            } catch (err) {
              const code = (err as { code?: string } | null)?.code
              if (code === 'FILTER_BUSY') {
                // 并发拒绝（如手动测试在跑）：不算失败——不消耗 filterApplied、不停止，下一轮再试
                busy = true
                log('筛选流程进行中（可能是手动测试在跑），本次跳过：不消耗 filterApplied、不停止，下一轮重试')
              } else {
                errMsg = err instanceof Error ? err.message : String(err)
              }
            }
            if (busy) continue
            this.filterApplied = true // 只应用一次：无论成败都不再重试
            log(`执行结果：${applied ? '成功' : '失败'}${errMsg ? `（异常：${errMsg}）` : ''}`)
            if (applied) {
              // 筛选已生效：重置停滞计数继续抓（去重靠 seen 自然跳过已爬过的，只收新内容）
              this.emptyRounds = 0
              this.silentRounds = 0
              this.stuckRounds = 0
              this.lastFetchedAt = Date.now()
              log('筛选已生效：重置停滞计数（空轮/静默轮归 0），继续抓取')
              continue
            }
            // 失败也降级到重搜：别一失败就停，给重搜兜底（重搜也超限时 ⑤ 再停）
            log('筛选未生效：降级到重新搜索关键词（给重搜兜底）')
            this.deps.emit({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），将自动重新搜索关键词' })
          }

          // ② 未启用筛选续爬 → 无自救策略：直接暂停，不重搜
          if (!df?.enabled) {
            log('未启用筛选续爬：爬不动直接自动暂停（用户未开自救功能，不重搜）')
            this.deps.emit({ type: 'task:notice', text: '爬取停滞已自动暂停' })
            stopReason = 'stalled'
            break
          }

          // ③ 非到底：连续 2 轮停滞才重搜（第一轮先继续观察，防页面加载慢误判）
          if (!atBottom) {
            this.stuckRounds++
            if (this.stuckRounds < 2) {
              log(`非到底停滞第 ${this.stuckRounds} 轮：先继续观察一轮（防页面加载慢误判）`)
              continue
            }
          }

          // ④ 重搜（≤3 次）：重新加载任务首屏 URL（关键词=搜索页/作者=主页/话题=话题页）
          if (this.reSearchCount < 3) {
            this.reSearchCount++
            log(`第 ${this.reSearchCount} 次重搜：${this.task?.query ?? ''}（${this.taskUrl}）`)
            this.deps.emit({ type: 'task:notice', text: `已自动重新搜索关键词（第 ${this.reSearchCount} 次）` })
            this.deps.emit({ type: 'task:progress', taskId: this.taskId, fetched: this.fetched, status: 'running', reSearchCount: this.reSearchCount })
            await this.deps.browser.load(adapter, this.taskUrl)
            // 重置停滞计数继续爬：lastFetchedAt 从加载完成起算；seen 去重保证只收新条目
            this.lastFetchedAt = Date.now()
            this.emptyRounds = 0
            this.silentRounds = 0
            this.stuckRounds = 0
            this.rawSinceLastRound = true // 重搜后首轮不计静默（新页面加载需要时间）
            continue
          }

          // ⑤ 重搜超限：暂停（提示用户调整关键词或筛选条件）
          log('已重搜 3 次仍爬不满：自动暂停（请调整关键词或筛选条件）')
          this.deps.emit({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词或筛选条件' })
          stopReason = 'stalled'
          break
        }
        if (this.pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await this.sleep(2000) }
      }

      if (this.aborted) {
        db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: '用户暂停或风控' })
      } else if (stopReason === 'stalled' && this.fetched < target) {
        // R11：无自救策略可用 / 重搜超限 → 真正暂停（不再无限"进行中"）。reason=stalled 走普通 paused
        // 分支（不强制浏览器全屏——那是 stalled_verify 的行为）；用户点「继续」即恢复，计数随 run 重置
        db.prepare("UPDATE tasks SET status='paused', error='stalled' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: 'stalled' })
      } else {
        db.prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId)
        this.deps.emit({ type: 'task:done', taskId, fetched: this.fetched })
        // I-1：任务以 done 结束时做一次最终归档 flush。小任务可能在去抖窗口内就结束，
        // 最后一批 video:done 设的 timer 会被 finally 的 clearOrganizeTimer 清掉 → 该批视频永不自动归档。
        // organizePending 只处理 organize_state='pending' 的作者，幂等；organizer 缺失时无副作用。
        void this.deps.organizer?.organizePending()
      }
    } catch {
      this.fail(taskId, 'network')
      this.deps.emit({ type: 'task:paused', taskId, reason: 'scheduler_error' })
    } finally {
      this.running = false
      // 清理去抖计时器：任务结束/暂停后不再延迟触发归档，避免任务切换后误归档
      this.clearOrganizeTimer()
      // I5 清理残留任务上下文：handleRaw 的 taskId===0 守卫会拒绝任务结束后的任何流量，
      // 避免浏览流量污染已完成任务。
      this.taskId = 0
      this.task = null
      this.adapter = null
      this.filters = null
      this.pendingVideoIds = []
      this.taskUrl = ''
      // A1：通知等 run 退出的 pause()，随后清空信号（下一次 run 会重新登记）
      const resolveExit = this.runExitResolve
      this.runExit = null
      this.runExitResolve = null
      resolveExit?.()
    }
  }

  /** A1：可中断 sleep：stop()/pause() 通过 abortWait 即时唤醒，让 run 尽快走到 aborted 检查 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => { this.abortWait = null; resolve() }, ms)
      this.abortWait = () => {
        clearTimeout(t)
        this.abortWait = null
        resolve()
      }
    })
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
  async handleRaw(adapter: PlatformAdapter, rawUrl: string, json: unknown): Promise<{ items: number; kept: number } | null> {
    if (this.taskId === 0 || this.adapter !== adapter) return null
    if (!adapter.apiUrlPatterns.some(r => r.test(rawUrl))) return null
    if (!this.matchesTaskEndpoint(rawUrl)) return null
    this.rawSinceLastRound = true
    const db = this.deps.db
    const filters = this.filters
    if (!filters) return null
    const items = adapter.parseApiJson(rawUrl, json)
    const kept = dedupeVideos(filterVideos(items, filters), this.seen)
    if (kept.length === 0) {
      this.emptyRounds++
      if (isRiskSignal(this.emptyRounds) && filters.timeRange !== 'all') {
        // 保守起见：连续空数据→风控，暂停任务（真实风控判定以"连续N轮无有效数据"为信号，不额外发探针请求）
        this.aborted = true
      }
      return { items: items.length, kept: 0 }
    }
    this.emptyRounds = 0

    // A2 硬截断：按当前 fetched 算还差多少，只处理这一批里的前 N 条；
    // AI 过滤掉的也计入 fetched（filtered 也算数），故 batch 已按当前 fetched 保守截断，
    // 插入前再判一次剩余，确保 fetched 恰好到 target 不超
    const target = filters.targetCount ?? 200
    const remaining = target - this.fetched
    const batch = remaining > 0 ? kept.slice(0, remaining) : []

    for (const item of batch) {
      // 批处理中途被暂停：break 走循环后的 fetched_count 持久化再返回，
      // 避免 resume 按旧 fetched 重算 remaining 导致总数越界（目标 200 收 201+）
      if (this.aborted) break
      // AI 过滤/入库可能已让 fetched 到顶（filtered 也计数），到顶即停不再插入
      if (this.fetched >= target) break
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
              this.lastFetchedAt = Date.now() // T4：有新视频入库，重置"15 秒无新视频"计时
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
      // Task5 下载方式：自动下载 → 入 pending 并交给下载器；手动 → 仅收集（collected），不进下载队列
      const status = this.autoDownload ? 'pending' : 'collected'
      const info = db.prepare(
        `INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,author_id,play_addr,duration,publish_time,stats,status,ai_verdict,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(adapter.name, this.taskId, item.awemeId, item.title, author.id, item.playUrl,
           item.durationSec, new Date(item.publishTime * 1000).toISOString(), JSON.stringify({ likes: item.likes }),
           status, 'pass', new Date().toISOString())
      if (info.changes > 0) {
        this.fetched++
        this.lastFetchedAt = Date.now() // T4：有新视频入库，重置"15 秒无新视频"计时
        if (!author.created) db.prepare('UPDATE authors SET video_count = video_count + 1 WHERE id = ?').run(author.id)
        if (this.autoDownload) {
          const vid = Number(info.lastInsertRowid)
          this.pendingVideoIds.push(vid)
          this.deps.downloader.enqueue(vid)
        }
      }
    }
    // R11-2：爬满 → 中断在途滚动（复用暂停信号：滚动脚本下个检查点即退，~450ms 内停；
    // 滚动未在跑时 send 无害——下次脚本开头会清标志），循环轮末立即进 reached，不再白等整轮
    if (this.fetched >= target) this.deps.browser.abortScroll?.()
    db.prepare('UPDATE tasks SET fetched_count=? WHERE id=?').run(this.fetched, this.taskId)
    // R11：progress 事件带重搜次数（渲染层展示「已自动重搜 N 次」）
    this.deps.emit({ type: 'task:progress', taskId: this.taskId, fetched: this.fetched, status: 'running', reSearchCount: this.reSearchCount })
    return { items: items.length, kept: kept.length }
  }

  /** 下载完成→按作者整理：查该视频所属作者 → 标记作者 pending 并安排去抖归档（总是自动；organizer 缺失时无副作用） */
  private scheduleAuthorOrganize(videoId: number): void {
    const db = this.deps.db
    const row = db.prepare('SELECT author_id FROM videos WHERE id = ?').get(videoId) as { author_id: number | null } | undefined
    if (!row || row.author_id === null) return
    const organizer = this.deps.organizer
    if (!organizer) return
    organizer.markAuthorPending(row.author_id)
    this.scheduleOrganizeFlush()
  }

  /** 去抖：连续多个视频 done 只触发一次归档；debounce<=0 立即调，否则 debounceMs 后调 */
  private scheduleOrganizeFlush(): void {
    this.clearOrganizeTimer()
    const organizer = this.deps.organizer
    if (!organizer) return
    const ms = this.deps.organizeDebounceMs ?? 0
    if (ms <= 0) {
      void organizer.organizePending()
      return
    }
    this.organizeTimer = setTimeout(() => {
      this.organizeTimer = null
      void organizer.organizePending()
    }, ms)
  }

  /** run 结束 / stop 时清理去抖计时器，避免任务切换后仍在后台触发归档 */
  private clearOrganizeTimer(): void {
    if (this.organizeTimer !== null) {
      clearTimeout(this.organizeTimer)
      this.organizeTimer = null
    }
  }

  private fail(taskId: number, code: string): void {
    this.deps.db.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?").run(code, taskId)
  }
}
