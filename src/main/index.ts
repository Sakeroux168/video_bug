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
  // 任务到达终态（done/paused）后放行下一个排队任务
  const t = evt as { type?: string } | null
  if (t && (t.type === 'task:done' || t.type === 'task:paused')) void dequeueAndRun()
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
    enqueueTask
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

ipcMain.on('dy:raw', (_e, msg) => {
  const url = String(msg?.url ?? '')
  const json = msg?.json
  if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) {
    void scheduler?.handleRaw(douyinAdapter, url, json)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
