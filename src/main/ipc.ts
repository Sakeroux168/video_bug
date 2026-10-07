import { app, ipcMain, BrowserWindow, dialog, shell, clipboard } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { createTask, listTasks, listVideos, listDeletedVideos, restoreVideos, allTaskStats, listDownloadedVideos, listAuthors, setTaskStatus, setVideoStatus, updateAuthorCategory, deleteAuthors, taskStats, insertAuthorIfAbsent, globalStats, recentDownloads } from './db'
import { getSettings, saveSettings } from './settings'
import { deleteVideoRows } from './videoDelete'
import { scanFilesTreeAsync, deleteFileDir, deleteFileVideo, locateFileDir, locateVideoFile } from './fileManager'
import { listAdapters, getAdapter } from './adapters'
import type { LibraryQuery, ProcessOptions, VideoMark } from '../shared/types'
import { listLibrary, listLibraryTasks, setVideoMark, setVideoNote, videoFileFor } from './library'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import type { VideoProcessor } from './videoProcessor'
import { Analyzer } from './analyzer'
import type { VideoBrowser } from './browser'
import type { Organizer } from './organizer'
import { status as modelsStatus, ensureModels } from './asr/models'
import type { EnsureProgress } from './asr/models'
import { resolveVideoSourceUrl } from './videoSource'
import { createTaskChecked } from './taskCreate'
import { exportFailure, revealExportFile, writeCsvToDownloads } from './csvExport'
import { isAppUrl } from './security'

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
  /** 放行队列里的下一个任务（删任务等用户操作之后踢一脚；R20 起任务结束的各种结局都会自动放行，这里是兜底） */
  kickQueue: () => void
  /** 渲染层切换浏览器标签时通知主进程（主进程据此结合任务状态决定显示/小窗/隐藏） */
  setBrowserVisible: (v: boolean) => void
}

export function registerIpc(deps: IpcDeps): void {
  // 程序里删的视频 / 文件夹一律进回收站，删错了还能找回来
  // 文件早就不在了（手动删过）不算失败：回收站找不到它会报错，那样这条记录就永远删不掉了
  const trash = async (p: string): Promise<void> => { if (existsSync(p)) await shell.trashItem(p) }
  // 安全检查 A2：主进程接口只认本软件主界面。平台窗口加载的是外部网页，万一被攻破也不能借这些接口
  // 读写删文件、打开程序。真实调用一定带 senderFrame；测试里直接传 null 事件不受影响。
  const handle = (channel: string, listener: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      const frame = (e as { senderFrame?: { url: string } | null } | null)?.senderFrame
      if (frame === null || (frame && !isAppUrl(frame.url))) throw new Error('拒绝：只有本软件主界面能调用')
      return listener(e, ...args)
    })
  }
  const { db, scheduler, downloader, browser } = deps

  handle('csv:export', async (_e, input: unknown) => {
    try { return await writeCsvToDownloads(app.getPath('downloads'), input) }
    catch (error) { return { ok: false, error: exportFailure(error) } }
  })
  handle('csv:reveal', (_e, path: unknown) => {
    try { return revealExportFile(app.getPath('downloads'), path, p => shell.showItemInFolder(p)) }
    catch { return { ok: false, error: '无法打开下载文件夹，请稍后重试' } }
  })

  ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
  handle('platforms:list', () => listAdapters())
  handle('platforms:login-status', () => Promise.all(listAdapters().map(p => browser.getLoginStatus(getAdapter(p.name)!))))

  // 归一化 + 作者去重 + 入库 + 入队 都在 taskCreate.ts（R18 起和本机 HTTP 口 /job 共用一条路）
  handle('task:create', (_e, rawInput: Parameters<typeof createTask>[1]) =>
    createTaskChecked(db, rawInput, deps.enqueueTask))

  handle('task:list', () => listTasks(db))
  handle('task:video:list', (_e, taskId: number) => listVideos(db, taskId).map(video => ({
    ...video,
    source_url: resolveVideoSourceUrl(video.platform, video.aweme_id, video.source_url)
  })))
  handle('task:video:listDeleted', (_e, taskId: number) => listDeletedVideos(db, taskId))
  handle('task:stats', (_e, taskId: number) => taskStats(db, taskId))
  // 任务列表一次拿全部任务的统计（以前每个任务一次 IPC + 一次查询，下载时每秒要刷一两轮）
  handle('task:statsMany', (_e, ids: number[]) => allTaskStats(db, Array.isArray(ids) ? ids : []))
  // A1：先等 scheduler.pause()（run 完全退出）再置状态，避免渲染层立刻看到 paused 而 run 还在收尾。
  // R20：pause() 最多等 10 秒，等不到就强制停，按钮不会再跟着卡死；
  // 只叫停「正在跑的就是它」的情况——以前不管暂停哪个任务都会把正在跑的那个停掉。
  // 暂停的是还在排队的任务 → 从队列摘掉，不然轮到它时又会被跑起来。
  handle('task:pause', async (_e, id: number) => {
    if (scheduler.currentTaskId === id) await scheduler.pause()
    else deps.dequeueTask(id)
    setTaskStatus(db, id, 'paused', 'user')
  })
  // A1：走 scheduler.resume（内含 run 退出守卫，并发 resume 不会被 running 挡回静默丢弃）。
  // R20：别的任务正在跑时，点「继续」/「开始」不能被静默吞掉（以前 run 发现在忙就直接 return，
  // 按钮点了没反应）——改成放回队列排队，前一个结束后自动接着跑。
  handle('task:resume', (_e, id: number) => {
    if (scheduler.isRunning && scheduler.currentTaskId !== id) {
      setTaskStatus(db, id, 'pending')
      deps.enqueueTask(id)
      return
    }
    deps.dequeueTask(id) // 直接开跑的不能还留在队列里，否则跑完又被队列再跑一遍
    void scheduler.resume(id)
  })
  // 删任务必须把这个任务相关的活全停掉，否则会留下"幽灵任务"：
  // 调度器攥着内存里的 taskId 继续滚页面、继续停滞重搜，最后想标 paused 时那行已经没了，
  // UPDATE 静默失败——用户在界面上什么都看不到，只看见浏览器自己在动（真机踩过）。
  handle('task:delete', async (_e, id: number) => {
    if (scheduler.currentTaskId === id) await scheduler.pause() // 正在跑 → 等 run 完全退出
    deps.dequeueTask(id) // 还在排队 → 摘掉，别轮到它时再跑一遍
    // 在途下载也要掐断，否则文件继续往磁盘写、对应的数据库行却已经删了 → 孤儿文件
    const videoIds = (db.prepare('SELECT id FROM videos WHERE task_id=?').all(id) as unknown as Array<{ id: number }>)
      .map(r => r.id)
    if (videoIds.length > 0) downloader.cancel(videoIds)
    // B5：已删除的记号留着（task_id 指向已删的任务也无妨），否则重搜又会把它们下回来
    db.prepare("DELETE FROM videos WHERE task_id=? AND status != 'deleted'").run(id)
    db.prepare('DELETE FROM tasks WHERE id=?').run(id)
    // 放行队列：删掉的若是正在跑的任务，pause() 发的暂停事件已经会放行；这里再踢一脚兜底（重复踢无害）。
    deps.kickQueue()
  })

  handle('video:retry', (_e, ids: number[]) => {
    for (const id of ids) {
      // B5：已删除的是用户不要的，不能被「重试」重新下回来
      const row = db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: string } | undefined
      if (!row || row.status === 'deleted') continue
      setVideoStatus(db, id, 'pending', { error: null })
      downloader.enqueue(id)
    }
    return true
  })

  // Task3：程序内删除视频（③）——编排在 videoDelete.ts（先 cancel 在途/排队项防孤儿文件 →
  // 路径安全则删本地文件 → 删 DB 行 → 作者 video_count 重算）；单条失败返回错误但不中断整批。
  handle('video:delete', (_e, ids: number[]) =>
    deleteVideoRows({ db, downloader, downloadDir: getSettings().downloadDir, trash }, ids)
  )

  // B5：删掉的视频后悔了 → 标回待下载，交给下载器重新下（地址过期的会提示，重新爬一次就能拿到新地址）
  handle('video:restore', (_e, ids: number[]) => {
    const restored = restoreVideos(db, Array.isArray(ids) ? ids : [])
    if (restored.length > 0) downloader.download(restored)
    return { restored: restored.length }
  })

  // 全局下载控制：暂停（在途任务跑完，不再拉新）/ 恢复 / 查询暂停状态
  handle('download:pause', () => { downloader.pause(); return true })
  handle('download:resume', () => { downloader.resume(); return true })
  handle('download:state', () => ({ paused: downloader.isPaused() }))

  // 手动下载（collected/cancelled/failed → pending 并入队）与取消（在途 abort / 排队移出）
  handle('video:download', (_e, ids: number[]) => { downloader.download(ids); return true })
  handle('video:cancel', (_e, ids: number[]) => { downloader.cancel(ids); return true })
  // 单条暂停/继续（paused 状态：在途中断、排队出队；继续 = paused → pending 重新入队）
  handle('video:pause', (_e, ids: number[]) => { downloader.pauseVideo(ids); return true })
  handle('video:resume', (_e, ids: number[]) => { downloader.resumeVideo(ids); return true })

  handle('authors:list', () => listAuthors(db))
  handle('authors:updateCategory', (_e, id: number, category: string) => {
    updateAuthorCategory(db, id, category)
    return true
  })
  handle('authors:delete', (_e, ids: number[]) => {
    // #10：先掐断这些作者在下载 / 排队的视频，否则删完行后下载器照样写出没有记录的孤儿文件
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',')
      const videoIds = (db.prepare(`SELECT id FROM videos WHERE author_id IN (${ph})`).all(...ids) as unknown as Array<{ id: number }>).map(r => r.id)
      if (videoIds.length > 0) downloader.cancel(videoIds)
    }
    deleteAuthors(db, ids)
    return true
  })

  // 批量导入作者（粘贴主页 URL / 裸 sec_uid 列表）：只登记不刷新已有数据（insertAuthorIfAbsent）。
  // 渲染层已过滤空行/纯空白，这里仍对 nickname 兜底校验；reason 词表逐字返回，供渲染层逐行展示。
  // 走主进程写剪贴板：打包后页面是 file:// 协议，navigator.clipboard 在部分环境下不可用，
  // 而 Electron 的 clipboard 模块无这个顾虑。
  // 概览页：两条聚合查询代替原来的 1 + N 次调用
  handle('stats:global', () => globalStats(db))
  handle('stats:recent', (_e, limit?: number) => recentDownloads(db, limit ?? 8))
  // 「导出全部已下载」用：跨任务取 done 的视频（含作者昵称）
  handle('videos:downloaded', () => listDownloadedVideos(db))

  handle('clipboard:write', (_e, text: string) => { clipboard.writeText(String(text ?? '')) })

  handle('video:source:open', async (_e, id: number) => {
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
  handle('authors:import', (_e, items: Array<{ nickname: string; url: string }>, platform = 'douyin') => {
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

  handle('settings:get', () => getSettings())
  handle('settings:save', (_e, s: Parameters<typeof saveSettings>[0]) => {
    saveSettings(s)
    // I3: 保存后立即重建 Analyzer，下载参数热更新，无需重启程序
    deps.reloadAnalyzer()
    // Task14: 下载目录 / ASR 就绪状态变化 → 重建 Organizer（resolveCategory 实时读 asr/analyzer）
    deps.reloadOrganizer()
    deps.downloader.updateSettings(s)
  })

  // Task14：手动整理单个作者 → 归档其已下载视频到 {品类}/{作者}；organizeAll 类似但批量
  handle('authors:organize', async (_e, authorId: number) => {
    const org = deps.getOrganizer()
    if (!org) return { ok: false, error: '整理器未就绪' }
    // 未启用任何层级不是失败，是配置状态；照直说，别返回一个会被渲染成"整理 0 个"的空结果
    if (!org.isEnabled()) return { ok: true, moved: 0, state: 'done', skipped: true }
    try {
      const r = await org.organizeAuthor(authorId)
      return { ok: true, moved: r.moved, category: r.category, state: r.state }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  handle('organize:all', async () => {
    const org = deps.getOrganizer()
    if (!org) return { ok: false, error: '整理器未就绪' }
    if (!org.isEnabled()) return { ok: true, count: 0, skipped: true }
    try {
      const count = await org.organizeAll()
      return { ok: true, count }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // Task14：ASR 模型状态查询 + 下载（进度经 evt:asr:progress 透传，设置面板画进度条）
  handle('asr:status', () => modelsStatus())
  handle('asr:download', async () => {
    try {
      const r = await ensureModels({
        onProgress: (p: EnsureProgress) => {
          deps.getWindow().webContents.send('evt:asr:progress', p)
        }
      })
      return { ok: true, ready: r.ready, downloaded: r.downloaded }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  handle('ai:test', async () => {
    const s = getSettings()
    if (!s.aiApiKey || !s.aiBaseUrl) return { ok: false, error: '未配置 API Key' }
    const a = new Analyzer(s)
    try { await a.judgeFilter('测试', '总是通过', 'test') ; return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // 按平台打开内置浏览器。此前只有 browser:show（显示"当前那个窗口"），
  // 用户没有任何办法主动切到快手——而扫码登录只能在各自平台的窗口里做。
  handle('browser:open', async (_e, platform: string) => {
    const adapter = getAdapter(platform)
    if (!adapter) return { ok: false, error: `不支持的平台：${platform}` }
    // 切平台会销毁重建窗口（分区只能建窗口时定死）。任务正在用这个窗口，切了就等于打断它。
    if (scheduler.isRunning) return { ok: false, error: '有任务正在运行，切换平台会打断它，请先暂停任务' }
    try {
      // 同平台直接找回原页，避免把正等人工处理的登录/验证码页面导航掉。
      if (browser.adapter?.name !== platform) await browser.load(adapter, adapter.homeUrl)
    } catch (err) {
      // 异常抛出 IPC 处理器只会在主进程打一行 Electron 报错，渲染层什么都收不到，
      // 用户看到的是"点了没反应"。一律转成可读结果返回。
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    deps.setBrowserVisible(true)
    return { ok: true }
  })
  handle('browser:show', () => deps.setBrowserVisible(true))
  handle('browser:hide', () => deps.setBrowserVisible(false))
  handle('browser:devtools', () => browser.openDevTools())

  // 文件管理——扫描下载目录成通用目录树（任意归档层级组合、根目录平铺视频都可见）
  // + 按相对段落删除任意层级的文件夹 / 单个视频（逐段校验 + 路径防护 + DB 联动）。
  // downloadDir 每次取最新（设置可能已热更），扫描纯函数在主进程 fileManager.ts 中可单测
  handle('files:tree', () => scanFilesTreeAsync(getSettings().downloadDir)) // 异步扫，不卡主进程（性能检查 C2）
  handle('files:deleteDir', (_e, segments: string[]) =>
    deleteFileDir({ db, downloadDir: getSettings().downloadDir, trash }, segments)
  )
  handle('files:deleteFile', (_e, segments: string[]) =>
    deleteFileVideo({ db, downloadDir: getSettings().downloadDir, downloader, trash }, segments)
  )
  // 定位文件夹 / 视频文件（资源管理器选中）：路径防护 + 存在才调 shell，其余返回错误提示
  handle('files:locate', (_e, dirPath: string) => {
    const r = locateFileDir(getSettings().downloadDir, dirPath)
    if (r.ok) shell.showItemInFolder(dirPath)
    return r
  })
  handle('files:locateFile', (_e, filePath: string) => {
    const r = locateVideoFile(getSettings().downloadDir, filePath)
    if (r.ok) shell.showItemInFolder(filePath)
    return r
  })

  // 视频处理（统一分辨率批处理）：start 返回能否开始的原因；暂停/继续/停止只发指令，结果经 evt:process:state 推回
  handle('process:state', () => deps.processor.getState())
  handle('process:start', (_e, dir: string, options?: ProcessOptions) => {
    // 选项只认这几个值，别的一律按默认（原地替换 / 跟原片方向 / 不严格）
    const o = options && typeof options === 'object' ? options : {}
    return deps.processor.start(String(dir ?? ''), {
      mode: o.mode === 'folder' ? 'folder' : 'replace',
      orientation: o.orientation === 'portrait' || o.orientation === 'landscape' ? o.orientation : 'auto',
      strict: o.strict === true
    })
  })
  handle('process:pause', () => { deps.processor.pause() })
  handle('process:resume', () => { deps.processor.resume() })
  handle('process:stop', () => { deps.processor.stop() })

  // 选择目录（#1 下载目录；视频处理页复用，只换标题）
  handle('dialog:pickDir', async (_e, title?: string) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(deps.getWindow(), {
      title: title || '选择下载目录', properties: ['openDirectory', 'createDirectory']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })
  // 在系统文件管理器中打开某个目录（#8）
  // 只打开真实存在的文件夹：shell.openPath 对 .exe 等文件是直接运行（安全检查 A2）
  handle('dialog:openDir', (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return
    try { if (!statSync(p).isDirectory()) return } catch { return }
    void shell.openPath(p)
  })
  // 定位已下载的视频文件（在资源管理器中选中该文件）
  handle('video:locate', (_e, p: string) => { if (p) shell.showItemInFolder(p) })

  // 素材库（2026-10-07）：列表 / 任务下拉 / 标记 / 备注；播放和定位只收视频 id，路径由主进程从库里取
  handle('library:list', (_e, q: LibraryQuery) => listLibrary(db, q && typeof q === 'object' ? q : {}))
  handle('library:tasks', () => listLibraryTasks(db))
  handle('library:mark', (_e, ids: number[], mark: VideoMark | null) => { setVideoMark(db, Array.isArray(ids) ? ids : [], mark ?? null); return true })
  handle('library:note', (_e, id: number, note: string) => { setVideoNote(db, Number(id), String(note ?? '')); return true })
  handle('library:play', async (_e, id: number) => {
    const file = videoFileFor(db, Number(id))
    if (!file) return { ok: false, error: '找不到这个视频文件（可能被移走或删掉了）' }
    const err = await shell.openPath(file)
    return err ? { ok: false, error: err } : { ok: true }
  })
  handle('library:locate', (_e, id: number) => {
    const file = videoFileFor(db, Number(id))
    if (!file) return { ok: false, error: '找不到这个视频文件（可能被移走或删掉了）' }
    shell.showItemInFolder(file)
    return { ok: true }
  })
}
