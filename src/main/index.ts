import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from './db'
import { VideoBrowser } from './browser'
import { Scheduler } from './scheduler'
import { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import { Organizer } from './organizer'
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
let forceBrowserFull = false

/** 根据任务状态与用户所在标签决定抖音窗口显示方式：
 *  任务运行中 / 验证暂停 → 显示独立抖音窗口（不盖管理面板，可拖走）；
 *  无任务 → 仅在用户切到浏览器标签时显示 */
function updateBrowserDisplay(): void {
  if (!browser) return
  if (taskRunning || forceBrowserFull) browser.setVisible(true)
  else browser.setVisible(browserShown)
}

function setBrowserVisible(v: boolean): void {
  browserShown = v
  if (v) forceBrowserFull = false // 用户主动切到浏览器标签，解除强制全屏
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
        // 触发验证：显示并聚焦独立抖音窗口让用户过验证，并提示；不自动放行下一个任务
        forceBrowserFull = true
        updateBrowserDisplay()
        browser?.focus()
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
  browser = new VideoBrowser(win!, (url, json) => {
    if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) {
      void scheduler?.handleRaw(douyinAdapter, url, json)
    }
  })

  scheduler = new Scheduler({
    db, browser, analyzer, downloader,
    emit: push,
    scrollIntervalMs: settings.scrollIntervalMs,
    organizer: new Organizer({
      db,
      downloadDir: settings.downloadDir,
      // Task5 桥接：AI 可用时按作者代表性视频分类，否则回退「未分类」（作者级分类在 Task13 完善）
      resolveCategory: async (author, samples) => {
        if (!analyzer) return null
        const sample = samples[0]
        if (!sample) return null
        const text = `${sample.title}\n作者:${author.nickname}\n时长:${sample.duration}s`
        try {
          const r = await analyzer.classify(text, `author:${author.id}:organize`)
          return r.category || null
        } catch { return null }
      }
    }),
    organizeDebounceMs: settings.organizeDebounceMs ?? 5000
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

  // 断点续传：running→paused；downloading→pending，与已有 pending 一起重新入队
  const running = db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: number }>
  for (const t of running) db.prepare("UPDATE tasks SET status='paused', error='interrupted' WHERE id=?").run(t.id)
  db.prepare("UPDATE videos SET status='pending' WHERE status='downloading'").run()
  const pend = db.prepare("SELECT id FROM videos WHERE status='pending'").all() as Array<{ id: number }>
  for (const v of pend) downloader.enqueue(v.id)
  downloader.start()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// 调试：记录最近收到的 dy:raw（URL + 是否处理 + 解析出几条/过滤剩几条），供界面"查看拦截日志"查看
const rawLog: Array<{ at: string; url: string; handled: boolean; stats?: { items: number; kept: number } }> = []
ipcMain.on('dy:raw', async (_e, msg) => {
  const url = String(msg?.url ?? '')
  const json = msg?.json
  const handled = douyinAdapter.apiUrlPatterns.some(r => r.test(url))
  let stats: { items: number; kept: number } | null = null
  if (handled) stats = (await scheduler?.handleRaw(douyinAdapter, url, json)) ?? null
  rawLog.push({ at: new Date().toISOString().slice(11, 19), url: url.slice(0, 120), handled, stats: stats ?? undefined })
  if (rawLog.length > 60) rawLog.shift()
})
ipcMain.handle('debug:rawLog', () => rawLog.slice(-60))

// 退出前销毁浏览器子窗口：否则 close→hide 拦截让 quit 被 preventDefault 中止、window-all-closed 也因隐藏子窗口永不触发
app.on('before-quit', () => browser?.dispose())

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
