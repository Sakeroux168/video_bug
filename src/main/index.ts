import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })

function createWindow(): void {
  const win = new BrowserWindow({
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
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
