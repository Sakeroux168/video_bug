import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { createTask, listTasks, listVideos, listAuthors, setTaskStatus, setVideoStatus, updateAuthorCategory, deleteAuthors, taskStats } from './db'
import { getSettings, saveSettings } from './settings'
import { deleteVideoRows } from './videoDelete'
import { scanFilesTree, deleteFileCategory, deleteFileAuthor } from './fileManager'
import { listAdapters } from './adapters'
import { FILTER_SELECTORS } from './adapters/douyin'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { status as modelsStatus, ensureModels } from './asr/models'
import type { EnsureProgress } from './asr/models'
import type { Filters, TaskRow } from '../shared/types'

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
  /** 筛选续爬全链路日志入 rawLog 面板（scheduler 自动触发与「手动测试筛选」共用） */
  pushFilterLog: (msg: string) => void
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

  // Task3：程序内删除视频（③）——编排在 videoDelete.ts（先 cancel 在途/排队项防孤儿文件 →
  // 路径安全则删本地文件 → 删 DB 行 → 作者 video_count 重算）；单条失败返回错误但不中断整批。
  ipcMain.handle('video:delete', (_e, ids: number[]) =>
    deleteVideoRows({ db, downloader, downloadDir: getSettings().downloadDir }, ids)
  )

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

  // 手动测试筛选：取当前最近一个 running/paused 且启用 douyinFilter 的 keyword 任务，
  // 直接执行一次筛选流程（复用 browser.applyDouyinFilter，与自动触发同路径），日志逐行进 rawLog 面板
  ipcMain.handle('debug:testFilter', async () => {
    const rows = db
      .prepare("SELECT * FROM tasks WHERE type='keyword' AND status IN ('running','paused') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id DESC")
      .all() as unknown as TaskRow[]
    const row = rows.find(r => {
      try { const f = JSON.parse(r.filters) as Filters; return !!f.douyinFilter?.enabled } catch { return false }
    })
    if (!row) {
      deps.pushFilterLog('手动测试筛选：无可用任务（需 keyword 类型 + 启用筛选 + 状态为运行中/已暂停）')
      return { ok: false, message: '无可用任务：需要 keyword 类型、启用筛选、且状态为运行中或已暂停' }
    }
    let df: Filters['douyinFilter']
    try { df = (JSON.parse(row.filters) as Filters).douyinFilter } catch (err) {
      deps.pushFilterLog(`手动测试筛选：任务 #${row.id} 的筛选配置解析失败（${String(err)}）`)
      return { ok: false, message: `任务 #${row.id} 的筛选配置解析失败` }
    }
    if (!df?.enabled) {
      deps.pushFilterLog(`手动测试筛选：任务 #${row.id} 未启用筛选，跳过`)
      return { ok: false, message: `任务 #${row.id} 未启用筛选` }
    }
    deps.pushFilterLog(`手动测试筛选：任务 #${row.id}（${row.query}）开始执行`)
    try {
      const ok = await browser.applyDouyinFilter(FILTER_SELECTORS, df, deps.pushFilterLog)
      deps.pushFilterLog(`手动测试筛选：执行结果 → ${ok ? '成功' : '失败'}`)
      return { ok, message: ok ? '筛选执行成功，详见「查看拦截日志」' : '筛选执行失败，详见「查看拦截日志」' }
    } catch (err) {
      deps.pushFilterLog(`手动测试筛选：执行异常 → 失败（${String(err)}）`)
      return { ok: false, message: `筛选执行异常：${String(err)}` }
    }
  })

  // Task4：文件管理——扫描下载目录（品类/作者/视频）+ 递归删除品类/作者（路径防护 + DB 前缀联动）
  // downloadDir 每次取最新（设置可能已热更），扫描纯函数在主进程 fileManager.ts 中可单测
  ipcMain.handle('files:tree', () => scanFilesTree(getSettings().downloadDir))
  ipcMain.handle('files:deleteCategory', (_e, name: string) =>
    deleteFileCategory({ db, downloadDir: getSettings().downloadDir }, name)
  )
  ipcMain.handle('files:deleteAuthor', (_e, category: string, author: string) =>
    deleteFileAuthor({ db, downloadDir: getSettings().downloadDir }, category, author)
  )

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
