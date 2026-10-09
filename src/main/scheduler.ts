import type { DatabaseSync } from 'node:sqlite'
import type { PlatformAdapter, ListStub, VideoItem, FastDetailOutcome } from './adapters/types'
import type { AppSettings, TaskRow, TaskStatus, Filters } from '../shared/types'
import { ERROR, clampStuckTimeoutMin } from '../shared/types'
import { filterVideos, dedupeVideos, extractCategory, chinaDayStartSec, chinaDayEndSec, meetsThreshold } from './extractor'
import { isRiskSignal } from './errors'
import { upsertAuthor, setAuthorVerify, refreshSeenVideo, reclaimSeenVideo, inTransaction, statsJson } from './db'
import { looseNicknameMatch } from './nicknameMatch'
import type { Analyzer } from './analyzer'
import type { Downloader } from './downloader'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { getAdapter } from './adapters'
import { getSettings } from './settings'

/** Task4：滚动脚本单步延迟毫秒（与 browser.ts scrollToBottom 首轮单步 550ms 保持一致，仅用于估算停滞阈值动态下限） */
const SCROLL_STEP_MS = 550
/** Task4：滚动脚本首轮步数（browser.ts scrollToBottom round 0 循环 10 步，见 browser.ts:217） */
const SCROLL_FIRST_ROUND_STEPS = 10
/** Task4：停滞阈值动态下限缓冲秒数（覆盖调度/事件循环等误差，避免刚好卡在临界值） */
const STALL_MIN_BUFFER_SEC = 5
/** Task4：等待阶段随机抖动上限毫秒（与主循环 waitTotal 抖动、动态下限估算保持一致） */
const SCROLL_WAIT_JITTER_MS = 1500
/** R20：看门狗检查间隔毫秒（按「连续多少次检查都没进展」计时，不看墙上时钟——电脑睡眠/改时间不会误判） */
export const WATCHDOG_TICK_MS = 5000
/** R20：默认「多少分钟没任何进展就判卡住」（设置 stuckTimeoutMin 可改） */
export const DEFAULT_STUCK_MIN = 5
/** R20：卡住判定的下限毫秒——一轮正常滚动最长 60s、页面加载最长 30s，低于 2 分钟会误伤正常任务 */
const STUCK_FLOOR_MS = 2 * 60 * 1000
/** #7：小红书网页原生筛选（hover 展开面板再点选项）最多等多久 */
const NATIVE_FILTER_TIMEOUT_MS = 45 * 1000
/** R20：暂停 / 删除时最多等任务自己停下来的毫秒数；超过就强制停，不让按钮跟着卡住 */
export const PAUSE_WAIT_MS = 10000
/** 追更：两段式作者主页连续多少条早于起始日期就收尾（小红书最多置顶 3 条旧笔记，取 4） */
export const AUTHOR_RANGE_OLDER_STREAK = 4

/** R11：遗留的空轮数停滞判定（保留导出与测试；调度循环已改用秒数制停滞检测，不再依赖空轮数） */
export function buildStopDecision(fetched: number, target: number, emptyRounds: number): 'continue' | 'reached' | 'stop' {
  if (fetched >= target) return 'reached'
  if (emptyRounds >= 5) return 'stop'
  return 'continue'
}

/** R20 复查：接口响应自带的「后面没有了」标记（抖音作者主页 aweme/post 根上的 has_more=0/false）。
 *  没有这个字段的平台一律当「不知道」，不据此收尾。 */
function feedEnded(json: unknown): boolean {
  const hm = (json as { has_more?: unknown } | null)?.has_more
  return hm === 0 || hm === false
}

/** R20：等一个 Promise 最多 ms 毫秒；按时完成返回 true，超时返回 false（不抛错，计时器必清） */
/**
 * 性能检查 F6：定时器里发起的异步检查，上一次还没返回就跳过这次。
 * 页面慢的时候（满屏卡片、电脑配置差），每 2 秒一次的检测脚本会越积越多，把爬取页面拖得更慢。
 * 返回 true 表示这次真的跑了。
 */
export function skipIfBusy(fn: () => Promise<unknown>): () => boolean {
  let busy = false
  return () => {
    if (busy) return false
    busy = true
    void fn().catch(() => {}).finally(() => { busy = false })
    return true
  }
}

function raceTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms) })
  ]).finally(() => { if (timer !== null) clearTimeout(timer) })
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
  /** T2/Task4：每次 run 现读滚动参数（含 scrollIntervalMs；设置保存即生效，无需重启，不再在构造时缓存） */
  getScrollParams: () => Pick<AppSettings, 'scrollSpeed' | 'scrollPageWaitMs' | 'scrollIntervalMs'>
  /** R11：停滞判定阈值秒数（每次 run 现读，不构造时缓存；Date.now()-lastFetchedAt > 秒数*1000 即判爬不动） */
  getStallThresholdSec: () => number
  /** R20：卡住判定分钟数（看门狗：这么久没抓到新数据、页面也没滚动 → 强制停下并放行下一个任务）；不给 = 5 */
  getStuckTimeoutMin?: () => number
  /** R20：暂停/删除时等 run 自己退出的最长毫秒（测试可调小）；不给 = PAUSE_WAIT_MS */
  pauseWaitMs?: number
  detailTimeoutMs?: number
  /** Task5：按作者整理器（可选；未注入则下载完成不触发整理） */
  organizer?: Organizer | null
  /** Task5：下载完成→按作者归档去抖毫秒；<=0 表示立即归档 */
  organizeDebounceMs?: number
  /** R12：停滞自救全链路日志回调（停滞检测/到底命中/重搜冷却/重搜计数），主进程汇入界面「查看拦截日志」面板 */
  onFilterLog?: (msg: string) => void
}

export class Scheduler {
  private listStubs = new Map<string, ListStub>()
  private listEnded = false
  private phase: 'list' | 'detail' | null = null
  private pendingDetail: { noteId: string; finish: (item: VideoItem | null) => void } | null = null
  private abortDetail: (() => void) | null = null
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
  /** Task4：当前任务的滚动间隔毫秒（每次 run 从设置现读，设置保存不重启也生效；替代旧的构造期缓存） */
  private scrollIntervalMs = 0
  /** Task4：当前任务实际生效的停滞阈值秒数（= Math.max(用户设置, 动态下限)；供测试与日志读取） */
  private stallSec = 0
  /** T4：最近一次有新视频入库的时刻（handleRaw fetched++ 时更新）；停滞判定用它算"X 秒无新视频" */
  private lastFetchedAt = 0
  /** R11：本任务已自动重搜关键词的次数（每次 run 重置；>=3 后不再重搜，直接暂停） */
  private reSearchCount = 0
  /** R12：最近一次自动重搜的时刻（重搜冷却判定：距上次重搜 < 冷却秒数则跳过本轮；
   *  0=从未重搜（首轮不受冷却）；到底文案命中可忽略冷却立即重搜） */
  private lastRescueAt = 0
  /** R11：当前任务初始 URL（run 开头计算，重搜时复用——关键词=搜索页/作者=主页/话题=话题页） */
  private taskUrl = ''
  /** R11-3：秒级心跳计时器（run 启动 setInterval(1000)，finally 清理）：1s 粒度检测停滞，中断在途滚动 */
  private stallHeartbeat: ReturnType<typeof setInterval> | null = null
  /** R11-3：滚动进行中标志（scrollToBottom 前置位/返回后复位）；心跳据此决定是否 abortScroll */
  private scrolling = false
  /** R11-3：自救执行中标志（重搜期间置位，finally 复位）；心跳跳过避免并发重复触发 */
  private rescuing = false
  /** R11-4：心跳检测到的验证码文案（null=未检测到）；主循环检查点据此 break 走 stalled_verify 暂停 */
  private verifyFound: string | null = null
  /** 未登录文案（与验证码分开，避免错误提示用户去过验证）。 */
  private loginFound: string | null = null
  /** R11-4：心跳 tick 计数（每 2 tick=2s 查一次验证码） */
  private verifyTick = 0
  /** R18：作者主页按日期段（timeRange=custom）抓时，某一批接口数据**全部**比 startDate 老 → 主页已翻到日期段之前，
   *  后面只会更老，直接算抓完（done），不再继续滚 / 不当风控暂停。关键词/话题搜索结果不按时间排，不适用。 */
  private pastRange = false
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
  /** R20：第几次 run。看门狗/强制暂停会把它 +1，让卡在半路的旧 run 醒来后认出「我已经被接管了」，
   *  不再写库、不再发事件、不再动调度器状态（否则会把下一个任务的状态搅乱）。 */
  private runGen = 0
  /**
   * 只抓热门（N01）：抖音选了排序时为 true——只收按要求排过序的搜索结果（适配器 acceptsSortedResponse 判断），
   * 页面刚打开时按综合排序返回的那批丢掉。排序没点上就改回 false，照常抓。
   */
  private sortedOnly = false
  /** 只抓热门：这次 run 里因为点赞 / 收藏没达到门槛被跳过的作品（去重计数，任务结束时告诉用户） */
  private thresholdSkippedIds = new Set<string>()
  get thresholdSkipped(): number { return this.thresholdSkippedIds.size }
  /** R20：看门狗计时器（run 开始即启动，run 收尾/强制停止时清掉） */
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** R20：距上次「有进展」过了几次看门狗检查（抓到一批数据 / 滚完一轮 / 页面加载完都会清零） */
  private idleTicks = 0
  /** R20：作者主页按日期段抓、正在翻「比结束日期还新」的作品时只打一次日志 */
  private skippingNewerLogged = false
  /** R20 复查：作者主页按日期段抓时，本次页面里已经滚过的作品 id（不管留没留）。
   *  一批里有没见过的 id 才算「往下翻了」；同一批反复出现（游标卡住 / 软风控）不算进展，停滞检测照常起作用。
   *  重搜重新加载页面时清空。 */
  private scrolledIds = new Set<string>()
  /** R20 复查：作者任务要抓的 sec_uid（接口地址里带 sec_user_id 时据此认人，防止上一个任务的页面数据串进来） */
  private authorSecUid = ''
  /** R20 复查：本次 aborted 的原因——user=用户点暂停（含 10 秒没停下来被强制停），risk=连续空数据疑似风控。
   *  两种都会让队列按住不自动跑下一个（不连着撞风控 / 用户就是想停） */
  private abortReason: 'user' | 'risk' | null = null

  /** 供主进程任务队列判断当前是否有任务在跑（避免重复入队/串行丢任务） */
  get isRunning(): boolean { return this.running }
  /** 当前正在跑的任务 id；空闲为 0。删任务时要据此判断该不该叫停。 */
  get currentTaskId(): number { return this.taskId }

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
    this.abortDetail?.()
    this.abortWait?.() // 即时唤醒当前 sleep，不等它自然结束
    this.clearOrganizeTimer()
  }
  /** A1：暂停——置 aborted + 即时唤醒当前 sleep + 通知页面滚动脚本立即中止（不等 scrollToBottom 跑完）
   *  + 等 run() 完全退出后才返回（跑完收尾，避免状态/上下文竞态） */
  async pause(): Promise<void> {
    if (this.running && !this.aborted) this.abortReason = 'user'
    this.aborted = true
    this.abortDetail?.()
    this.abortWait?.()
    this.deps.browser.abortScroll?.() // 页面级中止信号：滚动脚本下个检查点即退出，1 秒内停止滚动
    const exit = this.runExit
    if (!exit) return
    // R20：最多等 10 秒。run 卡在页面调用里永远不退出时，以前「暂停」「删除」按钮会跟着一直转圈；
    // 现在等不到就强制停（状态写成暂停、放行队列），卡住的旧 run 醒来后什么都不会再动。
    const exited = await raceTimeout(exit, this.deps.pauseWaitMs ?? PAUSE_WAIT_MS)
    if (!exited) this.forceStop('user', 'user', '暂停：任务 10 秒内没停下来（多半卡在页面里），已强制停止')
  }
  /** A1：继续任务。若上一轮 run 正因暂停退出，先等它完全退出再重跑，避免被 running 挡回（R20：同样最多等 10 秒） */
  async resume(taskId: number): Promise<void> {
    if (this.aborted && this.running) await this.pause()
    await this.run(taskId)
  }

  /**
   * R20：强制停止当前任务——**不等**卡住的 run 退出（它可能永远不退出）。
   * 写库（paused + error）→ 叫停并刷新页面 → 清掉调度器的运行状态 → 发 task:paused（主进程据此放行下一个排队任务）。
   * runGen+1 让旧 run 醒来后认出自己已被接管，不再碰任何状态。
   */
  private forceStop(error: string, reason: string, logMsg: string): void {
    const taskId = this.taskId
    if (!this.running || taskId === 0) return
    this.runGen++
    this.aborted = true
    this.abortWait?.()
    this.deps.browser.abortScroll?.()
    try { this.deps.browser.resetPage?.() } catch { /* 页面坏了也要继续收尾 */ }
    this.deps.onFilterLog?.(logMsg)
    this.deps.db.prepare("UPDATE tasks SET status='paused', error=? WHERE id=?").run(error, taskId)
    this.cleanupRun()
    this.deps.emit({ type: 'task:paused', taskId, reason })
  }

  /** R20：有进展（抓到一批数据 / 滚完一轮 / 页面加载完）→ 看门狗清零 */
  private touch(): void { this.idleTicks = 0 }

  /** R20：看门狗——独立于调度循环的计时器。循环本身卡死时（页面调用不返回、自救卡住）心跳和循环都不会再动，
   *  只有它还能发现并把任务停下来，让后面排队的任务接着跑。 */
  private startWatchdog(gen: number): void {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    // R20 复查：空 / 0 / 1 / 超大值一律夹到 2-60 分钟（设置页保存时也会夹，这里防手改 settings.json）
    const raw = this.deps.getStuckTimeoutMin?.() ?? DEFAULT_STUCK_MIN
    const min = clampStuckTimeoutMin(raw)
    if (min !== raw) this.deps.onFilterLog?.(`卡住判定设置为「${String(raw)}」不在 2-60 分钟内，按 ${min} 分钟执行`)
    const interval = Number(this.deps.getScrollParams().scrollIntervalMs) || 0
    const stuckMs = Math.max(min * 60 * 1000, STUCK_FLOOR_MS + interval)
    this.idleTicks = 0
    this.watchdog = setInterval(() => {
      if (gen !== this.runGen || !this.running) return
      this.idleTicks++
      if (this.idleTicks * WATCHDOG_TICK_MS < stuckMs) return
      const minutes = Math.round(stuckMs / 60000)
      this.forceStop('stuck', 'stuck',
        `任务卡住了：${minutes} 分钟没有任何进展（没抓到新数据，页面也没在滚）→ 已停止并跳过，排队的下一个任务接着跑`)
      this.deps.emit({ type: 'task:notice', text: `有个任务卡住了（${minutes} 分钟没动静），已自动跳过，排队的任务接着跑；可在任务列表点「继续」重试` })
    }, WATCHDOG_TICK_MS)
  }

  /** run 收尾：清掉本次任务的全部运行状态（原 run 的 finally；R20 抽出来给强制停止共用） */
  private cleanupRun(): void {
    this.running = false
    this.abortDetail?.()
    this.pendingDetail = null
    this.phase = null
    this.listStubs.clear()
    this.listEnded = false
    this.loginFound = null
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
    this.pastRange = false
    // R11-3/4：清理心跳计时器与滚动/自救/验证码标志（任务结束/暂停后不再心跳）
    if (this.stallHeartbeat !== null) { clearInterval(this.stallHeartbeat); this.stallHeartbeat = null }
    if (this.watchdog !== null) { clearInterval(this.watchdog); this.watchdog = null }
    this.scrolling = false
    this.rescuing = false
    this.verifyFound = null
    this.verifyTick = 0
    // A1：通知等 run 退出的 pause()，随后清空信号（下一次 run 会重新登记）
    const resolveExit = this.runExitResolve
    this.runExit = null
    this.runExitResolve = null
    resolveExit?.()
  }

  async run(taskId: number): Promise<void> {
    if (this.running) return
    this.aborted = false
    const db = this.deps.db
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) return
    const adapter = getAdapter(task.platform)
    if (!adapter) {
      this.fail(taskId, ERROR.PARSE_ERROR)
      // R20：以前这里一个事件都不发，主进程不知道任务已经结束，后面排队的永远等着
      this.deps.emit({ type: 'task:paused', taskId, reason: 'scheduler_error' })
      return
    }
    if (adapter.supportedTaskTypes && !adapter.supportedTaskTypes.includes(task.type)) {
      this.fail(taskId, 'unsupported_task_type')
      this.deps.emit({ type: 'task:paused', taskId, reason: 'unsupported_task_type' })
      return
    }

    this.running = true
    // R20：本次 run 的代号；被看门狗/强制暂停接管后 runGen 会变，stopped() 随之为真
    const gen = ++this.runGen
    const stopped = (): boolean => this.aborted || gen !== this.runGen
    // A1：登记 run 退出信号（在首个 await 前同步建立），pause() 通过它等 run 完全退出
    this.runExit = new Promise<void>(resolve => { this.runExitResolve = resolve })
    try {
      this.taskId = taskId
      this.task = task
      this.adapter = adapter
      this.filters = JSON.parse(task.filters) as Filters
      const detailMethods = [adapter.parseListStubs, adapter.buildDetailUrl, adapter.isDetailResponse, adapter.parseDetail]
      if (detailMethods.some(Boolean) && !detailMethods.every(Boolean)) throw new Error('不完整的详情适配器')
      this.phase = adapter.parseListStubs ? 'list' : null
      this.listStubs.clear()
      this.listEnded = false
      // 见过的视频直接跳过（不重复入库、小红书也不再开详情页）。
      // 2026-10-09 任务勾了「以前下过的也重新下」：只跳过这个任务自己已经抓到的，以前别的任务抓过的照样要
      const seenSql = this.filters.redownload
        ? db.prepare('SELECT aweme_id FROM videos WHERE platform=? AND task_id=?').all(task.platform, taskId)
        : db.prepare('SELECT aweme_id FROM videos WHERE platform=?').all(task.platform)
      this.seen = new Set<string>((seenSql as Array<{ aweme_id: string }>).map(r => r.aweme_id))
      this.fetched = task.fetched_count
      this.emptyRounds = 0
      this.silentRounds = 0
      this.rawSinceLastRound = false
      this.reSearchCount = 0 // R11：每次 run 重置重搜计数（恢复任务后可重新自救）
      this.lastRescueAt = 0 // R12：每次 run 重置重搜冷却（恢复任务后可立即自救）
      this.verifyFound = null // R11-4：每次 run 重置验证码检测（resume 后重新检测）
      this.loginFound = null
      this.verifyTick = 0
      this.lastFetchedAt = Date.now() // T4/R11：X 秒无新视频计时的起点
      this.pastRange = false // R18：每次 run 重置
      this.thresholdSkippedIds = new Set<string>()
      this.skippingNewerLogged = false
      this.scrolledIds = new Set<string>()
      this.abortReason = null
      this.authorSecUid = task.type === 'author' ? (adapter.parseAuthorInput(task.query) ?? task.query) : ''
      this.pendingVideoIds = []
      this.aiEnabled = !!(this.deps.analyzer) && !!this.filters.aiFilterEnabled
      this.autoDownload = !!task.auto_download

      db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)

      // R11-2：任务一启动立即发首个进度事件（UI 马上显示"进行中"；否则排队任务要等第一轮
      // 抓到数据才从"等待"变"进行中"，用户看到长时间无反应）
      this.deps.emit({ type: 'task:progress', taskId, fetched: this.fetched, status: 'running' })
      // R20：看门狗从任务一开始就盯着（页面加载、作者校验也可能卡住）
      this.startWatchdog(gen)

      const url = task.type === 'author'
        // P1.5：防御性归一——库里可能有 query=完整 URL 的历史 pending 行（重启恢复会重新入队），
        // 不归一会拼出 buildAuthorUrl(完整URL) 的双重包裹 URL（无效页面→任务静默卡死）
        ? adapter.buildAuthorUrl(adapter.parseAuthorInput(task.query) ?? task.query)
        : task.type === 'hashtag'
          ? adapter.buildHashtagUrl(task.query)
          : adapter.buildSearchUrl(task.query, this.filters)
      this.taskUrl = url // R11：重搜时复用（重新加载任务首屏，结果集重置；seen 去重保证只收新条目）
      // N01：抖音这类「边滚边截接口」的平台，选了排序就先只收排过序的结果（小红书两段式另有自己的流程）
      this.sortedOnly = !adapter.parseListStubs && !!adapter.acceptsSortedResponse
        && (adapter.nativeSearchFilters?.(task.type, this.filters).length ?? 0) > 0
      await this.deps.browser.load(adapter, url)
      if (gen !== this.runGen) return // R20：加载期间被看门狗接管
      this.touch()

      // R16：导入作者的「名称强绑链接」校验。
      // 搭这次页面加载的车——不额外开页、不增加任何风控。
      // 只查导入进来的（verify_state 为 pending，或上次没通过的 failed）；抓取自动收录的作者数据来自真实接口，不必校验。
      if (task.type === 'author') {
        const stop = await this.verifyImportedAuthor(taskId, adapter.parseAuthorInput(task.query) ?? task.query, gen)
        if (stop) return
      }

      if (adapter.parseListStubs) {
        await this.prepareTwoStageList(adapter, task.type, stopped)
        if (stopped()) return
      } else if (this.sortedOnly) {
        await this.applyNativeSort(adapter, task.type, stopped)
        if (stopped()) return
      }

      // 首轮不计静默，避免加载后立即以 0 抓取误停
      this.rawSinceLastRound = true

      const target = this.filters.targetCount ?? 200
      // T2/Task4：滚动参数每次 run 现读（设置保存即生效，含 scrollIntervalMs）；scrollSpeed 提供默认（慢8s/中5s/快3s），数字微调优先
      const p = this.deps.getScrollParams()
      const speedDefault = { slow: 8000, medium: 5000, fast: 3000 }[p.scrollSpeed] ?? 8000
      this.scrollWaitMs = p.scrollPageWaitMs > 0 ? p.scrollPageWaitMs : speedDefault
      this.scrollIntervalMs = p.scrollIntervalMs
      let stopReason: 'reached' | 'stalled' | 'verify' | 'login' | null = null
      if (adapter.parseListStubs) {
        stopReason = await this.runListDetails(adapter, target, stopped)
      } else {
        // R11：停滞阈值秒数每次 run 现读（设置保存即生效，不构造时缓存）
        const userStallSec = this.deps.getStallThresholdSec() ?? 5
        // Task4：动态下限——一个正常周期至少需要「等待阶段（滚动间隔+抖动）+ 首轮滚动到首批数据回来」，
        // 阈值低于该周期会绞杀正常滚动（滚动刚起步就被心跳判停滞、abortScroll 掐断，抖音因未滚到底不触发懒加载，
        // 无新数据→重搜重载回顶部→死循环，真机验收实测复现）。不允许静默覆盖用户配置，抬高时必须打日志。
        const minStallSec = (this.scrollIntervalMs + SCROLL_WAIT_JITTER_MS) / 1000
          + (SCROLL_FIRST_ROUND_STEPS * SCROLL_STEP_MS) / 1000
          + STALL_MIN_BUFFER_SEC
        const stallSec = Math.max(userStallSec, minStallSec)
        this.stallSec = stallSec
        if (stallSec > userStallSec) {
          this.deps.onFilterLog?.(
            `停滞阈值：用户设 ${userStallSec} 秒 < 滚动周期需要 ${minStallSec.toFixed(1)} 秒 → 实际按 ${minStallSec.toFixed(1)} 秒执行`
          )
        }
        // R11-3/4：秒级心跳——①验证码识别每 2s 查一次（验证码随时可能弹，不只在停滞时；executeJavaScript
        // 开销可接受）；②停滞检测粒度从"一轮(~15-20s)"降到 1s：滚动中 → 中断在途滚动（~0.5s 返回）让主循环
        // 滚动返回后立即自救；等待中 → 心跳直接触发自救（与主循环同逻辑，rescuing 防重入、与主循环互斥）。
        const checkBlock = skipIfBusy(() => this.detectPageBlock().then(block => {
          if (block && !stopped() && this.scrolling) this.deps.browser.abortScroll?.() // 让滚动返回，主循环尽快 break
        }))
        this.stallHeartbeat = setInterval(() => {
          if (stopped()) return
          this.verifyTick++
          if (this.verifyTick % 2 === 0 && !this.verifyFound && !this.loginFound) checkBlock() // 上一次没查完就跳过（F6）
          if (this.rescuing) return
          if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
            if (this.scrolling) this.deps.browser.abortScroll?.()
            else if (this.adapter) void this.rescueStall(this.adapter, target, stallSec, gen)
          }
        }, 1000)
        // T3/T4：轮次计数器（触发检查点日志标注第几轮用）
        let roundCount = 0
        while (!stopped()) {
          // R11-3：心跳式等待——sleep 拆成 1s 小步（累计到滚动间隔才触发滚动，滚动频率不变）；
          // 每步检查停滞：命中即走自救（不等整轮结束）
          const waitTotal = this.scrollIntervalMs + Math.random() * SCROLL_WAIT_JITTER_MS
          let waited = 0
          while (!stopped() && waited < waitTotal) {
            const step = Math.min(1000, waitTotal - waited)
            await this.sleep(step)
            waited += step
            if (stopped()) break
            if (this.loginFound) { stopReason = 'login'; break }
            if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
            if (this.pastRange) { stopReason = 'reached'; break } // R18：已翻过日期段 → 抓完
            if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
              if (this.fetched >= target) { stopReason = 'reached'; break }
              const action = await this.rescueStall(adapter, target, stallSec, gen)
              if (stopped()) break
              if (action === 'paused') { stopReason = 'stalled'; break }
              if (action === 'login') { stopReason = 'login'; break }
              if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
              if (action === 'continue') waited = 0 // 重搜成功后重新起算等待，继续爬（skip=冷却中，继续当前等待）
            }
          }
          // A1：暂停时不跑滚动（滚动是长任务且不可中断，提前检查避免多滚一轮）
          if (stopped()) break
          if (stopReason) break
          // R11-3：滚动标志置位——心跳据此在停滞时中断在途滚动（~0.5s 返回）
          this.scrolling = true
          try {
            await this.deps.browser.scrollToBottom({ waitMs: this.scrollWaitMs })
          } finally {
            if (gen === this.runGen) this.scrolling = false
          }
          // 暂停即时：pause 可能落在 scrollToBottom 内（abortWait 为 null，收尾 sleep 无人唤醒）——
          // 滚动被 abortScroll 中断返回后立即检查 aborted，跳过收尾 sleep 直接进 finally（~1 秒内进暂停态）
          if (stopped()) break
          this.touch() // R20：滚完一轮 = 循环还活着
          if (this.loginFound) { stopReason = 'login'; break }
          if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
          // R11-2：爬满即停——handleRaw 已通过 abortScroll 中断在途滚动，返回后立即收尾，
          // 不再经过收尾 sleep 白等一轮（此前整轮滚动+收尾 sleep 后才检查 reached，完成要拖 ~15-20s）
          if (this.fetched >= target || this.pastRange) { stopReason = 'reached'; break }
          // R11-3：滚动返回后立即检查停滞——心跳已中断在途滚动（~0.5s），这里马上自救，不进整轮等待
          if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
            const action = await this.rescueStall(adapter, target, stallSec, gen)
            if (stopped()) break
            if (action === 'paused') { stopReason = 'stalled'; break }
            if (action === 'login') { stopReason = 'login'; break }
            if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
            if (action === 'continue') continue // 重搜成功：重新进入等待阶段（不再跑 settle/轮末检查）
          }
          // 放慢节奏：滚动后多等一拍让当页结果加载完再进下一轮（默认约1.5s，随每页等待时长缩放；测试环境按间隔缩放保持快速）
          await this.sleep(Math.min(1500, this.scrollWaitMs / 4, this.scrollIntervalMs * 2))
          if (stopped()) break // R20：收尾等待期间被暂停/接管
          // 按轮次计静默：本轮收到 raw 则重置，否则累加；与空解析轮合并判断停止
          if (this.rawSinceLastRound) this.silentRounds = 0
          else this.silentRounds++
          this.rawSinceLastRound = false

          // R11-2/3：轮末停滞检查点（兜底——等待阶段/滚动返回后均未命中时才到这里；正常轮记录日志）。
          // 停滞判定秒数制，不再依赖空轮数（emptyRounds/silentRounds 仅作日志）。
          roundCount++
          const log = (msg: string): void => { this.deps.onFilterLog?.(msg) }
          const elapsed = Date.now() - this.lastFetchedAt
          const stalled = elapsed > stallSec * 1000
          log(`停滞检测（第${roundCount}轮）：${(elapsed / 1000).toFixed(1)} 秒无新视频（阈值 ${stallSec} 秒）→ ${stalled ? '已停滞' : '未停滞'}（空轮=${this.emptyRounds} 静默轮=${this.silentRounds}）`)
          if (this.loginFound) { stopReason = 'login'; break }
          if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
          if (this.fetched >= target || this.pastRange) { stopReason = 'reached'; break }
          if (stalled) {
            const action = await this.rescueStall(adapter, target, stallSec, gen)
            if (stopped()) break
            if (action === 'paused') { stopReason = 'stalled'; break }
            if (action === 'login') { stopReason = 'login'; break }
            if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
            if (action === 'continue') continue
          }
          if (this.pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await this.sleep(2000) }
        }
      }

      // R20：已被看门狗/强制暂停接管——状态早已写好、下一个任务可能已经在跑，旧 run 什么都不许再动
      if (gen !== this.runGen) return
      if (this.aborted) {
        // R20 复查：分清「用户暂停」和「疑似风控」——两种主进程都按住队列，但界面要说清楚是哪种
        if (this.abortReason === 'risk') {
          db.prepare("UPDATE tasks SET status='paused', error='risk' WHERE id=?").run(taskId)
          this.deps.emit({ type: 'task:paused', taskId, reason: 'risk' })
        } else {
          db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
          this.deps.emit({ type: 'task:paused', taskId, reason: 'user' })
        }
      } else if (stopReason === 'login') {
        db.prepare("UPDATE tasks SET status='paused', error='login_required' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: 'login_required' })
        this.deps.emit({ type: 'task:notice', text: `请先在内置浏览器登录 ${adapter.displayName}` })
      } else if (stopReason === 'verify') {
        // R11-4：心跳检测到验证码 → 自动暂停（error=stalled_verify；index.ts push 会强制显示抖音窗口 +
        // toast「任务可能触发验证…」，用户完成验证后点「继续」恢复——resume 重置计数重新 run）
        db.prepare("UPDATE tasks SET status='paused', error='stalled_verify' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: 'stalled_verify' })
      } else if (stopReason === 'stalled' && this.fetched < target) {
        // R11：重搜 3 次超限 → 真正暂停（不再无限"进行中"）。reason=stalled 走普通 paused
        // 分支（不强制浏览器全屏——那是 stalled_verify 的行为）；用户点「继续」即恢复，计数随 run 重置
        db.prepare("UPDATE tasks SET status='paused', error='stalled' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: 'stalled' })
      } else {
        db.prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId)
        this.deps.emit({ type: 'task:done', taskId, fetched: this.fetched })
        // 只抓热门：门槛设高了可能抓不满，说清楚不是软件没抓到
        if (this.thresholdSkipped > 0) {
          this.deps.emit({ type: 'task:notice', text: `有 ${this.thresholdSkipped} 条没达到点赞 / 收藏门槛，已跳过（共抓到 ${this.fetched} 条）` })
        }
        // I-1：任务以 done 结束时做一次最终归档 flush。小任务可能在去抖窗口内就结束，
        // 最后一批 video:done 设的 timer 会被 finally 的 clearOrganizeTimer 清掉 → 该批视频永不自动归档。
        // organizePending 只处理 organize_state='pending' 的作者，幂等；organizer 缺失时无副作用。
        void this.deps.organizer?.organizePending()
      }
    } catch (err) {
      if (gen !== this.runGen) return // R20：已被接管的旧 run 抛错也不记（任务早已按「卡住」处理）
      // 这里原本是个不带参数的兜底 catch，任何异常一律记成 'network'：用户看到「网络错误」，
      // 而真实原因（页面 30 秒没打开、代码抛错…）被整个吞掉，日志里一个字都没有。
      // 真机排查抖音「一直转圈爬不到」时就卡在这一步，只能靠猜。
      const code = (err as { code?: unknown } | null)?.code === 'OP_TIMEOUT' ? 'page_timeout' : 'network'
      const detail = err instanceof Error ? err.message : String(err)
      this.deps.onFilterLog?.(`任务失败（${code}）：${detail}`)
      this.fail(taskId, code)
      this.deps.emit({ type: 'task:paused', taskId, reason: 'scheduler_error' })
    } finally {
      // R20：只收拾自己这一次 run 的摊子；已被接管的旧 run 不许清掉新任务的状态
      if (gen === this.runGen) this.cleanupRun()
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

  /** 列表只暂存卡片；达到候选数量或列表结束后，在同一浏览器串行打开详情。 */
  private async runListDetails(adapter: PlatformAdapter, target: number, stopped: () => boolean = () => this.aborted): Promise<'reached' | 'stalled' | 'verify' | 'login'> {
    const candidateTarget = this.listCandidateTarget(target)
    const enough = (): boolean => this.fetched + this.listStubs.size >= candidateTarget
    const stallMs = Math.max(this.deps.getStallThresholdSec() * 1000,
      this.scrollIntervalMs + this.scrollWaitMs + 12000)
    // #7：循环里一律看 stopped()（含 runGen）——被看门狗接管后新任务会把 aborted 重置成 false，只看它会让旧 run 动新任务的页面和状态
    while (!stopped() && !enough() && !this.listEnded) {
      const block = await this.detectPageBlock()
      if (block) return block
      if (stopped()) break
      if (await this.deps.browser.findBottomText()) { this.listEnded = true; break }
      if (stopped()) break
      if (Date.now() - this.lastFetchedAt > stallMs) {
        // 已收集的候选仍要解析；无候选时暂停，不能把无响应误报完成。
        if (this.listStubs.size === 0) return 'stalled'
        break
      }
      await this.sleep(this.scrollIntervalMs + Math.random() * SCROLL_WAIT_JITTER_MS)
      if (stopped() || enough() || this.listEnded) break
      await this.deps.browser.scrollToBottom({ waitMs: this.scrollWaitMs })
      if (stopped()) break
      this.touch() // R20：滚完一轮 = 循环还活着
      await this.collectDomListStubs(adapter)
    }
    if (stopped()) return 'reached'
    this.phase = 'detail'
    this.deps.onFilterLog?.(`搜索阶段结束：收集 ${this.listStubs.size} 条视频候选，开始逐条获取详情`)
    // 追更（作者主页 + 起始日期）：主页按发布时间从新到旧排，卡片上又看不到发布时间，只能点开才知道。
    // 连续碰到 AUTHOR_RANGE_OLDER_STREAK 条比起点还旧的作品，后面就不会再有新的了，直接收尾——
    // 否则没发新视频的博主也要把几十个候选挨个打开（真机：23 个候选白看了 3 分半）。
    // 门槛比置顶上限（3 条）多 1：置顶的旧笔记排在最前面，不能被它们骗得提前收工。
    const rangeStart = this.isAuthorRange() && this.filters?.startDate ? chinaDayStartSec(this.filters.startDate) : null
    let olderStreak = 0
    // #7：遍历开始时的快照——Map 迭代器会读到之后新加的条目，旧 run 不能拿新任务的候选去开详情
    for (const stub of [...this.listStubs.values()]) {
      if (stopped() || this.fetched >= target) break
      const block = await this.detectPageBlock()
      if (block) return block
      if (stopped()) break
      // 快速模式：详情不在窗口里导航，用登录态 session 直接拉 HTML 解析注水状态。
      // 仅当 filters.detailMode='fast' 且适配器与浏览器都支持时启用；稳妥仍是默认。
      const useFast = this.filters?.detailMode === 'fast'
        && typeof adapter.parseDetailHtml === 'function'
        && typeof this.deps.browser.fetchDetailHtml === 'function'
      const item = useFast
        ? await this.resolveDetailFast(adapter, stub)
        : await this.resolveDetail(adapter, stub)
      if (stopped()) break
      this.touch() // R20：每处理完一条详情 = 循环还活着（超时跳过的也算）
      if (this.loginFound) return 'login'
      if (this.verifyFound) return 'verify'
      if (item && this.filters) await this.applyBatch(adapter, [item], this.filters, this.isAuthorRange())
      if (rangeStart !== null && item && item.publishTime > 0) {
        olderStreak = item.publishTime < rangeStart ? olderStreak + 1 : 0
        if (olderStreak >= AUTHOR_RANGE_OLDER_STREAK) {
          this.deps.onFilterLog?.(`连续 ${olderStreak} 条都早于 ${this.filters?.startDate}，后面不会再有新作品，抓完收尾（共 ${this.fetched} 条）`)
          return 'reached'
        }
      }
      // 任务之间的间隔照样遵守（scrollIntervalMs），快速模式不额外加压
      if (!stopped() && this.fetched < target) await this.sleep(this.scrollIntervalMs)
    }
    if (!stopped() && this.fetched < target) {
      this.deps.emit({ type: 'task:notice', text: `本批视频候选处理完毕，实际收集 ${this.fetched}/${target} 条；部分候选可能不符合筛选条件或详情不可用` })
    }
    return 'reached'
  }

  /**
   * N01：在平台网页的筛选面板上点排序（抖音：悬停「筛选」→「排序依据」→「最多点赞」）。
   * 点上了就继续只收排过序的结果；没点上（页面改版、超时）就照常按综合排序抓，并在日志里说一声。
   */
  private async applyNativeSort(adapter: PlatformAdapter, type: TaskRow['type'], stopped: () => boolean = () => this.aborted): Promise<void> {
    const native = this.filters ? adapter.nativeSearchFilters?.(type, this.filters) ?? [] : []
    const apply = this.deps.browser.applyNativeSearchFilters
    if (native.length === 0 || !apply) { this.sortedOnly = false; return }
    let timer: ReturnType<typeof setTimeout> | null = null
    const result = await Promise.race([
      apply.call(this.deps.browser, native),
      new Promise<{ applied: boolean; noteIds: string[] }>(resolve => {
        timer = setTimeout(() => resolve({ applied: false, noteIds: [] }), NATIVE_FILTER_TIMEOUT_MS)
      })
    ]).finally(() => { if (timer !== null) clearTimeout(timer) })
    if (stopped()) return
    const label = native.map(x => x.option).join('、')
    if (result.applied) {
      this.deps.onFilterLog?.(`已在网页上选「${label}」排序，只收排好序的结果`)
    } else {
      this.sortedOnly = false
      this.deps.onFilterLog?.(`网页上的「${label}」排序没点上（可能页面改版了），按综合排序继续抓`)
    }
    this.lastFetchedAt = Date.now() // 点排序花的时间不算「没抓到新视频」
  }

  /** 页面原生筛选只减少无效候选；详情阶段仍会按真实时间戳与时长做最终精确过滤。 */
  private async prepareTwoStageList(adapter: PlatformAdapter, type: TaskRow['type'], stopped: () => boolean = () => this.aborted): Promise<void> {
    const filters = this.filters
    if (!filters) return
    const native = adapter.nativeSearchFilters?.(type, filters) ?? []
    const apply = this.deps.browser.applyNativeSearchFilters
    if (native.length > 0 && apply) {
      const before = new Map(this.listStubs)
      this.listStubs.clear()
      // #7：页面卡死时不让任务永远挂在这里；超时按「没应用上」处理，回退为详情阶段精确筛选
      let timer: ReturnType<typeof setTimeout> | null = null
      const result = await Promise.race([
        apply.call(this.deps.browser, native),
        new Promise<{ applied: boolean; noteIds: string[] }>(resolve => {
          timer = setTimeout(() => resolve({ applied: false, noteIds: [] }), NATIVE_FILTER_TIMEOUT_MS)
        })
      ]).finally(() => { if (timer !== null) clearTimeout(timer) })
      if (stopped()) return // 等待期间已被暂停或接管：listStubs 可能已属于新任务，不能再动
      if (!result.applied) {
        this.listStubs.clear()
        for (const [id, stub] of before) this.listStubs.set(id, stub)
        this.deps.onFilterLog?.('网页原生筛选未展开或未找到选项，回退为详情阶段精确筛选')
      } else {
        if (result.noteIds.length > 0) {
          const current = new Set(result.noteIds)
          for (const id of [...this.listStubs.keys()]) if (!current.has(id)) this.listStubs.delete(id)
        }
        this.deps.onFilterLog?.(`已应用网页原生筛选：${native.map(x => `${x.group}=${x.option}`).join('、')}`)
      }
    }
    if (stopped()) return
    await this.collectDomListStubs(adapter)
  }

  private listCandidateTarget(target: number): number {
    const filters = this.filters
    const hasThreshold = (filters?.minLikes ?? 0) > 0 || (filters?.minCollects ?? 0) > 0
    if (!filters || (filters.timeRange === 'all' && filters.duration === 'all' && !hasThreshold)) return target
    return Math.min(1000, Math.max(target * 3, target + 20))
  }

  private mergeListStubs(result: { stubs: ListStub[]; skipped: { image: number; other: number }; hasMore?: boolean }, responseIsProgress = false): number {
    const limit = this.listCandidateTarget(this.filters?.targetCount ?? 200)
    let added = 0
    for (const stub of result.stubs) {
      if (this.fetched + this.listStubs.size >= limit) break
      // 只抓热门：卡片上已经知道点赞 / 收藏没达到门槛的，不进候选（不用打开详情页，也少一次被风控的机会）；
      // 卡片上不知道的留到详情阶段再判
      if (this.filters && !meetsThreshold(stub.likes ?? Infinity, stub.collects ?? Infinity, this.filters)) {
        this.thresholdSkippedIds.add(stub.noteId)
        continue
      }
      if (!this.seen.has(stub.noteId) && !this.listStubs.has(stub.noteId)) {
        this.listStubs.set(stub.noteId, stub)
        added++
      }
    }
    if (result.hasMore === false) this.listEnded = true
    // 搜索接口的新响应即使全是图文，也说明页面仍在正常翻页；DOM 扫描每轮都会重复看到
    // 已渲染卡片，只有真的新增候选才能刷新停滞计时，否则作者作品不足目标时会永远滚动。
    if (added > 0 || responseIsProgress) { this.lastFetchedAt = Date.now(); this.touch() }
    return added
  }

  private async collectDomListStubs(adapter: PlatformAdapter): Promise<void> {
    if (!this.task || !this.deps.browser.collectListStubs) return
    const result = await this.deps.browser.collectListStubs(adapter, this.task.type)
    if (!result) return
    const added = this.mergeListStubs(result)
    if (added > 0) {
      this.deps.onFilterLog?.(`作者主页新增 ${added} 条视频候选，累计 ${this.listStubs.size} 条`)
    }
  }

  private resolveDetail(adapter: PlatformAdapter, stub: ListStub): Promise<VideoItem | null> {
    return new Promise(resolve => {
      let settled = false
      let detailTimer: ReturnType<typeof setInterval> | null = null
      const finish = (item: VideoItem | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(verifyTimer)
        if (detailTimer) clearInterval(detailTimer)
        this.pendingDetail = null
        this.abortDetail = null
        resolve(item)
      }
      const skip = (reason: string): void => {
        if (settled) return
        this.deps.onFilterLog?.(`笔记 ${stub.noteId}：${reason}`)
        finish(null)
        this.deps.browser.stopLoading?.()
      }
      // 详情提取改用 mainFrame.executeJavaScript（不等页面停止加载），注水一到位就能读到，
      // 不再需要「15 秒 stop 兜底 + 35 秒专用超时」——所有平台统一默认 30 秒。
      const timer = setTimeout(() => skip('详情超时，跳过'), this.deps.detailTimeoutMs ?? 30000)
      let checking = false
      const verifyTimer = setInterval(() => {
        if (checking || settled) return
        checking = true
        void this.detectPageBlock().then(block => {
          if (block === 'login' && !settled) skip('需要登录，暂停')
          else if (block === 'verify' && !settled) skip('需要人工验证，暂停')
        }).catch(() => { /* 页面导航中暂时无法检查，下一次再查 */ }).finally(() => { checking = false })
      }, 1000)
      this.pendingDetail = { noteId: stub.noteId, finish }
      this.abortDetail = () => { finish(null); this.deps.browser.stopLoading?.() }
      if (adapter.buildDetailDomScript && this.deps.browser.extractCurrentDetail) {
        let extracting = false
        const extract = (): void => {
          if (extracting || settled) return
          extracting = true
          void this.deps.browser.extractCurrentDetail(adapter, stub.noteId).then(item => {
            if (item && item.awemeId === stub.noteId && !settled) {
              finish(item)
              this.deps.browser.stopLoading?.()
            }
          }).catch(() => { /* 页面导航中暂时不可读，下一轮继续 */ }).finally(() => { extracting = false })
        }
        detailTimer = setInterval(extract, 200)
        extract()
      }
      // 先安装接收器再导航：响应可以早于 load 完成。异常文字可能含令牌，不能原样写日志。
      void Promise.resolve().then(() => {
        if (!settled && !this.aborted) return this.deps.browser.load(adapter, adapter.buildDetailUrl!(stub))
      }).catch(() => skip('详情加载失败，跳过'))
    })
  }

  /**
   * 快速模式：登录态 session 拉详情 HTML → 适配器解析注水状态。
   * 登录/验证码页 → 置位对应标志（主循环按 login_required / stalled_verify 暂停）；
   * 解析失败 → 写脱敏诊断（适配器保证 reason 不携带响应体/令牌）并跳过该条。
   * 详情地址带一次性令牌，日志一律只写 noteId。
   */
  private async resolveDetailFast(adapter: PlatformAdapter, stub: ListStub): Promise<VideoItem | null> {
    if (this.aborted) return null
    const url = adapter.buildDetailUrl!(stub)
    // 与稳妥模式同一个详情超时；暂停/取消经 abortDetail 立即打断。
    // 不只依赖 fetch 响应 signal：请求卡死不理会 abort 时，由 race 保证照样返回。
    const controller = new AbortController()
    const abortedOrTimedOut = new Promise<null>(resolve =>
      controller.signal.addEventListener('abort', () => resolve(null), { once: true }))
    const timer = setTimeout(() => controller.abort(), this.deps.detailTimeoutMs ?? 30000)
    this.abortDetail = () => controller.abort()
    const res = await Promise.race([
      this.deps.browser.fetchDetailHtml!(adapter, url, controller.signal).catch(() => null),
      abortedOrTimedOut
    ])
    clearTimeout(timer)
    this.abortDetail = null
    if (this.aborted) return null
    if (!res) {
      this.deps.onFilterLog?.(`笔记 ${stub.noteId}：${controller.signal.aborted ? '快速模式请求超时' : '快速模式请求失败'}，跳过`)
      return null
    }
    let outcome: FastDetailOutcome
    try {
      outcome = adapter.parseDetailHtml!(res.finalUrl, res.body, stub.noteId)
    } catch {
      outcome = { kind: 'skip', reason: '详情解析异常' }
    }
    if (outcome.kind === 'login') {
      this.loginFound = this.loginFound ?? '详情请求被重定向到登录页'
      return null
    }
    if (outcome.kind === 'verify') {
      this.verifyFound = this.verifyFound ?? '详情请求被重定向到验证码页'
      return null
    }
    if (outcome.kind === 'skip') {
      this.deps.onFilterLog?.(`笔记 ${stub.noteId}：快速模式跳过（${outcome.reason}）`)
      return null
    }
    return outcome.item
  }

  private async detectPageBlock(): Promise<'verify' | 'login' | null> {
    if (this.verifyFound) return 'verify'
    this.verifyFound = await this.deps.browser.findVerifyIndicator().catch(() => null)
    if (this.verifyFound) {
      this.deps.onFilterLog?.(`页面要求验证：${this.verifyFound} → 暂停等人工处理`)
      return 'verify'
    }
    if (this.loginFound) return 'login'
    const findLogin = this.deps.browser.findLoginIndicator
    if (!findLogin) return null
    this.loginFound = await findLogin.call(this.deps.browser).catch(() => null)
    if (this.loginFound) this.deps.onFilterLog?.(`页面要求登录：${this.loginFound} → 暂停等登录`)
    return this.loginFound ? 'login' : null
  }

  /**
   * R12/R11-5：停滞自救 = 重新搜索关键词（删除抖音筛选后唯一自救）。主循环多个检查点调用（心跳等待每 1s 步、
   * 滚动返回后、轮末兜底）；rescuing 标志防心跳/并发重入。
   * 规则：验证码优先——命中立即返回 'verify'（暂停等人工验证，绝不重搜）；
   * 到底文案命中 → 忽略冷却立即重搜（页面已无更多内容可滚，等冷却无意义）；
   * 未命中且距上次重搜 < 冷却秒数（rescueCooldownSec 默认 10）→ 返回 'skip' 跳过本轮继续等；
   * 否则重搜（≤3 次，'continue' 继续循环）；重搜超限 → 'paused' 暂停。
   */
  /**
   * R16：校验「导入进来的作者」名称是否与主页对得上。返回 true 表示已中止本次 run。
   *
   * 只对导入的作者做（pending，以及上次没通过的 failed——#9 以前只拦一次）——抓取时自动收录的作者数据来自真实接口，无需校验。
   * 取不到昵称同样判失败：宁可少入不可入错（用户明确要求「不批准就要说为什么」）。
   * 匹配用宽松规则（去空白/emoji/标点后互相包含），严格相等在真实昵称面前会大量误拒。
   */
  private async verifyImportedAuthor(taskId: number, secUid: string, gen: number): Promise<boolean> {
    // 只查这一行（以前 listAuthors 全表算一遍，作者多了会卡主进程）
    const author = this.deps.db.prepare('SELECT id, nickname, verify_state FROM authors WHERE sec_uid = ? LIMIT 1').get(secUid) as
      { id: number; nickname: string; verify_state: string | null } | undefined
    // 找不到作者行（导入后、真正开爬前被手动删掉）也直接放行——**这是有意为之**：
    // 校验的对象是「导入时声称的名字」，行都删了就没有这个声称了，没什么可比对。
    // 此时继续爬取、由 upsertAuthor 按真实接口数据重新登记作者（verify_state=null）才是对的，
    // 拦下来反而错。测试工程师曾把它当缺陷报上来，此处写明以免重复被误判。
    // #9：上次没通过（failed）的也要再校验——以前只拦一次，用户点「继续」或批量爬时错的人照样被抓
    if (!author || (author.verify_state !== 'pending' && author.verify_state !== 'failed')) return false

    const real = await this.deps.browser.readAuthorNickname()
    if (gen !== this.runGen) return true // R20：读昵称期间被看门狗接管 → 不再写任何东西
    if (real === null) {
      const why = `主页没取到作者昵称（页面打不开、未登录或弹了验证码），无法确认这个链接是不是「${author.nickname}」`
      setAuthorVerify(this.deps.db, author.id, 'failed', why)
      this.deps.onFilterLog?.(`作者校验失败：${why}`)
      this.deps.db.prepare("UPDATE tasks SET status='paused', error='author_unverifiable' WHERE id=?").run(taskId)
      this.deps.emit({ type: 'task:paused', taskId, reason: 'author_unverifiable' })
      this.deps.emit({ type: 'task:notice', text: `「${author.nickname}」校验失败：${why}` })
      return true
    }

    if (!looseNicknameMatch(author.nickname, real)) {
      const why = `主页作者是「${real}」，与你填的「${author.nickname}」对不上，已拒绝爬取`
      setAuthorVerify(this.deps.db, author.id, 'failed', why)
      this.deps.onFilterLog?.(`作者校验失败：${why}`)
      this.deps.db.prepare("UPDATE tasks SET status='paused', error='author_mismatch' WHERE id=?").run(taskId)
      this.deps.emit({ type: 'task:paused', taskId, reason: 'author_mismatch' })
      this.deps.emit({ type: 'task:notice', text: `「${author.nickname}」校验失败：${why}` })
      return true
    }

    setAuthorVerify(this.deps.db, author.id, 'ok')
    this.deps.onFilterLog?.(`作者校验通过：「${author.nickname}」`)
    return false
  }
  private async rescueStall(adapter: PlatformAdapter, target: number, stallSec: number, gen: number = this.runGen): Promise<'continue' | 'paused' | 'skip' | 'verify' | 'login'> {
    if (this.rescuing || this.aborted || gen !== this.runGen) return 'continue'
    this.rescuing = true
    // R20：每次等页面回话后都要看一眼自己是不是已经被看门狗接管了（接管后状态属于下一个任务，不能再动）
    const stale = (): boolean => gen !== this.runGen
    const log = (msg: string): void => { this.deps.onFilterLog?.(msg) }
    try {
      // R11-5：自救前先查验证码（verifyFound 已由心跳置位则直接用）——验证弹窗挂着时绝不再重搜/查到底
      //（重搜会烧掉 3 次机会；真机反馈「机器人验证」弹窗时 5 秒停滞直接重搜）
      const block = await this.detectPageBlock()
      if (stale()) return 'continue'
      if (block === 'login') {
        log(`未登录检测命中：「${this.loginFound}」→ 暂停等登录（不再重搜）`)
        return 'login'
      }
      if (block === 'verify') {
        log(`验证码检测命中：「${this.verifyFound}」→ 暂停等人工验证（不再重搜）`)
        return 'verify'
      }
      const elapsed = Date.now() - this.lastFetchedAt
      log(`停滞检测（自救触发）：${(elapsed / 1000).toFixed(1)} 秒无新视频（阈值 ${stallSec} 秒）→ 已停滞（已重搜 ${this.reSearchCount}/3 次）`)
      const bottomText = await this.deps.browser.findBottomText().catch(() => null)
      if (stale()) return 'continue'
      const cooldownSec = getSettings().rescueCooldownSec ?? 10
      const bottomHit = bottomText !== null
      // R20 复查：作者主页按日期段抓、页面已经到底 → 日期段里能抓的都抓了，按「抓完」收尾（done）。
      // 重搜只会把主页拉回顶部再翻一遍同样的作品，最后被当成「爬不满」暂停；只填「到」的任务尤其如此（没有起点可翻过）。
      if (bottomHit && this.isAuthorRange()) {
        log(`作者主页已经翻到底（「${bottomText}」），日期段内的抓完了（共 ${this.fetched} 条）`)
        this.pastRange = true
        return 'continue'
      }
      if (!bottomHit) {
        const since = Date.now() - this.lastRescueAt
        if (since < cooldownSec * 1000) {
          // ② 重搜冷却中：跳过本轮继续等（10 秒间隔防刷屏/降风控，notice 不频繁打扰用户）
          log(`未找到到底文案；重搜冷却中（距上次重搜 ${(since / 1000).toFixed(1)} 秒 < ${cooldownSec} 秒），本轮跳过继续等`)
          return 'skip'
        }
      }

      // R11-5 双保险：重搜分支前再查一次验证码（找到底/冷却判定期间可能新弹验证弹窗）
      const blockBeforeSearch = await this.detectPageBlock()
      if (stale()) return 'continue'
      if (blockBeforeSearch === 'login') {
        log(`未登录检测命中：「${this.loginFound}」→ 暂停等登录（不重搜）`)
        return 'login'
      }
      if (blockBeforeSearch === 'verify') {
        log(`验证码检测命中：「${this.verifyFound}」→ 暂停等人工验证（不重搜）`)
        return 'verify'
      }

      // Task4：「≥3 次上限」检查挪到「执行重搜/立即重搜」日志之前——旧版先打印"执行重搜"再判上限，
      // 上限已到时会打出撒谎的"执行重搜"日志（实际直接走④暂停）。现在先判上限，判定即走④，
      // 不再经过下面的①/②日志分支，日志与实际行为一致；暂停语义本身不变。
      if (this.reSearchCount >= 3) {
        // ④ 重搜超限：暂停（提示用户调整关键词）
        log('已重搜 3 次仍爬不满：自动暂停（请调整关键词）')
        this.deps.emit({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词' })
        return 'paused'
      }

      if (bottomHit) {
        // ① 到底文案命中：搜索已到底，忽略冷却立即重搜（页面没有更多内容可滚，等冷却无意义）
        log(`到底文案命中：「${bottomText}」→ 立即重搜（忽略重搜冷却）`)
      } else {
        log(`未找到到底文案（findBottomText 返回 null），已过重搜冷却（${cooldownSec} 秒），执行重搜`)
      }

      // ③ 重搜（≤3 次）：重新加载任务首屏 URL（关键词=搜索页/作者=主页/话题=话题页）；冷却自本次起算
      this.lastRescueAt = Date.now() // R12：重搜冷却计时起点（间隔内不再重搜，notice 不刷屏）
      this.reSearchCount++
      log(`第 ${this.reSearchCount} 次重搜：${this.task?.query ?? ''}（${this.taskUrl}）`)
      this.deps.emit({ type: 'task:notice', text: `已自动重新搜索关键词（第 ${this.reSearchCount} 次）` })
      this.deps.emit({ type: 'task:progress', taskId: this.taskId, fetched: this.fetched, status: 'running', reSearchCount: this.reSearchCount })
      try {
        await this.deps.browser.load(adapter, this.taskUrl)
      } catch (err) {
        // R11-4：重搜加载失败/超时（如 30s 强制超时）——重搜计数已消耗（reSearchCount++ 在上方），
        // 按"加载失败"处理：重置停滞计数继续爬，给下轮自救机会（不把任务判失败）
        log(`第 ${this.reSearchCount} 次重搜加载失败/超时：${err instanceof Error ? err.message : String(err)}（计数已消耗，继续）`)
      }
      if (stale()) return 'continue'
      // N01：页面重新加载回到了综合排序，要再点一次排序
      if (this.sortedOnly && this.task) await this.applyNativeSort(adapter, this.task.type, stale)
      if (stale()) return 'continue'
      this.touch() // R20：重搜加载完（成功或超时）= 自救这条路还在走
      this.scrolledIds = new Set<string>() // 页面回到顶部重新翻，之前滚过的作品会再出现一遍，这是正常的
      // 重置停滞计数继续爬：lastFetchedAt 从加载完成起算；seen 去重保证只收新条目
      this.lastFetchedAt = Date.now()
      this.emptyRounds = 0
      this.silentRounds = 0
      this.rawSinceLastRound = true // 重搜后首轮不计静默（新页面加载需要时间）
      return 'continue'
    } finally {
      if (!stale()) this.rescuing = false
    }
  }

  /** 只处理当前任务类型对应的接口响应，避免把推荐页/自己主页等无关 feed 当结果爬进来（用户反馈爬到了不该爬的内容）。
   *  匹配放宽：搜索接口路径多变（/search/item/、/general/search/ 等），用宽松的 /search/ 判断；
   *  推荐feed(/tab/feed/ 等)与个人主页(/user/profile/ 或 /aweme/post/ 之外的)不会含 /search/。 */

  /** 主进程从 ipcMain 'platform:raw' 调用来处理一个原始 JSON（任务期间持续被调用）。适配器由当前活动浏览器窗口给出，不由 URL 反推。 */
  async handleRaw(adapter: PlatformAdapter, rawUrl: string, json: unknown): Promise<{ items: number; kept: number } | null> {
    if (this.aborted || this.taskId === 0 || this.adapter !== adapter) return null
    if (!adapter.apiUrlPatterns.some(r => r.test(rawUrl))) return null
    if (this.phase === 'detail') {
      const pending = this.pendingDetail
      if (!pending || !adapter.isDetailResponse!(rawUrl, json, pending.noteId)) return null
      let item: VideoItem | null = null
      try { item = adapter.parseDetail!(json) } catch { /* 解析异常按单条失败处理，禁止打印响应 */ }
      if (item && item.awemeId !== pending.noteId) return null
      if (!item) this.deps.onFilterLog?.(`笔记 ${pending.noteId}：详情解析失败或无视频地址，跳过`)
      pending.finish(item)
      return { items: item ? 1 : 0, kept: 0 }
    }
    // 任务接口匹配由适配器决定：抖音看接口路径，快手关键词/作者/详情共用同一个
    // /graphql，URL 完全相同，只能看响应里的 operation 根字段。
    if (!this.task || !adapter.matchesTaskResponse(this.task.type, rawUrl, json)) return null
    // R20 复查：抖音作者主页接口只按路径认，上一个任务的页面（看门狗刷新 / 还没跳走）发来的数据会串进这个任务；
    // 地址里带 sec_user_id 的，对不上就不收。
    if (this.task.type === 'author' && !this.isOwnAuthorFeed(rawUrl)) return null
    // N01：选了排序就只收排好序的那批（页面刚打开时按综合排序返回的不要）
    if (this.sortedOnly && this.filters && adapter.acceptsSortedResponse && !adapter.acceptsSortedResponse(rawUrl, this.filters)) return null
    this.rawSinceLastRound = true
    if (this.phase === 'list') {
      const result = adapter.parseListStubs!(rawUrl, json)
      const target = this.listCandidateTarget(this.filters?.targetCount ?? 200)
      this.mergeListStubs(result, true)
      // 图文也是有效搜索进展，不能因图文占多数误判风控。
      this.deps.onFilterLog?.(`搜索视频候选 ${this.listStubs.size} 条；跳过图文 ${result.skipped.image} 条、其他 ${result.skipped.other} 条`)
      if (this.listEnded || this.fetched + this.listStubs.size >= target) this.deps.browser.abortScroll?.()
      return { items: result.stubs.length, kept: 0 }
    }
    const filters = this.filters
    if (!filters) return null
    const items = adapter.parseApiJson(rawUrl, json)
    const authorRange = this.isAuthorRange()
    const result = await this.applyBatch(adapter, items, filters, authorRange)
    // R20 复查：作者主页按日期段抓，接口说「后面没有了」→ 这一批处理完就算抓完（done），不再等停滞、不当爬不满暂停
    if (authorRange && feedEnded(json) && this.filters === filters && !this.pastRange) {
      this.deps.onFilterLog?.(`作者主页已经翻到底（接口说没有更多了），日期段内的抓完了（共 ${this.fetched} 条）`)
      this.pastRange = true
      this.deps.browser.abortScroll?.()
    }
    return result
  }

  /** R20 复查：当前任务是不是「作者主页 + 日期段」 */
  private isAuthorRange(): boolean {
    return this.task?.type === 'author' && this.filters?.timeRange === 'custom'
  }

  /** R20 复查：接口地址里的 sec_user_id（有的话）是不是本任务要抓的作者；没带这个参数的平台一律放行 */
  private isOwnAuthorFeed(rawUrl: string): boolean {
    if (!this.authorSecUid) return true
    try {
      const v = new URL(rawUrl).searchParams.get('sec_user_id')
      return !v || v === this.authorSecUid
    } catch { return true }
  }

  /** 一批接口数据：过滤、去重、入库（原 handleRaw 主体） */
  private async applyBatch(adapter: PlatformAdapter, items: ReturnType<PlatformAdapter['parseApiJson']>, filters: Filters, authorRange: boolean): Promise<{ items: number; kept: number }> {
    const db = this.deps.db
    // B4：AI 判定每条最多等 60 秒。等完时任务可能已经暂停结束（taskId 清零）或换成下一个任务，
    // 这时再写库会以 task_id=0 入库、或记到新任务名下，还会发出假的进度事件——记下进来时的任务，每次 await 后对一下
    const gen = this.runGen
    const ownTaskId = this.taskId
    const stale = (): boolean => gen !== this.runGen || this.taskId !== ownTaskId
    // R18：作者主页是按时间倒序的——这一批全比日期段起点老，说明已经翻过日期段，后面只会更老 → 抓完
    // R20：起点按北京时间当天 00:00 算（以前按 UTC，差 8 小时）
    const startTs = authorRange && filters.startDate ? chinaDayStartSec(filters.startDate) : null
    if (startTs !== null && items.length > 0) {
      if (items.every(i => i.publishTime > 0 && i.publishTime < startTs)) {
        if (!this.pastRange) this.deps.onFilterLog?.(`已翻到 ${filters.startDate} 之前的作品，日期段内的抓完了（共 ${this.fetched} 条）`)
        this.pastRange = true
        this.touch()
        this.deps.browser.abortScroll?.()
        return { items: items.length, kept: 0 }
      }
    }
    // 只抓热门：记下没达到门槛被筛掉的（库里已有的不算），任务结束时告诉用户
    for (const i of items) if (!this.seen.has(i.awemeId) && !meetsThreshold(i.likes, i.collects, filters)) this.thresholdSkippedIds.add(i.awemeId)
    const kept = dedupeVideos(filterVideos(items, filters), this.seen)
    // R20 复查：作者主页按日期段抓——这一批里有没见过的作品就说明页面确实往下翻了
    const freshIds = authorRange ? items.filter(i => !this.scrolledIds.has(i.awemeId)) : items
    if (authorRange) for (const i of items) this.scrolledIds.add(i.awemeId)
    if (kept.length === 0) {
      if (authorRange && items.length > 0) {
        // R20：作者主页按日期段抓，这一批一条都没留，但接口是有数据的——可能是
        //  ① 比结束日期还新（主页最上面，要先翻过去才到日期段）；② 日期段内但以前已经抓过（补抓同一段）；③ 被时长筛掉。
        // 这些都**不是**风控：不累计空轮。只有页面确实往下翻了（有没见过的作品）才算进展、刷新停滞计时；
        // 同一批反复出现（游标卡住 / 软风控）不算，停滞检测照常起作用（重搜 3 次后暂停）。
        // 以前这里会累计空轮 → 3 轮就当风控暂停；或者迟迟没有「新视频」→ 判停滞 → 重搜把页面拉回顶部，永远翻不到日期段。
        if (freshIds.length > 0) {
          const endTs = filters.endDate ? chinaDayEndSec(filters.endDate) : null
          if (endTs !== null && !this.skippingNewerLogged && freshIds.some(i => i.publishTime > endTs)) {
            this.skippingNewerLogged = true
            this.deps.onFilterLog?.(`正在往下翻 ${filters.endDate} 之后发的作品（还没到你选的日期段），继续滚动`)
          }
          this.lastFetchedAt = Date.now()
          this.emptyRounds = 0
          this.touch()
        }
        return { items: items.length, kept: 0 }
      }
      this.touch() // R20：本任务的接口数据还在来 = 没卡住
      this.emptyRounds++
      if (this.phase !== 'detail' && isRiskSignal(this.emptyRounds) && filters.timeRange !== 'all') {
        // 保守起见：连续空数据→风控，暂停任务（真实风控判定以"连续N轮无有效数据"为信号，不额外发探针请求）
        if (!this.aborted) this.abortReason = 'risk'
        this.aborted = true
      }
      return { items: items.length, kept: 0 }
    }
    this.touch() // R20：本任务的接口数据还在来 = 没卡住
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
          if (stale()) return { items: items.length, kept: 0 }
          if (!v.pass) {
            const insertedId = db.prepare(
              "INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,play_addr,source_url,cover_url,video_width,video_height,duration,publish_time,stats,status,ai_verdict,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'filtered','filtered',?)"
            ).run(adapter.name, this.taskId, item.awemeId, item.title, item.playUrl,
                 item.sourceUrl || null, item.coverUrl || null, item.width, item.height, item.durationSec,
                 new Date(item.publishTime * 1000).toISOString(), statsJson(item),
                 new Date().toISOString())
            if (insertedId.changes > 0) {
              this.fetched++
              this.lastFetchedAt = Date.now() // T4：有新视频入库，重置"15 秒无新视频"计时
              db.prepare('UPDATE tasks SET fetched_count=? WHERE id=?').run(this.fetched, this.taskId)
            }
            continue
          }
        } catch { /* AI 失败降级：视为通过 */ }
        if (stale()) return { items: items.length, kept: 0 }
      }
      // #4 关键词任务：品类直接用搜索词（如搜"农村搞笑"→品类"农村搞笑"）；其它类型用视频第一个 #话题
      const category = this.task?.type === 'keyword' && this.task.query
        ? this.task.query.slice(0, 20)
        : extractCategory(item.title)
      // Task5 下载方式：自动下载 → 入 pending 并交给下载器；手动 → 仅收集（collected），不进下载队列
      const status = this.autoDownload ? 'pending' : 'collected'
      // 性能 F2：登记作者 + 入库 + 作者计数合成一次提交（以前每条视频 3～4 次落盘）
      const info = inTransaction(db, () => {
        const author = upsertAuthor(db, item, adapter.name, category)
        const r = db.prepare(
          `INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,author_id,play_addr,source_url,cover_url,video_width,video_height,duration,publish_time,stats,status,ai_verdict,fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(adapter.name, this.taskId, item.awemeId, item.title, author.id, item.playUrl,
             item.sourceUrl || null, item.coverUrl || null, item.width, item.height, item.durationSec,
             new Date(item.publishTime * 1000).toISOString(), statsJson(item),
             status, 'pass', new Date().toISOString())
        let reclaimed: number | null = null
        if (r.changes > 0) {
          if (!author.created) db.prepare('UPDATE authors SET video_count = video_count + 1 WHERE id = ?').run(author.id)
        } else if (filters.redownload) {
          // 2026-10-09 任务勾了「以前下过的也重新下」：库里已有的也领到这个任务重新下
          reclaimed = reclaimSeenVideo(db, adapter.name, item, this.taskId, status)
          if (reclaimed === null) refreshSeenVideo(db, adapter.name, item)
        } else refreshSeenVideo(db, adapter.name, item) // 已在库里：更新点赞，没下好的换新地址
        return { changes: r.changes, id: reclaimed ?? (r.changes > 0 ? Number(r.lastInsertRowid) : null) }
      })
      if (info.id !== null) {
        this.fetched++
        this.lastFetchedAt = Date.now() // T4：有新视频入库，重置"15 秒无新视频"计时
        if (this.autoDownload) {
          const vid = info.id
          this.pendingVideoIds.push(vid)
          this.deps.downloader.enqueue(vid)
        }
      }
    }
    // R11-2：爬满 → 中断在途滚动（复用暂停信号：滚动脚本下个检查点即退，~550ms 内停；
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
