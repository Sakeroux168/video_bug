import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { VideoBrowser } from './browser'
import { douyinAdapter } from './adapters/douyin'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
const rawLogs: Array<{ url: string }> = []

ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })

function handleRawJson(url: string, json: unknown): void {
  rawLogs.push({ url })
  console.log('[dy:raw] hit:', url, 'total:', rawLogs.length)
  // TODO(Task 11): 正式接线，这里先打日志验证挂钩生效
  win?.webContents.send('dbg:raw', { url, count: rawLogs.length })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200, height: 800, title: '视频爬取工具',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  browser = new VideoBrowser(win!, (url, json) => {
    if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) handleRawJson(url, json)
  })
  void browser.init().then(() => {
    if (browser) void browser.load(douyinAdapter, 'https://www.douyin.com/')
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

ipcMain.handle('browser:show', () => { browser?.setVisible(true) })
ipcMain.handle('browser:hide', () => { browser?.setVisible(false) })
ipcMain.handle('browser:scroll', () => browser?.scrollToBottom())
ipcMain.on('dy:raw', (_e, msg) => {
  const url = String(msg?.url ?? '')
  if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) handleRawJson(url, msg?.json)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
