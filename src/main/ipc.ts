import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { createTask, listTasks, listVideos, listAuthors, setTaskStatus, setVideoStatus, updateAuthorCategory, deleteAuthors } from './db'
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
  /** 设置保存后重建 Analyzer（AI 配置热加载） */
  reloadAnalyzer: () => void
  /** 把新建任务投入 FIFO 队列（串行执行，去重） */
  enqueueTask: (id: number) => void
  /** 渲染层切换浏览器标签时通知主进程（主进程据此结合任务状态决定显示/小窗/隐藏） */
  setBrowserVisible: (v: boolean) => void
}

export function registerIpc(deps: IpcDeps): void {
  const { db, scheduler, downloader } = deps

  ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
  ipcMain.handle('platforms:list', () => listAdapters())

  ipcMain.handle('task:create', (_e, input: Parameters<typeof createTask>[1]) => {
    // #5 重复作者不再爬取：作者已在库中则跳过
    if (input.type === 'author') {
      const existing = db.prepare('SELECT id FROM authors WHERE platform = ? AND sec_uid = ?')
        .get(input.platform, input.query) as { id: number } | undefined
      if (existing) return { id: null, skipped: true, reason: '该作者已爬取过，可在作者表格中直接管理' }
    }
    const id = createTask(db, input)
    deps.enqueueTask(id)
    return { id, skipped: false }
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
  ipcMain.handle('authors:updateCategory', (_e, id: number, category: string) => {
    updateAuthorCategory(db, id, category)
    return true
  })
  ipcMain.handle('authors:delete', (_e, ids: number[]) => { deleteAuthors(db, ids); return true })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, s: Parameters<typeof saveSettings>[0]) => {
    saveSettings(s)
    // I3: 保存后立即重建 Analyzer，下载参数热更新，无需重启程序
    deps.reloadAnalyzer()
    deps.downloader.updateSettings(s)
  })

  ipcMain.handle('ai:test', async () => {
    const s = getSettings()
    if (!s.aiApiKey || !s.aiBaseUrl) return { ok: false, error: '未配置 API Key' }
    const a = new Analyzer(s)
    try { await a.judgeFilter('测试', '总是通过', 'test') ; return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('browser:show', () => deps.setBrowserVisible(true))
  ipcMain.handle('browser:hide', () => deps.setBrowserVisible(false))

  // 选择下载目录（#1）
  ipcMain.handle('dialog:pickDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(deps.getWindow(), {
      title: '选择下载目录', properties: ['openDirectory', 'createDirectory']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })
  // 在系统文件管理器中打开某个目录（#8）
  ipcMain.handle('dialog:openDir', (_e, p: string) => { void shell.openPath(p) })
}
