import { app, BrowserWindow, ipcMain, net, protocol, shell, type Tray } from 'electron'
import { pathToFileURL } from 'url'
import { coverFileFor } from './library'
import { allowedPermission, isAppUrl, logUrl } from './security'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { initDb, tuneDb } from './db'
import { VideoBrowser } from './browser'
import { Scheduler } from './scheduler'
import { Downloader } from './downloader'
import { VideoProcessor } from './videoProcessor'
import { Analyzer } from './analyzer'
import { Organizer } from './organizer'
import type { ResolveCategoryFn } from './organizer'
import { registerIpc } from './ipc'
import { installDownloadFallback } from './csvExport'
import { enqueuePendingTasks, recoverPendingVideos } from './recovery'
import { getSettings } from './settings'
import { douyinAdapter, drainDurationDiags } from './adapters/douyin'
import { getAdapter } from './adapters'
import { classifyAuthor } from './ai/organizer-ai'
import { transcribeFor } from './asr/asr'
import type { Transcript } from './asr/asr'
import { status as asrStatus, pathFor } from './asr/models'
import { findFfmpeg } from './asr/media'
import { startBridge, DEFAULT_BRIDGE_PORT } from './bridge'
import { TaskQueue } from './taskQueue'
import { onBeforeQuit } from './shutdown'
import { AutoFollowTimer, FollowTracker, Notifier, loginItemFor, noticeForEvent, platformNameOf, runAutoFollow, startHidden, taskLabel, type AutoFollowResult, type Notice } from './automation'
import { loadAutomationState, saveAutomationState } from './automationState'
import { createTray, showNotice, windowInFront } from './desktop'
import type { Server } from 'http'
import type { VideoRow } from '../shared/types'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
let downloader: Downloader | null = null
let processor: VideoProcessor | null = null
let scheduler: Scheduler | null = null
let analyzer: Analyzer | null = null
let organizer: Organizer | null = null
let taskRunning = false
let bridge: Server | null = null
let browserShown = false
let forceBrowserFull = false
/** push() 里查任务所属平台用（库在 whenReady 里才打开） */
let dbRef: DatabaseSync | null = null
// 2026-10-07 自动化：托盘、系统通知、定时追更
let tray: Tray | null = null
/** 真的要退出了（托盘「退出」、系统关机等）：关窗口不再缩到托盘 */
let quitting = false
let trayHintShown = false
const notifier = new Notifier({ show: n => showNotice(n, () => win) })
const followTracker = new FollowTracker()

/** 开了通知、窗口不在前台时才弹 */
function notify(n: Notice): void {
  if (getSettings().notifyEnabled === false || windowInFront(win)) return
  notifier.notify(n)
}

/** 任务结束 / 暂停 → 系统通知；定时追更那批各自抓完不单独弹，最后弹一条汇总 */
function notifyTaskEvent(evt: { type?: string; taskId?: number; fetched?: number; reason?: string }): void {
  if (!dbRef || (evt.type !== 'task:done' && evt.type !== 'task:paused') || evt.taskId === undefined) return
  const owned = followTracker.owns(evt.taskId)
  const summary = followTracker.onEvent({ ...evt, type: evt.type })
  if (!(owned && evt.type === 'task:done')) {
    const n = noticeForEvent({ ...evt, type: evt.type }, { label: taskLabel(dbRef, evt.taskId), platformName: platformNameOf(dbRef, evt.taskId) })
    if (n) notify(n)
  }
  if (summary) notify(summary)
}

/** 开机自动启动：按设置写 / 撤系统启动项（开发版不碰）。启动时和保存设置后各调一次 */
function applyLoginItem(): void {
  if (process.platform !== 'win32') return
  const item = loginItemFor(getSettings().openAtLogin === true, {
    isPackaged: app.isPackaged, execPath: process.execPath, portableFile: process.env['PORTABLE_EXECUTABLE_FILE']
  })
  if (!item) return
  try { app.setLoginItemSettings(item) } catch (e) { console.error('[开机启动] 设置失败：', e) }
}

/** 追更一次（定时器到点、托盘菜单、设置页按钮都走这里）；结果记下来给设置页显示 */
function followNow(manual: boolean): AutoFollowResult | null {
  if (!dbRef) return null
  const count = Math.min(200, Math.max(1, Math.floor(Number(getSettings().autoFollowCount) || 20)))
  const r = runAutoFollow(dbRef, enqueueTask, { count, scope: getSettings().autoFollowScope === 'picked' ? 'picked' : 'all' })
  followTracker.start(r.taskIds)
  saveAutomationState({ lastResult: { at: new Date().toISOString(), manual, authors: r.authors, created: r.created, skipped: r.skipped } })
  return r
}

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

// I4 简单 FIFO 任务队列：串行执行，任务终态后自动出队跑下一个；去重防同一任务重复入队。
// R20：挪到 taskQueue.ts——任务**不管怎么结束**（完成/暂停/失败/卡住）都放行下一个，验证码暂停除外。
const taskQueue = new TaskQueue({
  isRunning: () => Boolean(scheduler?.isRunning),
  run: id => scheduler ? scheduler.run(id) : Promise.resolve(),
  log: msg => {
    console.error(`[任务] ${msg}`)
    pushFilterLog(msg)
  }
})

/** I3 根据当前设置重建 Analyzer（settings:save 后调用，让 AI 配置即时生效） */
function reloadAnalyzer(): void {
  const s = getSettings()
  analyzer = s.aiApiKey ? new Analyzer(s) : null
}

function enqueueTask(id: number): void { taskQueue.enqueue(id) }

/** 把任务从队列里摘掉（删任务用）。已经开跑的不在队列里，由调度器那边叫停。 */
function dequeueTask(id: number): void { taskQueue.remove(id) }

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, title: '视频爬取工具',
    // 开机自动启动时带 --hidden：只挂托盘，点托盘图标再打开
    show: !startHidden(process.argv),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
  })
  installDownloadFallback(win.webContents, () => app.getPath('downloads'))
  // 安全检查 A3：主界面只该显示自己的页面。外部链接交给系统浏览器，不在本程序里开新窗口、也不跳走。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(allowedPermission(permission)))
  // C-1：非 macOS 点×关主窗口必须确定退出。子窗口(抖音视图)的 close 被拦截成 hide，
  // 若不先 dispose，window-all-closed 永不触发、app 不退出、进程挂后台。关窗前先销毁子窗口。
  // createWindow 时 browser 模块变量尚为 null，用闭包引用模块级 browser —— 用户关窗时已赋值；dispose 幂等。
  // macOS 保留现状：window-all-closed 不退出、Cmd+Q 走 before-quit。
  win.on('close', e => {
    // 2026-10-07：开了「关窗口缩到托盘」→ 只藏起来，程序在后台继续跑；第一次藏的时候说一声去哪找
    if (!quitting && tray && process.platform !== 'darwin' && getSettings().closeToTray) {
      e.preventDefault()
      win?.hide()
      if (browserShown) setBrowserVisible(false)
      if (!trayHintShown) {
        trayHintShown = true
        notifier.notify({ title: '程序还在后台运行', body: '点右下角托盘图标可以打开；要退出就右键托盘图标点「退出」' })
      }
      return
    }
    if (process.platform !== 'darwin') browser?.dispose()
  })
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
  // D8：下载进度单独一条通道——每秒都有，走任务通道会让任务列表 / 概览 / 作者页跟着反复重拉
  if (t?.type === 'video:progress') {
    win?.webContents.send('evt:download:progress', t)
    return
  }
  win?.webContents.send('evt:task:progress', evt)
  // R20：队列据此判断当前任务是否结束（完成/暂停/失败/卡住都放行下一个；验证码暂停按住）
  taskQueue.onEvent(evt)
  if (t) notifyTaskEvent(t)
  if (t) {
    if (t.type === 'task:progress' && t.status === 'running') {
      taskRunning = true
      browser?.setBusy(true) // F7：任务进行中才关后台节流
      forceBrowserFull = false
      updateBrowserDisplay()
    }
    if (t.type === 'task:done') {
      taskRunning = false
      browser?.setBusy(false)
      forceBrowserFull = false
      updateBrowserDisplay()
    }
    if (t.type === 'task:paused') {
      taskRunning = false
      browser?.setBusy(false)
      if (t.reason === 'login_required') {
        // D6：状态灯跟着变成「未登录」（以前任务写没登录、状态灯还写未知）
        const row = dbRef?.prepare('SELECT platform FROM tasks WHERE id = ?').get((evt as { taskId?: number }).taskId ?? 0) as { platform?: string } | undefined
        const adapter = row?.platform ? getAdapter(row.platform) : undefined
        if (adapter) void browser?.noteLoggedOut(adapter)
      }
      if (t.reason === 'stalled_verify' || t.reason === 'login_required') {
        // 登录/验证暂停均显示当前平台窗口。验证码沿用队列按住规则，登录沿用现有队列规则。
        forceBrowserFull = true
        updateBrowserDisplay()
        win?.webContents.send('evt:task:notice', {
          type: t.reason, text: t.reason === 'login_required' ? '当前平台没登录，请在浏览器登录后点「继续」' : '当前平台需要验证，请在浏览器完成验证后点「继续」'
        })
      } else {
        updateBrowserDisplay()
      }
    }
  }
}

// 安全检查 A6：只允许开一个程序（按数据目录区分）。以前双击两次就有两个程序同时写同一个数据库、抢同一个登录档案；
// 现在第二次打开只把已经开着的窗口调到前面。
// 素材库封面：vs-cover://video/<视频id>。只按 id 从库里找封面（界面传不进任意路径），
// 只注册在主窗口用的默认会话上，平台网页（各自的分区）用不了。必须在 ready 之前声明。
protocol.registerSchemesAsPrivileged([{ scheme: 'vs-cover', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  const db = new DatabaseSync(join(app.getPath('userData'), 'scraper.db'))
  tuneDb(db) // WAL + NORMAL：写库快几十倍（性能检查 F2）
  initDb(db)
  dbRef = db
  protocol.handle('vs-cover', req => {
    const id = Number(new URL(req.url).pathname.replace(/^\/+/, ''))
    const file = Number.isInteger(id) ? coverFileFor(db, id) : null
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 })
  })

  createWindow()

  const settings = getSettings()
  reloadAnalyzer()
  downloader = new Downloader(db, settings)
  // 「视频处理」页：统一分辨率批处理，每次状态变化把完整快照推给渲染层。
  // 替换成功的文件若在库里有记录，把备份路径与新尺寸回写，归档/删除才能继续把 .original.mp4 成对带走。
  processor = new VideoProcessor({
    onChange: s => win?.webContents.send('evt:process:state', s),
    onReplaced: ({ path, backup, target }) => {
      db.prepare('UPDATE videos SET original_path=?, video_width=?, video_height=? WHERE local_path=?')
        .run(backup, target.width, target.height, path)
    }
  })
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
        keyword: s.organizeByKeyword,
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
    // R20：卡住判定分钟数（看门狗），每次 run 现读
    getStuckTimeoutMin: () => getSettings().stuckTimeoutMin ?? 5,
    organizer,
    organizeDebounceMs: settings.organizeDebounceMs ?? 5000,
    // R12：停滞自救全链路日志（停滞检测/到底命中/重搜冷却/重搜计数）：汇入 rawLog 面板（与 platform:raw 拦截日志同列展示）
    onFilterLog: pushFilterLog
  })

  registerIpc({
    db, scheduler, downloader, processor, analyzer, browser,
    getWindow: () => win!,
    reloadAnalyzer,
    reloadOrganizer,
    getOrganizer: () => organizer,
    enqueueTask,
    dequeueTask,
    kickQueue: () => taskQueue.kick(),
    setBrowserVisible,
    followNow: () => followNow(true),
    applyLoginItem
  })

  // 2026-10-07 自动化：托盘一直在；每分钟看一眼该不该定时追更（错过了点开机补跑一次）
  applyLoginItem()
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.local.video-scraper' : process.execPath)
  tray = createTray({
    getWindow: () => win,
    onFollowNow: () => {
      const r = followNow(true)
      if (r) notifier.notify(r.created ? { title: '开始追更', body: `给 ${r.created} 个作者建了追更任务，抓完会再告诉你` } : { title: '没有要追更的作者', body: '先在「作者收藏」里爬一次作者主页' })
    },
    onQuit: () => { quitting = true; app.quit() }
  })
  new AutoFollowTimer({
    getSchedule: () => getSettings(),
    getLastRun: () => loadAutomationState().lastFollowAt,
    setLastRun: iso => saveAutomationState({ lastFollowAt: iso }),
    run: async () => {
      const r = followNow(false)
      if (r?.created) notify({ title: '开始定时追更', body: `给 ${r.created} 个作者建了追更任务，抓完会再告诉你` })
    }
  }).start()

  // R18：本机 HTTP 口（127.0.0.1），百家号发布助手用它下「爬某作者主页 N 条」的任务；端口被占只打日志
  if (settings.bridgeEnabled !== false) {
    void startBridge({
      db, enqueueTask, isRunning: () => Boolean(scheduler?.isRunning),
      port: Number(settings.bridgePort) || DEFAULT_BRIDGE_PORT,
      getSettings
    }).then(r => { bridge = r?.server ?? null })
  }

  // 内嵌浏览器默认加载抖音首页（此前只创建视图未加载，导致「内置浏览器」标签空白）。
  // 窗口不再预先 init：load 时按目标平台创建，分区/标题都跟着平台走。
  // 落地页失败不能变成未处理拒绝：Node 22 默认会因此终止进程，
  // 而首页加载失败（网络波动、平台风控）是常事，程序本身应该照常可用。
  void browser.load(douyinAdapter, douyinAdapter.homeUrl).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[启动] 默认落地页加载失败（不影响使用，可在「内置浏览器」页重开）：${detail}`)
  })
  downloader.onEvent(e => push(e))

  // 断点续传：running→paused；downloading→pending，与已有 pending 一起重新入队
  const running = db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: number }>
  for (const t of running) db.prepare("UPDATE tasks SET status='paused', error='interrupted' WHERE id=?").run(t.id)
  recoverPendingVideos(db, id => downloader!.enqueue(id))
  // 清掉上次退出时留下的半截文件（分段残片等）；正在下的会自动跳过
  void downloader.sweepOrphanParts().then(n => { if (n > 0) console.log(`[启动] 清理了 ${n} 个下载残留文件`) })
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
    at: new Date().toISOString().slice(11, 19), url: logUrl(url).slice(0, 160), handled,
    stats: stats ?? undefined,
    durationZero: durationZero || undefined,
    topKeys: durationZero ? diags[0].topKeys : undefined
  })
  if (rawLog.length > 60) rawLog.shift()
  // R14：拦截结果同步打终端（与 [自救] 同理，排查真机「一条没抓到」时要区分
  // 「钩子没拦到接口」和「拦到了但解析/过滤掉了」——只看界面面板定位不了）
  console.log('[拦截]', handled ? '命中' : '忽略', logUrl(url).slice(0, 160), stats ? `解析${stats.items}→留${stats.kept}` : '')
})
ipcMain.handle('debug:rawLog', () => rawLog.slice(-60))

// 退出前：停视频处理（ffmpeg）、销毁浏览器子窗口、关本机接口（见 shutdown.ts）
app.on('before-quit', () => { quitting = true; onBeforeQuit({ processor, browser, bridge }); bridge = null; tray?.destroy(); tray = null })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
