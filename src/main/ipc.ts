import { ipcMain, BrowserWindow } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { createTask, listTasks, listVideos, listAuthors, setTaskStatus, setVideoStatus } from './db'
import { getSettings, saveSettings } from './settings'
import { listAdapters } from './adapters'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import type { VideoBrowser } from './browser'

export interface IpcDeps {
  db: DatabaseSync
  scheduler: Scheduler
  downloader: Downloader
  analyzer: Analyzer | null
  browser: VideoBrowser
  getWindow: () => BrowserWindow
}

export function registerIpc(deps: IpcDeps): void {
  const { db, scheduler, downloader, browser } = deps

  ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
  ipcMain.handle('platforms:list', () => listAdapters())

  ipcMain.handle('task:create', (_e, input: Parameters<typeof createTask>[1]) => {
    const id = createTask(db, input)
    void scheduler.run(id)
    return id
  })

  ipcMain.handle('task:list', () => listTasks(db))
  ipcMain.handle('task:video:list', (_e, taskId: number) => listVideos(db, taskId))
  ipcMain.handle('task:pause', (_e, id: number) => { scheduler.pause(); setTaskStatus(db, id, 'paused', 'user') })
  ipcMain.handle('task:resume', (_e, id: number) => { void scheduler.run(id) })
  ipcMain.handle('task:delete', (_e, id: number) => { db.prepare('DELETE FROM videos WHERE task_id=?').run(id); db.prepare('DELETE FROM tasks WHERE id=?').run(id) })

  ipcMain.handle('video:retry', (_e, ids: number[]) => {
    for (const id of ids) {
      setVideoStatus(db, id, 'pending', { error: null })
      downloader.enqueue(id)
    }
    return true
  })

  ipcMain.handle('authors:list', () => listAuthors(db))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, s: Parameters<typeof saveSettings>[0]) => saveSettings(s))

  ipcMain.handle('ai:test', async () => {
    const s = getSettings()
    if (!s.aiApiKey || !s.aiBaseUrl) return { ok: false, error: '未配置 API Key' }
    const a = new Analyzer(s)
    try { await a.judgeFilter('测试', '总是通过', 'test') ; return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('browser:show', () => browser.setVisible(true))
  ipcMain.handle('browser:hide', () => browser.setVisible(false))
}
