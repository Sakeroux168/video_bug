import type { DatabaseSync } from 'node:sqlite'
import type { PlatformAdapter } from './adapters/types'
import type { AppSettings, TaskRow, TaskStatus, Filters } from '../shared/types'
import { ERROR } from '../shared/types'
import { filterVideos, dedupeVideos, extractCategory } from './extractor'
import { isRiskSignal } from './errors'
import { upsertAuthor, listAuthors, setAuthorVerify } from './db'
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
  /** T2/Task4：每次 run 现读滚动参数（含 scrollIntervalMs；设置保存即生效，无需重启，不再在构造时缓存） */
  getScrollParams: () => Pick<AppSettings, 'scrollSpeed' | 'scrollPageWaitMs' | 'scrollIntervalMs'>
  /** R11：停滞判定阈值秒数（每次 run 现读，不构造时缓存；Date.now()-lastFetchedAt > 秒数*1000 即判爬不动） */
  getStallThresholdSec: () => number
  /** Task5：按作者整理器（可选；未注入则下载完成不触发整理） */
  organizer?: Organizer | null
  /** Task5：下载完成→按作者归档去抖毫秒；<=0 表示立即归档 */
  organizeDebounceMs?: number
  /** R12：停滞自救全链路日志回调（停滞检测/到底命中/重搜冷却/重搜计数），主进程汇入界面「查看拦截日志」面板 */
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
  /** R11-4：心跳 tick 计数（每 2 tick=2s 查一次验证码） */
  private verifyTick = 0
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
      this.reSearchCount = 0 // R11：每次 run 重置重搜计数（恢复任务后可重新自救）
      this.lastRescueAt = 0 // R12：每次 run 重置重搜冷却（恢复任务后可立即自救）
      this.verifyFound = null // R11-4：每次 run 重置验证码检测（resume 后重新检测）
      this.verifyTick = 0
      this.lastFetchedAt = Date.now() // T4/R11：X 秒无新视频计时的起点
      this.pendingVideoIds = []
      this.aiEnabled = !!(this.deps.analyzer) && !!this.filters.aiFilterEnabled
      this.autoDownload = !!task.auto_download

      db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)

      // R11-2：任务一启动立即发首个进度事件（UI 马上显示"进行中"；否则排队任务要等第一轮
      // 抓到数据才从"等待"变"进行中"，用户看到长时间无反应）
      this.deps.emit({ type: 'task:progress', taskId, fetched: this.fetched, status: 'running' })

      const url = task.type === 'author'
        // P1.5：防御性归一——库里可能有 query=完整 URL 的历史 pending 行（重启恢复会重新入队），
        // 不归一会拼出 buildAuthorUrl(完整URL) 的双重包裹 URL（无效页面→任务静默卡死）
        ? adapter.buildAuthorUrl(adapter.parseAuthorInput(task.query) ?? task.query)
        : task.type === 'hashtag'
          ? adapter.buildHashtagUrl(task.query)
          : adapter.buildSearchUrl(task.query, this.filters)
      this.taskUrl = url // R11：重搜时复用（重新加载任务首屏，结果集重置；seen 去重保证只收新条目）
      await this.deps.browser.load(adapter, url)

      // R16：导入作者的「名称强绑链接」校验。
      // 搭这次页面加载的车——不额外开页、不增加任何风控。
      // 只查 verify_state='pending' 的（导入进来的）；抓取自动收录的作者数据来自真实接口，不必校验。
      if (task.type === 'author') {
        const stop = await this.verifyImportedAuthor(taskId, adapter.parseAuthorInput(task.query) ?? task.query)
        if (stop) return
      }

      // 首轮不计静默，避免加载后立即以 0 抓取误停
      this.rawSinceLastRound = true

      const target = this.filters.targetCount ?? 200
      // T2/Task4：滚动参数每次 run 现读（设置保存即生效，含 scrollIntervalMs）；scrollSpeed 提供默认（慢8s/中5s/快3s），数字微调优先
      const p = this.deps.getScrollParams()
      const speedDefault = { slow: 8000, medium: 5000, fast: 3000 }[p.scrollSpeed] ?? 8000
      this.scrollWaitMs = p.scrollPageWaitMs > 0 ? p.scrollPageWaitMs : speedDefault
      this.scrollIntervalMs = p.scrollIntervalMs
      let stopReason: 'reached' | 'stalled' | 'verify' | null = null
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
      this.stallHeartbeat = setInterval(() => {
        if (this.aborted) return
        this.verifyTick++
        if (this.verifyTick % 2 === 0 && !this.verifyFound) {
          void this.deps.browser.findVerifyIndicator().then(m => {
            if (m && !this.aborted) {
              this.verifyFound = m
              if (this.scrolling) this.deps.browser.abortScroll?.() // 让滚动返回，主循环尽快 break
            }
          }).catch(() => {})
        }
        if (this.rescuing) return
        if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
          if (this.scrolling) this.deps.browser.abortScroll?.()
          else if (this.adapter) void this.rescueStall(this.adapter, target, stallSec)
        }
      }, 1000)
      // T3/T4：轮次计数器（触发检查点日志标注第几轮用）
      let roundCount = 0
      while (!this.aborted) {
        // R11-3：心跳式等待——sleep 拆成 1s 小步（累计到滚动间隔才触发滚动，滚动频率不变）；
        // 每步检查停滞：命中即走自救（不等整轮结束）
        const waitTotal = this.scrollIntervalMs + Math.random() * SCROLL_WAIT_JITTER_MS
        let waited = 0
        while (!this.aborted && waited < waitTotal) {
          const step = Math.min(1000, waitTotal - waited)
          await this.sleep(step)
          waited += step
          if (this.aborted) break
          if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
          if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
            if (this.fetched >= target) { stopReason = 'reached'; break }
            const action = await this.rescueStall(adapter, target, stallSec)
            if (this.aborted) break
            if (action === 'paused') { stopReason = 'stalled'; break }
            if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
            if (action === 'continue') waited = 0 // 重搜成功后重新起算等待，继续爬（skip=冷却中，继续当前等待）
          }
        }
        // A1：暂停时不跑滚动（滚动是长任务且不可中断，提前检查避免多滚一轮）
        if (this.aborted) break
        if (stopReason) break
        // R11-3：滚动标志置位——心跳据此在停滞时中断在途滚动（~0.5s 返回）
        this.scrolling = true
        try {
          await this.deps.browser.scrollToBottom({ waitMs: this.scrollWaitMs })
        } finally {
          this.scrolling = false
        }
        // 暂停即时：pause 可能落在 scrollToBottom 内（abortWait 为 null，收尾 sleep 无人唤醒）——
        // 滚动被 abortScroll 中断返回后立即检查 aborted，跳过收尾 sleep 直接进 finally（~1 秒内进暂停态）
        if (this.aborted) break
        if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
        // R11-2：爬满即停——handleRaw 已通过 abortScroll 中断在途滚动，返回后立即收尾，
        // 不再经过收尾 sleep 白等一轮（此前整轮滚动+收尾 sleep 后才检查 reached，完成要拖 ~15-20s）
        if (this.fetched >= target) { stopReason = 'reached'; break }
        // R11-3：滚动返回后立即检查停滞——心跳已中断在途滚动（~0.5s），这里马上自救，不进整轮等待
        if (Date.now() - this.lastFetchedAt > stallSec * 1000) {
          const action = await this.rescueStall(adapter, target, stallSec)
          if (this.aborted) break
          if (action === 'paused') { stopReason = 'stalled'; break }
          if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
          if (action === 'continue') continue // 重搜成功：重新进入等待阶段（不再跑 settle/轮末检查）
        }
        // 放慢节奏：滚动后多等一拍让当页结果加载完再进下一轮（默认约1.5s，随每页等待时长缩放；测试环境按间隔缩放保持快速）
        await this.sleep(Math.min(1500, this.scrollWaitMs / 4, this.scrollIntervalMs * 2))
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
        if (this.verifyFound) { stopReason = 'verify'; break } // R11-4：心跳检测到验证码 → 暂停等人工验证
        if (this.fetched >= target) { stopReason = 'reached'; break }
        if (stalled) {
          const action = await this.rescueStall(adapter, target, stallSec)
          if (this.aborted) break
          if (action === 'paused') { stopReason = 'stalled'; break }
          if (action === 'verify') { stopReason = 'verify'; break } // R11-5：验证码命中 → 暂停等人工验证
          if (action === 'continue') continue
        }
        if (this.pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await this.sleep(2000) }
      }

      if (this.aborted) {
        db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
        this.deps.emit({ type: 'task:paused', taskId, reason: '用户暂停或风控' })
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
      // R11-3/4：清理心跳计时器与滚动/自救/验证码标志（任务结束/暂停后不再心跳）
      if (this.stallHeartbeat !== null) { clearInterval(this.stallHeartbeat); this.stallHeartbeat = null }
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
   * 只对 verify_state='pending' 的作者做——抓取时自动收录的作者数据来自真实接口，无需校验。
   * 取不到昵称同样判失败：宁可少入不可入错（用户明确要求「不批准就要说为什么」）。
   * 匹配用宽松规则（去空白/emoji/标点后互相包含），严格相等在真实昵称面前会大量误拒。
   */
  private async verifyImportedAuthor(taskId: number, secUid: string): Promise<boolean> {
    const author = listAuthors(this.deps.db).find(a => a.sec_uid === secUid)
    // 找不到作者行（导入后、真正开爬前被手动删掉）也直接放行——**这是有意为之**：
    // 校验的对象是「导入时声称的名字」，行都删了就没有这个声称了，没什么可比对。
    // 此时继续爬取、由 upsertAuthor 按真实接口数据重新登记作者（verify_state=null）才是对的，
    // 拦下来反而错。测试工程师曾把它当缺陷报上来，此处写明以免重复被误判。
    if (!author || author.verify_state !== 'pending') return false

    const real = await this.deps.browser.readAuthorNickname()
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
  private async rescueStall(adapter: PlatformAdapter, target: number, stallSec: number): Promise<'continue' | 'paused' | 'skip' | 'verify'> {
    if (this.rescuing || this.aborted) return 'continue'
    this.rescuing = true
    const log = (msg: string): void => { this.deps.onFilterLog?.(msg) }
    try {
      // R11-5：自救前先查验证码（verifyFound 已由心跳置位则直接用）——验证弹窗挂着时绝不再重搜/查到底
      //（重搜会烧掉 3 次机会；真机反馈「机器人验证」弹窗时 5 秒停滞直接重搜）
      if (!this.verifyFound) {
        this.verifyFound = await this.deps.browser.findVerifyIndicator().catch(() => null)
      }
      if (this.verifyFound) {
        log(`验证码检测命中：「${this.verifyFound}」→ 暂停等人工验证（不再重搜）`)
        return 'verify'
      }
      const elapsed = Date.now() - this.lastFetchedAt
      log(`停滞检测（自救触发）：${(elapsed / 1000).toFixed(1)} 秒无新视频（阈值 ${stallSec} 秒）→ 已停滞（已重搜 ${this.reSearchCount}/3 次）`)
      const bottomText = await this.deps.browser.findBottomText().catch(() => null)
      const cooldownSec = getSettings().rescueCooldownSec ?? 10
      const bottomHit = bottomText !== null
      if (!bottomHit) {
        const since = Date.now() - this.lastRescueAt
        if (since < cooldownSec * 1000) {
          // ② 重搜冷却中：跳过本轮继续等（10 秒间隔防刷屏/降风控，notice 不频繁打扰用户）
          log(`未找到到底文案；重搜冷却中（距上次重搜 ${(since / 1000).toFixed(1)} 秒 < ${cooldownSec} 秒），本轮跳过继续等`)
          return 'skip'
        }
      }

      // R11-5 双保险：重搜分支前再查一次验证码（找到底/冷却判定期间可能新弹验证弹窗）
      if (!this.verifyFound) {
        this.verifyFound = await this.deps.browser.findVerifyIndicator().catch(() => null)
      }
      if (this.verifyFound) {
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
      // 重置停滞计数继续爬：lastFetchedAt 从加载完成起算；seen 去重保证只收新条目
      this.lastFetchedAt = Date.now()
      this.emptyRounds = 0
      this.silentRounds = 0
      this.rawSinceLastRound = true // 重搜后首轮不计静默（新页面加载需要时间）
      return 'continue'
    } finally {
      this.rescuing = false
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
              "INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,play_addr,cover_url,video_width,video_height,duration,publish_time,status,ai_verdict,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,'filtered','filtered',?)"
            ).run(adapter.name, this.taskId, item.awemeId, item.title, item.playUrl,
                 item.coverUrl || null, item.width, item.height, item.durationSec,
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
        `INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,author_id,play_addr,cover_url,video_width,video_height,duration,publish_time,stats,status,ai_verdict,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(adapter.name, this.taskId, item.awemeId, item.title, author.id, item.playUrl,
           item.coverUrl || null, item.width, item.height, item.durationSec,
           new Date(item.publishTime * 1000).toISOString(), JSON.stringify({ likes: item.likes }),
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
