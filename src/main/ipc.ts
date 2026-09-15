import { ipcMain, BrowserWindow, dialog, shell, clipboard } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { createTask, listTasks, listVideos, listDownloadedVideos, listAuthors, setTaskStatus, setVideoStatus, updateAuthorCategory, deleteAuthors, taskStats, insertAuthorIfAbsent, globalStats, recentDownloads } from './db'
import { getSettings, saveSettings } from './settings'
import { deleteVideoRows } from './videoDelete'
import { scanFilesTree, deleteFileDir, deleteFileVideo, locateFileDir, locateVideoFile } from './fileManager'
import { listAdapters, getAdapter } from './adapters'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import type { VideoProcessor } from './videoProcessor'
import { Analyzer } from './analyzer'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { status as modelsStatus, ensureModels } from './asr/models'
import type { EnsureProgress } from './asr/models'
import { resolveVideoSourceUrl } from './videoSource'

export interface IpcDeps {
  db: DatabaseSync
  scheduler: Scheduler
  downloader: Downloader
  /** 「视频处理」页的批处理器（统一分辨率），状态住在主进程，渲染层只发指令 */
  processor: VideoProcessor
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
  /** 把任务从 FIFO 队列里摘掉（删任务时用，避免轮到它时再跑一遍已删除的任务） */
  dequeueTask: (id: number) => void
  /** 放行队列里的下一个任务。dequeueAndRun 只在 task:done 时触发，
   *  删除运行中的任务走的是 pause()、不发事件，必须显式踢一脚。 */
  kickQueue: () => void
  /** 渲染层切换浏览器标签时通知主进程（主进程据此结合任务状态决定显示/小窗/隐藏） */
  setBrowserVisible: (v: boolean) => void
}

export function registerIpc(deps: IpcDeps): void {
  const { db, scheduler, downloader, browser } = deps

  ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
  ipcMain.handle('platforms:list', () => listAdapters())

  ipcMain.handle('task:create', (_e, rawInput: Parameters<typeof createTask>[1]) => {
    let input = rawInput
    // 接入中的平台（解析器还没按真机接口写）不能建任务。
    // 它仍然注册在平台表里，是为了让内置浏览器能打开它去扫码登录、抓真实接口；
    // 但放进建任务这一侧就成了「平台能选、任务跑不通」的半成品。
    const platformAdapter = getAdapter(input.platform)
    if (platformAdapter && !platformAdapter.taskReady) {
      return { id: null, skipped: true, reason: `${platformAdapter.displayName}还在接入中，暂不支持建任务；可在「内置浏览器」页打开并登录` }
    }
    // P1.5：type=author 时先归一化 query（完整 URL / 裸 sec_uid 两种输入统一转成 sec_uid）——
    // 修复 FilterForm 存完整 URL、scheduler 又套一层 buildAuthorUrl 拼出双重 URL 的静默卡死 bug；
    // 顺带修复去重键分裂（FilterForm 存 URL、AuthorCollection 存 sec_uid，此前两个键互不相认）。
    if (input.type === 'author') {
      const adapter = getAdapter(input.platform)
      const secUid = adapter?.parseAuthorInput(input.query) ?? null
      if (secUid === null) {
        // 文案跟随平台：选了快手却提示"未识别到抖音主页链接"会把人带沟里
        const site = adapter?.displayName ?? input.platform
        const reason = adapter?.isShortLink(input.query)
          ? '暂不支持短链接，请粘贴完整主页链接' // 与批量导入同一句，别让同一件事有两种说法
          : `未识别到${site}主页链接或作者 ID`
        return { id: null, skipped: true, reason }
      }
      input = { ...input, query: secUid }
    }
    // 作者去重：仅当该作者的"主页爬取"任务已完成才跳过（作者在搜索里出现过不算爬过主页）。
    // 允许重复：任务级 allowDuplicateAuthor 覆盖全局设置；未指定时回退到全局"允许重复爬取作者"。
    // 比对时对已有 done 行的 query 也做一次归一化——库里可能有 P1.5 修复前存的完整 URL 历史行，
    // 不归一会导致「URL 输入」和「sec_uid 输入」两种格式各自建一条去重记录，去重形同虚设。
    if (input.type === 'author' && !(input.allowDuplicateAuthor ?? getSettings().allowDuplicateAuthor)) {
      const adapter = getAdapter(input.platform)
      const doneRows = db.prepare("SELECT query FROM tasks WHERE type='author' AND status='done'")
        .all() as Array<{ query: string }>
      const dup = doneRows.some(r => (adapter?.parseAuthorInput(r.query) ?? r.query) === input.query)
      if (dup) return { id: null, skipped: true, reason: '该作者主页已爬取过，可在作者表格中直接管理' }
    }
    const id = createTask(db, input)
    deps.enqueueTask(id)
    return { id, skipped: false }
  })

  ipcMain.handle('task:list', () => listTasks(db))
  ipcMain.handle('task:video:list', (_e, taskId: number) => listVideos(db, taskId).map(video => ({
    ...video,
    source_url: resolveVideoSourceUrl(video.platform, video.aweme_id, video.source_url)
  })))
  ipcMain.handle('task:stats', (_e, taskId: number) => taskStats(db, taskId))
  // A1：先等 scheduler.pause()（run 完全退出）再置状态，避免渲染层立刻看到 paused 而 run 还在收尾
  ipcMain.handle('task:pause', async (_e, id: number) => { await scheduler.pause(); setTaskStatus(db, id, 'paused', 'user') })
  // A1：走 scheduler.resume（内含 run 退出守卫，并发 resume 不会被 running 挡回静默丢弃）
  ipcMain.handle('task:resume', (_e, id: number) => { void scheduler.resume(id) })
  // 删任务必须把这个任务相关的活全停掉，否则会留下"幽灵任务"：
  // 调度器攥着内存里的 taskId 继续滚页面、继续停滞重搜，最后想标 paused 时那行已经没了，
  // UPDATE 静默失败——用户在界面上什么都看不到，只看见浏览器自己在动（真机踩过）。
  ipcMain.handle('task:delete', async (_e, id: number) => {
    if (scheduler.currentTaskId === id) await scheduler.pause() // 正在跑 → 等 run 完全退出
    deps.dequeueTask(id) // 还在排队 → 摘掉，别轮到它时再跑一遍
    // 在途下载也要掐断，否则文件继续往磁盘写、对应的数据库行却已经删了 → 孤儿文件
    const videoIds = (db.prepare('SELECT id FROM videos WHERE task_id=?').all(id) as unknown as Array<{ id: number }>)
      .map(r => r.id)
    if (videoIds.length > 0) downloader.cancel(videoIds)
    db.prepare('DELETE FROM videos WHERE task_id=?').run(id)
    db.prepare('DELETE FROM tasks WHERE id=?').run(id)
    // 放行队列：dequeueAndRun 只在 task:done 时触发（刻意如此，暂停不放行下一个），
    // 而删除走的是 pause()、不发任何事件——不踢这一脚，排队中的任务会永远卡在「等待」。
    deps.kickQueue()
  })

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

  // 批量导入作者（粘贴主页 URL / 裸 sec_uid 列表）：只登记不刷新已有数据（insertAuthorIfAbsent）。
  // 渲染层已过滤空行/纯空白，这里仍对 nickname 兜底校验；reason 词表逐字返回，供渲染层逐行展示。
  // 走主进程写剪贴板：打包后页面是 file:// 协议，navigator.clipboard 在部分环境下不可用，
  // 而 Electron 的 clipboard 模块无这个顾虑。
  // 概览页：两条聚合查询代替原来的 1 + N 次调用
  ipcMain.handle('stats:global', () => globalStats(db))
  ipcMain.handle('stats:recent', (_e, limit?: number) => recentDownloads(db, limit ?? 8))
  // 「导出全部已下载」用：跨任务取 done 的视频（含作者昵称）
  ipcMain.handle('videos:downloaded', () => listDownloadedVideos(db))

  ipcMain.handle('clipboard:write', (_e, text: string) => { clipboard.writeText(String(text ?? '')) })

  ipcMain.handle('video:source:open', async (_e, id: number) => {
    const row = db.prepare('SELECT platform, aweme_id, source_url FROM videos WHERE id=?').get(id) as
      { platform: string; aweme_id: string; source_url: string | null } | undefined
    if (!row) return { ok: false, error: '视频记录不存在' }
    const url = resolveVideoSourceUrl(row.platform, row.aweme_id, row.source_url)
    if (!url) return { ok: false, error: '作品链接不安全或不受支持' }
    try {
      await shell.openExternal(url)
      return { ok: true, url }
    } catch {
      return { ok: false, error: '无法打开原视频' }
    }
  })

  // platform 由调用方给出（导入面板的平台下拉）。默认 douyin 保持老调用方行为不变。
  // 不能继续写死抖音：粘快手链接会得到「未识别到抖音主页链接」，用户完全看不出问题在哪。
  ipcMain.handle('authors:import', (_e, items: Array<{ nickname: string; url: string }>, platform = 'douyin') => {
    const adapter = getAdapter(platform)
    let created = 0
    const seen = new Set<string>()
    const results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> = []
    if (!adapter) {
      // 未注册平台：逐行明确失败，不静默按抖音解析后把作者落到错误平台下
      return {
        created: 0,
        results: items.map((item, idx) => ({
          line: idx + 1, raw: item.url, ok: false, reason: `不支持的平台：${platform}`
        }))
      }
    }
    items.forEach((item, idx) => {
      const line = idx + 1
      const raw = item.url
      if (!item.nickname || !item.nickname.trim()) {
        results.push({ line, raw, ok: false, reason: '缺少作者名称' })
        return
      }
      const secUid = adapter.parseAuthorInput(item.url) ?? null
      if (secUid === null) {
        // 短链与「压根不是本平台链接」分开报：前者让用户去粘完整主页，后者说明平台选错了
        const reason = adapter.isShortLink(item.url)
          ? '暂不支持短链接，请粘贴完整主页链接'
          : `未识别到${adapter.displayName}主页链接`
        results.push({ line, raw, ok: false, reason })
        return
      }
      if (seen.has(secUid)) {
        results.push({ line, raw, ok: false, reason: '本次粘贴中重复' })
        return
      }
      seen.add(secUid)
      const homeUrl = adapter.buildAuthorUrl(secUid)
      const { created: wasCreated } = insertAuthorIfAbsent(db, { platform, secUid, nickname: item.nickname.trim(), homeUrl })
      if (wasCreated) {
        created++
        results.push({ line, raw, ok: true })
      } else {
        results.push({ line, raw, ok: false, reason: '已存在，未修改' })
      }
    })
    return { created, results }
  })

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
    // 未启用任何层级不是失败，是配置状态；照直说，别返回一个会被渲染成"整理 0 个"的空结果
    if (!org.isEnabled()) return { ok: true, moved: 0, state: 'done', skipped: true }
    try {
      const r = await org.organizeAuthor(authorId)
      return { ok: true, moved: r.moved, category: r.category, state: r.state }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('organize:all', async () => {
    const org = deps.getOrganizer()
    if (!org) return { ok: false, error: '整理器未就绪' }
    if (!org.isEnabled()) return { ok: true, count: 0, skipped: true }
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

  // 按平台打开内置浏览器。此前只有 browser:show（显示"当前那个窗口"），
  // 用户没有任何办法主动切到快手——而扫码登录只能在各自平台的窗口里做。
  ipcMain.handle('browser:open', async (_e, platform: string) => {
    const adapter = getAdapter(platform)
    if (!adapter) return { ok: false, error: `不支持的平台：${platform}` }
    // 切平台会销毁重建窗口（分区只能建窗口时定死）。任务正在用这个窗口，切了就等于打断它。
    if (scheduler.isRunning) return { ok: false, error: '有任务正在运行，切换平台会打断它，请先暂停任务' }
    try {
      await browser.load(adapter, adapter.homeUrl)
    } catch (err) {
      // 异常抛出 IPC 处理器只会在主进程打一行 Electron 报错，渲染层什么都收不到，
      // 用户看到的是"点了没反应"。一律转成可读结果返回。
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    deps.setBrowserVisible(true)
    return { ok: true }
  })
  ipcMain.handle('browser:show', () => deps.setBrowserVisible(true))
  ipcMain.handle('browser:hide', () => deps.setBrowserVisible(false))
  ipcMain.handle('browser:devtools', () => browser.openDevTools())

  // 文件管理——扫描下载目录成通用目录树（任意归档层级组合、根目录平铺视频都可见）
  // + 按相对段落删除任意层级的文件夹 / 单个视频（逐段校验 + 路径防护 + DB 联动）。
  // downloadDir 每次取最新（设置可能已热更），扫描纯函数在主进程 fileManager.ts 中可单测
  ipcMain.handle('files:tree', () => scanFilesTree(getSettings().downloadDir))
  ipcMain.handle('files:deleteDir', (_e, segments: string[]) =>
    deleteFileDir({ db, downloadDir: getSettings().downloadDir }, segments)
  )
  ipcMain.handle('files:deleteFile', (_e, segments: string[]) =>
    deleteFileVideo({ db, downloadDir: getSettings().downloadDir, downloader }, segments)
  )
  // 定位文件夹 / 视频文件（资源管理器选中）：路径防护 + 存在才调 shell，其余返回错误提示
  ipcMain.handle('files:locate', (_e, dirPath: string) => {
    const r = locateFileDir(getSettings().downloadDir, dirPath)
    if (r.ok) shell.showItemInFolder(dirPath)
    return r
  })
  ipcMain.handle('files:locateFile', (_e, filePath: string) => {
    const r = locateVideoFile(getSettings().downloadDir, filePath)
    if (r.ok) shell.showItemInFolder(filePath)
    return r
  })

  // 视频处理（统一分辨率批处理）：start 返回能否开始的原因；暂停/继续/停止只发指令，结果经 evt:process:state 推回
  ipcMain.handle('process:state', () => deps.processor.getState())
  ipcMain.handle('process:start', (_e, dir: string) => deps.processor.start(String(dir ?? '')))
  ipcMain.handle('process:pause', () => { deps.processor.pause() })
  ipcMain.handle('process:resume', () => { deps.processor.resume() })
  ipcMain.handle('process:stop', () => { deps.processor.stop() })

  // 选择目录（#1 下载目录；视频处理页复用，只换标题）
  ipcMain.handle('dialog:pickDir', async (_e, title?: string) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(deps.getWindow(), {
      title: title || '选择下载目录', properties: ['openDirectory', 'createDirectory']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })
  // 在系统文件管理器中打开某个目录（#8）
  ipcMain.handle('dialog:openDir', (_e, p: string) => { void shell.openPath(p) })
  // 定位已下载的视频文件（在资源管理器中选中该文件）
  ipcMain.handle('video:locate', (_e, p: string) => { if (p) shell.showItemInFolder(p) })
}
