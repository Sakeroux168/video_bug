import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from './db'
import { VideoBrowser } from './browser'
import { Scheduler } from './scheduler'
import { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import { registerIpc } from './ipc'
import { getSettings } from './settings'
import { douyinAdapter } from './adapters/douyin'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
let downloader: Downloader | null = null
let scheduler: Scheduler | null = null
let analyzer: Analyzer | null = null
let taskRunning = false
let browserShown = false
let pinPiP = false

/** 根据任务状态与用户所在标签决定内置浏览器显示方式：
 *  任务运行中 → 始终可见（用户在浏览器标签=全屏，否则右下角小窗保活，避免页面被隐藏导致加载更多不触发）；
 *  验证暂停 → 右下角小窗保持显示（pinPiP），方便用户看到验证界面；
 *  无任务 → 仅在浏览器标签时显示 */
function updateBrowserDisplay(): void {
  if (!browser) return
  if (taskRunning) {
    browser.setVisible(true)
    browser.setPiP(!browserShown)
  } else if (pinPiP) {
    browser.setVisible(true)
    browser.setPiP(true)
  } else {
    browser.setPiP(false)
    browser.setVisible(browserShown)
  }
}

function setBrowserVisible(v: boolean): void {
  browserShown = v
  if (v) pinPiP = false // 用户主动切到浏览器标签，取消钉住
  updateBrowserDisplay()
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, title: '视频爬取工具',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function push(evt: unknown): void {
  win?.webContents.send('evt:task:progress', evt)
  const t = evt as { type?: string; status?: string; reason?: string } | null
  if (t) {
    if (t.type === 'task:progress' && t.status === 'running') {
      taskRunning = true
      updateBrowserDisplay()
    }
    if (t.type === 'task:done') {
      taskRunning = false
      pinPiP = false
      updateBrowserDisplay()
      void dequeueAndRun() // 只有真正完成才放行下一个排队任务
    }
    if (t.type === 'task:paused') {
      taskRunning = false
      if (t.reason === 'stalled_verify') {
        // 触发验证：钉住右下角小窗显示验证界面，并提示用户；不自动放行下一个任务
        pinPiP = true
        updateBrowserDisplay()
        win?.webContents.send('evt:task:notice', {
          type: 'stalled_verify', text: '任务可能触发验证，请在右下角/内置浏览器完成验证后点「继续」'
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
  browser = new VideoBrowser(win!, (url, json) => {
    if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) {
      void scheduler?.handleRaw(douyinAdapter, url, json)
    }
  })

  scheduler = new Scheduler({
    db, browser, analyzer, downloader,
    emit: push,
    scrollIntervalMs: settings.scrollIntervalMs
  })

  registerIpc({
    db, scheduler, downloader, analyzer, browser,
    getWindow: () => win!,
    reloadAnalyzer,
    enqueueTask,
    setBrowserVisible
  })

  void browser.init().then(() => {
    // 内嵌浏览器默认加载抖音首页（此前只创建视图未加载，导致「内置浏览器」标签空白）
    void browser?.load(douyinAdapter, 'https://www.douyin.com/')
  })
  downloader.onEvent(e => push(e))

  // 断点续传：running→paused；pending 视频重新入队
  const running = db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: number }>
  for (const t of running) db.prepare("UPDATE tasks SET status='paused', error='interrupted' WHERE id=?").run(t.id)
  const pend = db.prepare("SELECT id FROM videos WHERE status='pending'").all() as Array<{ id: number }>
  for (const v of pend) downloader.enqueue(v.id)
  downloader.start()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// 调试：记录最近收到的 dy:raw（URL + 是否被处理），供界面"查看拦截日志"查看
const rawLog: Array<{ at: string; url: string; handled: boolean }> = []
ipcMain.on('dy:raw', (_e, msg) => {
  const url = String(msg?.url ?? '')
  const json = msg?.json
  const handled = douyinAdapter.apiUrlPatterns.some(r => r.test(url))
  rawLog.push({ at: new Date().toISOString().slice(11, 19), url: url.slice(0, 120), handled })
  if (rawLog.length > 60) rawLog.shift()
  if (handled) void scheduler?.handleRaw(douyinAdapter, url, json)
})
ipcMain.handle('debug:rawLog', () => rawLog.slice(-60))

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
