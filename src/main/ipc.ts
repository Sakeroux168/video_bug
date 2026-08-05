import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { unlink } from 'fs/promises'
import { createTask, listTasks, listVideos, listAuthors, setTaskStatus, setVideoStatus, updateAuthorCategory, deleteAuthors, taskStats, recomputeAuthorCounts } from './db'
import { isPathInside } from './pathSafety'
import { getSettings, saveSettings } from './settings'
import { listAdapters } from './adapters'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { status as modelsStatus, ensureModels } from './asr/models'
import type { EnsureProgress } from './asr/models'

export interface IpcDeps {
  db: DatabaseSync
  scheduler: Scheduler
  downloader: Downloader
  analyzer: Analyzer | null
  browser: VideoBrowser
  getWindow: () => BrowserWindow
  /** 设置保存后重建 Analyzer（AI 配置热加载） */
  reloadAnalyzer: () => void
  /** Task14：设置保存后重建 Organizer（downloadDir / ASR 就绪状态热更新） */
  reloadOrganizer: () => void
  /** 取当前整理器实例（settings:save 后可能被重建，IPC 一律走 getter 拿最新） */
  getOrganizer: () => Organizer | null
  /** 把新建任务投入 FIFO 队列（串行执行，去重） */
  enqueueTask: (id: number) => void
  /** 渲染层切换浏览器标签时通知主进程（主进程据此结合任务状态决定显示/小窗/隐藏） */
  setBrowserVisible: (v: boolean) => void
}

export function registerIpc(deps: IpcDeps): void {
  const { db, scheduler, downloader, browser } = deps

  ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
  ipcMain.handle('platforms:list', () => listAdapters())

  ipcMain.handle('task:create', (_e, input: Parameters<typeof createTask>[1]) => {
    // 作者去重：仅当该作者的"主页爬取"任务已完成才跳过（作者在搜索里出现过不算爬过主页）。
    // 允许重复：任务级 allowDuplicateAuthor 覆盖全局设置；未指定时回退到全局"允许重复爬取作者"。
    if (input.type === 'author' && !(input.allowDuplicateAuthor ?? getSettings().allowDuplicateAuthor)) {
      const done = db.prepare("SELECT id FROM tasks WHERE type='author' AND query=? AND status='done' LIMIT 1")
        .get(input.query) as { id: number } | undefined
      if (done) return { id: null, skipped: true, reason: '该作者主页已爬取过，可在作者表格中直接管理' }
    }
    const id = createTask(db, input)
    deps.enqueueTask(id)
    return { id, skipped: false }
  })

  ipcMain.handle('task:list', () => listTasks(db))
  ipcMain.handle('task:video:list', (_e, taskId: number) => listVideos(db, taskId))
  ipcMain.handle('task:stats', (_e, taskId: number) => taskStats(db, taskId))
  // A1：先等 scheduler.pause()（run 完全退出）再置状态，避免渲染层立刻看到 paused 而 run 还在收尾
  ipcMain.handle('task:pause', async (_e, id: number) => { await scheduler.pause(); setTaskStatus(db, id, 'paused', 'user') })
  // A1：走 scheduler.resume（内含 run 退出守卫，并发 resume 不会被 running 挡回静默丢弃）
  ipcMain.handle('task:resume', (_e, id: number) => { void scheduler.resume(id) })
  ipcMain.handle('task:delete', (_e, id: number) => { db.prepare('DELETE FROM videos WHERE task_id=?').run(id); db.prepare('DELETE FROM tasks WHERE id=?').run(id) })

  ipcMain.handle('video:retry', (_e, ids: number[]) => {
    for (const id of ids) {
      setVideoStatus(db, id, 'pending', { error: null })
      downloader.enqueue(id)
    }
    return true
  })

  // Task3：程序内删除视频（③）——查 local_path → 路径安全则删本地文件（ENOENT 忽略）→ 删 DB 行 →
  // 受影响作者 video_count 重算。单条 unlink 失败返回错误信息但不中断整批；任何状态都能删。
  ipcMain.handle('video:delete', async (_e, ids: number[]) => {
    try {
      const downloadDir = getSettings().downloadDir
      const authorIds: number[] = []
      const errors: string[] = []
      let deleted = 0
      for (const id of ids) {
        const row = db.prepare('SELECT author_id, local_path FROM videos WHERE id = ?')
          .get(id) as { author_id: number | null; local_path: string | null } | undefined
        if (!row) continue
        if (row.author_id != null) authorIds.push(row.author_id)
        if (row.local_path) {
          // 路径防护：只允许删 downloadDir 下的文件（删除请求只来自受信渲染层，防御性校验照做）
          if (!isPathInside(downloadDir, row.local_path)) continue
          try {
            await unlink(row.local_path)
          } catch (err) {
            // ENOENT：文件已被移走/删除，忽略继续删 DB 行；其它错误：报错并保留 DB 行（文件未删，可重试）
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              errors.push(`删除文件失败 ${row.local_path}：${String(err)}`)
              continue
            }
          }
        }
        db.prepare('DELETE FROM videos WHERE id = ?').run(id)
        deleted++
      }
      recomputeAuthorCounts(db, authorIds)
      if (errors.length) return { ok: false, error: errors.join('；'), deleted }
      return { ok: true, deleted }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 全局下载控制：暂停（在途任务跑完，不再拉新）/ 恢复 / 查询暂停状态
  ipcMain.handle('download:pause', () => { downloader.pause(); return true })
  ipcMain.handle('download:resume', () => { downloader.resume(); return true })
  ipcMain.handle('download:state', () => ({ paused: downloader.isPaused() }))

  // 手动下载（collected/cancelled/failed → pending 并入队）与取消（在途 abort / 排队移出）
  ipcMain.handle('video:download', (_e, ids: number[]) => { downloader.download(ids); return true })
  ipcMain.handle('video:cancel', (_e, ids: number[]) => { downloader.cancel(ids); return true })
  // 单条暂停/继续（paused 状态：在途中断、排队出队；继续 = paused → pending 重新入队）
  ipcMain.handle('video:pause', (_e, ids: number[]) => { downloader.pauseVideo(ids); return true })
  ipcMain.handle('video:resume', (_e, ids: number[]) => { downloader.resumeVideo(ids); return true })

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
    // Task14: 下载目录 / ASR 就绪状态变化 → 重建 Organizer（resolveCategory 实时读 asr/analyzer）
    deps.reloadOrganizer()
    deps.downloader.updateSettings(s)
  })

  // Task14：手动整理单个作者 → 归档其已下载视频到 {品类}/{作者}；organizeAll 类似但批量
  ipcMain.handle('authors:organize', async (_e, authorId: number) => {
    const org = deps.getOrganizer()
    if (!org) return { ok: false, error: '整理器未就绪' }
    try {
      const r = await org.organizeAuthor(authorId)
      return { ok: true, moved: r.moved, category: r.category, state: r.state }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('organize:all', async () => {
    const org = deps.getOrganizer()
    if (!org) return { ok: false, error: '整理器未就绪' }
    try {
      const count = await org.organizeAll()
      return { ok: true, count }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // Task14：ASR 模型状态查询 + 下载（进度经 evt:asr:progress 透传，设置面板画进度条）
  ipcMain.handle('asr:status', () => modelsStatus())
  ipcMain.handle('asr:download', async () => {
    try {
      const r = await ensureModels({
        onProgress: (p: EnsureProgress) => {
          deps.getWindow().webContents.send('evt:asr:progress', p)
        }
      })
      return { ok: true, ready: r.ready, downloaded: r.downloaded }
    } catch (err) { return { ok: false, error: String(err) } }
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
  ipcMain.handle('browser:devtools', () => browser.openDevTools())

  // 选择下载目录（#1）
  ipcMain.handle('dialog:pickDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(deps.getWindow(), {
      title: '选择下载目录', properties: ['openDirectory', 'createDirectory']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })
  // 在系统文件管理器中打开某个目录（#8）
  ipcMain.handle('dialog:openDir', (_e, p: string) => { void shell.openPath(p) })
  // 定位已下载的视频文件（在资源管理器中选中该文件）
  ipcMain.handle('video:locate', (_e, p: string) => { if (p) shell.showItemInFolder(p) })
}
