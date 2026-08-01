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
}

app.whenReady().then(() => {
  const db = new DatabaseSync(join(app.getPath('userData'), 'scraper.db'))
  initDb(db)

  createWindow()

  const settings = getSettings()
  analyzer = settings.aiApiKey ? new Analyzer(settings) : null
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

  registerIpc({ db, scheduler, downloader, analyzer, browser, getWindow: () => win! })

  void browser.init()
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
