import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from './db'
import { VideoBrowser } from './browser'
import { Scheduler } from './scheduler'
import { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import { Organizer } from './organizer'
import type { ResolveCategoryFn } from './organizer'
import { registerIpc } from './ipc'
import { enqueuePendingTasks, recoverPendingVideos } from './recovery'
import { getSettings } from './settings'
import { douyinAdapter, drainDurationDiags } from './adapters/douyin'
import { classifyAuthor } from './ai/organizer-ai'
import { transcribeFor } from './asr/asr'
import type { Transcript } from './asr/asr'
import { status as asrStatus, pathFor } from './asr/models'
import { findFfmpeg } from './asr/media'
import type { VideoRow } from '../shared/types'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
let downloader: Downloader | null = null
let scheduler: Scheduler | null = null
let analyzer: Analyzer | null = null
let organizer: Organizer | null = null
let taskRunning = false
let browserShown = false
let forceBrowserFull = false

/** 根据任务状态与用户所在标签决定抖音窗口显示方式：
 *  任务运行中 / 验证暂停 → 显示独立抖音窗口（不盖管理面板，可拖走）；
 *  无任务 → 仅在用户切到浏览器标签时显示。
 *  focus：程序化调用（任务/验证）不传，showInactive 显示不抢焦点；仅用户主动切标签时传 true */
function updateBrowserDisplay(focus = false): void {
  if (!browser) return
  if (taskRunning || forceBrowserFull) browser.setVisible(true, focus)
  else browser.setVisible(browserShown, focus)
}

function setBrowserVisible(v: boolean): void {
  browserShown = v
  if (v) forceBrowserFull = false // 用户主动切到浏览器标签，解除强制全屏
  updateBrowserDisplay(v) // 用户操作 → 聚焦显示（传 true）
}

// I4 简单 FIFO 任务队列：串行执行，任务终态后自动出队跑下一个；去重防同一任务重复入队
const pendingTasks: number[] = []
const queuedTaskIds = new Set<number>()

/** I3 根据当前设置重建 Analyzer（settings:save 后调用，让 AI 配置即时生效） */
function reloadAnalyzer(): void {
  const s = getSettings()
  analyzer = s.aiApiKey ? new Analyzer(s) : null
}

function dequeueAndRun(): void {
  // setImmediate 延迟到当前调用栈结束：任务 emit 终态事件时 running 尚未复位，直接 run 会被静默丢弃
  setImmediate(() => {
    if (scheduler?.isRunning) return
    const next = pendingTasks.shift()
    if (next === undefined) return
    queuedTaskIds.delete(next)
    void scheduler?.run(next)
  })
}

function enqueueTask(id: number): void {
  if (queuedTaskIds.has(id)) return
  queuedTaskIds.add(id)
  pendingTasks.push(id)
  void dequeueAndRun()
}

/** 把任务从队列里摘掉（删任务用）。已经开跑的不在队列里，由调度器那边叫停。 */
function dequeueTask(id: number): void {
  queuedTaskIds.delete(id)
  const i = pendingTasks.indexOf(id)
  if (i >= 0) pendingTasks.splice(i, 1)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, title: '视频爬取工具',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
  })
  // C-1：非 macOS 点×关主窗口必须确定退出。子窗口(抖音视图)的 close 被拦截成 hide，
  // 若不先 dispose，window-all-closed 永不触发、app 不退出、进程挂后台。关窗前先销毁子窗口。
  // createWindow 时 browser 模块变量尚为 null，用闭包引用模块级 browser —— 用户关窗时已赋值；dispose 幂等。
  // macOS 保留现状：window-all-closed 不退出、Cmd+Q 走 before-quit。
  win.on('close', () => { if (process.platform !== 'darwin') browser?.dispose() })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function push(evt: unknown): void {
  const t = evt as { type?: string; status?: string; reason?: string } | null
  // 通知类事件（如自动重搜提示）：单独转发到 notice 通道，渲染层 toast 展示
  if (t?.type === 'task:notice') {
    win?.webContents.send('evt:task:notice', t)
    return
  }
  win?.webContents.send('evt:task:progress', evt)
  if (t) {
    if (t.type === 'task:progress' && t.status === 'running') {
      taskRunning = true
      forceBrowserFull = false
      updateBrowserDisplay()
    }
    if (t.type === 'task:done') {
      taskRunning = false
      forceBrowserFull = false
      updateBrowserDisplay()
      void dequeueAndRun() // 只有真正完成才放行下一个排队任务
    }
    if (t.type === 'task:paused') {
      taskRunning = false
      if (t.reason === 'stalled_verify') {
        // 触发验证：显示独立抖音窗口让用户过验证（showInactive 不抢焦点），并提示；不自动放行下一个任务
        forceBrowserFull = true
        updateBrowserDisplay()
        win?.webContents.send('evt:task:notice', {
          type: 'stalled_verify', text: '任务可能触发验证，请在浏览器完成验证后点「继续」'
        })
      } else {
        updateBrowserDisplay()
      }
    }
  }
}

app.whenReady().then(() => {
  const db = new DatabaseSync(join(app.getPath('userData'), 'scraper.db'))
  initDb(db)

  createWindow()

  const settings = getSettings()
  reloadAnalyzer()
  downloader = new Downloader(db, settings)
  browser = new VideoBrowser(win!)

  // Task14：ASR 依赖组装。ffmpeg 用 findFfmpeg()；模型路径从 asr 模型目录取。
  // asrReady 每次归档时现查（models.status().ready）：模型下载完成/设置保存后即时生效，无需重启。
  const ffmpeg = findFfmpeg()
  function buildAsrDeps(): {
    asrReady: boolean
    ffmpeg: string | null
    asr: { transcribeFor: (row: VideoRow) => Promise<Transcript> } | null
  } {
    if (!asrStatus().ready || !ffmpeg) return { asrReady: false, ffmpeg, asr: null }
    return {
      asrReady: true,
      ffmpeg,
      asr: {
        transcribeFor: (row: VideoRow) => {
          // 样本都应是已下载的视频；缺本地文件就没法抽音轨，直接报错让 classifyAuthor 跳过该样本
          if (!row.local_path) throw new Error(`视频缺少本地文件，无法转写: ${row.aweme_id}`)
          return transcribeFor(db, { aweme_id: row.aweme_id, local_path: row.local_path }, {
            ffmpeg,
            models: { model: pathFor('model'), tokens: pathFor('tokens'), vad: pathFor('vad') },
            maxSec: getSettings().asrMaxSec ?? 90
          })
        }
      }
    }
  }

  // Task14：重建 Organizer。resolveCategory 走「视听分类」→ 失败回退作者已有 category。
  // analyzer 与 asr 就绪状态实时读取，settings:save 后重建即可让全部变化生效（含 downloadDir）。
  function reloadOrganizer(): void {
    const s = getSettings()
    const resolveCategory: ResolveCategoryFn = async (author, samples) => {
      if (analyzer) {
        const { asrReady, ffmpeg: f, asr } = buildAsrDeps()
        if (asrReady) {
          const c = await classifyAuthor(author, samples, { analyzer, asr, ffmpeg: f })
          if (c) return c
        }
      }
      return author.category ?? null
    }
    // 归档层级来自设置；设置保存会调 reloadOrganizer，改完不用重启即生效
    organizer = new Organizer({
      db, downloadDir: s.downloadDir,
      levels: {
        category: s.organizeByCategory,
        author: s.organizeByAuthor,
        orientation: s.organizeByOrientation,
        duration: s.organizeByDuration
      },
      resolveCategory
    })
    scheduler?.updateOrganizer(organizer)
  }

  reloadOrganizer() // 先建实例；此刻 scheduler 尚为 null，updateOrganizer 无副作用

  scheduler = new Scheduler({
    db, browser, analyzer, downloader,
    emit: push,
    // T2/Task4：滚动参数（含 scrollIntervalMs）由 scheduler 每次 run 现读（设置保存即生效，无需重启；
    // 此前 scrollIntervalMs 在此处构造时读死，改设置不重启不生效，与本注释描述的行为不一致，Task4 修正）
    getScrollParams: () => {
      const s = getSettings()
      return { scrollSpeed: s.scrollSpeed, scrollPageWaitMs: s.scrollPageWaitMs, scrollIntervalMs: s.scrollIntervalMs }
    },
    // R11：停滞阈值由 scheduler 每次 run 现读（设置保存即生效，无需重启）
    getStallThresholdSec: () => getSettings().stallThresholdSec ?? 25,
    organizer,
    organizeDebounceMs: settings.organizeDebounceMs ?? 5000,
    // R12：停滞自救全链路日志（停滞检测/到底命中/重搜冷却/重搜计数）：汇入 rawLog 面板（与 platform:raw 拦截日志同列展示）
    onFilterLog: pushFilterLog
  })

  registerIpc({
    db, scheduler, downloader, analyzer, browser,
    getWindow: () => win!,
    reloadAnalyzer,
    reloadOrganizer,
    getOrganizer: () => organizer,
    enqueueTask,
    dequeueTask,
    setBrowserVisible
  })

  // 内嵌浏览器默认加载抖音首页（此前只创建视图未加载，导致「内置浏览器」标签空白）。
  // 窗口不再预先 init：load 时按目标平台创建，分区/标题都跟着平台走。
  void browser.load(douyinAdapter, douyinAdapter.homeUrl)
  downloader.onEvent(e => push(e))

  // 断点续传：running→paused；downloading→pending，与已有 pending 一起重新入队
  const running = db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: number }>
  for (const t of running) db.prepare("UPDATE tasks SET status='paused', error='interrupted' WHERE id=?").run(t.id)
  recoverPendingVideos(db, id => downloader!.enqueue(id))
  // R11-3：遗留 pending 任务重新入队——内存 FIFO 重启即空，不恢复则旧任务永远没人启动（卡「等待」）
  enqueuePendingTasks(db, enqueueTask)
  downloader.start()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// 调试：记录最近收到的 platform:raw（URL + 是否处理 + 解析出几条/过滤剩几条 + 0 时长诊断）+ 停滞自救全链路日志，
// 供界面"查看拦截日志"查看（自救日志条目无 url/handled，带 filterLog 字段）
const rawLog: Array<{
  at: string
  url?: string
  handled?: boolean
  stats?: { items: number; kept: number }
  /** 该批有解析成功但时长取不到的条目（只标记，不影响解析流程） */
  durationZero?: boolean
  /** 0 时长条目（取第一条）的顶层字段名列表，供实跑对照真实接口字段位置 */
  topKeys?: string[]
  /** R12：停滞自救全链路日志行（停滞检测/到底命中/重搜冷却/重搜计数），渲染层展示 */
  filterLog?: string
}> = []

/** R12：停滞自救全链路日志逐行入 rawLog，与 platform:raw 拦截日志同面板展示 */
function pushFilterLog(msg: string): void {
  rawLog.push({ at: new Date().toISOString().slice(11, 19), filterLog: msg })
  if (rawLog.length > 60) rawLog.shift()
  // R14：同步打到主进程终端。rawLog 只在界面面板可见，排查真机问题时终端看不到自救链路，
  // 定位全靠用户截图；这里补一条，dev 下直接跟着日志走。
  console.log('[自救]', msg)
}
ipcMain.on('platform:raw', async (_e, msg) => {
  const url = String(msg?.url ?? '')
  const json = msg?.json
  // 适配器取自当前活动浏览器窗口，不写死抖音，也不靠 URL 去遍历所有适配器——
  // 快手与后续平台可能共用 /graphql 这类通用路径，只凭 URL 会认错平台。
  const adapter = browser?.adapter ?? null
  const handled = !!adapter && adapter.apiUrlPatterns.some(r => r.test(url))
  let stats: { items: number; kept: number } | null = null
  if (handled && adapter) stats = (await scheduler?.handleRaw(adapter, url, json)) ?? null
  // 0 时长诊断：parseApiJson 暂存的诊断同步取走（取走即清空）
  const diags = drainDurationDiags()
  const durationZero = diags.length > 0
  rawLog.push({
    at: new Date().toISOString().slice(11, 19), url: url.slice(0, 120), handled,
    stats: stats ?? undefined,
    durationZero: durationZero || undefined,
    topKeys: durationZero ? diags[0].topKeys : undefined
  })
  if (rawLog.length > 60) rawLog.shift()
  // R14：拦截结果同步打终端（与 [自救] 同理，排查真机「一条没抓到」时要区分
  // 「钩子没拦到接口」和「拦到了但解析/过滤掉了」——只看界面面板定位不了）
  console.log('[拦截]', handled ? '命中' : '忽略', url.slice(0, 100), stats ? `解析${stats.items}→留${stats.kept}` : '')
})
ipcMain.handle('debug:rawLog', () => rawLog.slice(-60))

// 退出前销毁浏览器子窗口：否则 close→hide 拦截让 quit 被 preventDefault 中止、window-all-closed 也因隐藏子窗口永不触发
app.on('before-quit', () => browser?.dispose())

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
