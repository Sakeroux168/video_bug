import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { buildStopDecision, Scheduler as RealScheduler } from '../src/main/scheduler'
import { initDb, createTask, listAuthors, insertAuthorIfAbsent, upsertAuthor, insertVideos, setAuthorVerify } from '../src/main/db'
import { douyinAdapter } from '../src/main/adapters/douyin'
import type { PlatformAdapter } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 测试里的浏览器 / 下载器 / AI 是只实现了用到那几个方法的替身；构造调度器时放宽这三个依赖的类型
type SchedulerDepsForTest = Omit<ConstructorParameters<typeof RealScheduler>[0], 'browser' | 'downloader' | 'analyzer'> &
  { browser: unknown; downloader: unknown; analyzer: unknown }
const Scheduler = RealScheduler as unknown as new (deps: SchedulerDepsForTest) => RealScheduler
type Scheduler = RealScheduler

// R12：scheduler 的停滞自救读 getSettings().rescueCooldownSec（默认 10），settings.ts 顶层用
// electron app.getPath——mock electron 指向测试目录（无配置文件 → 回落 DEFAULTS，冷却=10s）
vi.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-scheduler-test' }
}))

describe('buildStopDecision', () => {
  it('达到目标 → reached', () => expect(buildStopDecision(200, 200, 0)).toBe('reached'))
  it('连续5轮空 → stop', () => expect(buildStopDecision(100, 200, 5)).toBe('stop'))
  it('否则继续', () => expect(buildStopDecision(100, 200, 2)).toBe('continue'))
})

type DlEvent = { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }

class FakeBrowser {
  failLoad = false
  /** 指定 load 抛出的错误对象；不设则抛通用 Error（配合 failLoad） */
  loadError: unknown = null
  /** 模拟页面底部文案（如抖音「暂时没有更多了」）；null 表示未滚到底/未命中 */
  bottomText: string | null = '暂时没有更多了'
  private loadBlocked = false
  private pendingLoad: (() => void) | null = null

  blockNextLoad(): void { this.loadBlocked = true }
  releaseLoad(): void { if (this.pendingLoad) { this.pendingLoad(); this.pendingLoad = null } }

  /** 导入作者校验：模拟从主页读到的真实昵称；null = 页面打不开/取不到 */
  authorNickname: string | null = null
  readAuthorNicknameCalls = 0
  async readAuthorNickname(): Promise<string | null> { this.readAuthorNicknameCalls++; return this.authorNickname }

  /** P1.5：最近一次 load 收到的 url（现在 load 忽略 url 参数，供测试捕获校验单层/双层包裹） */
  lastUrl: string | null = null

  async init(): Promise<void> {}
  async load(_adapter: PlatformAdapter, url: string): Promise<void> {
    this.lastUrl = url
    if (this.failLoad) throw (this.loadError ?? new Error('load_failed'))
    if (this.loadBlocked) {
      this.loadBlocked = false
      await new Promise<void>(r => { this.pendingLoad = r })
    }
  }
  /** 滚动是否已进入（用于感知 run 已到达 scrollToBottom，模拟暂停落在滚动内） */
  scrollEntered = false
  private scrollBlocked = false
  private pendingScroll: (() => void) | null = null

  blockNextScroll(): void { this.scrollBlocked = true }
  releaseScroll(): void { if (this.pendingScroll) { this.pendingScroll(); this.pendingScroll = null } }

  async scrollToBottom(_opts?: { waitMs?: number }): Promise<void> {
    this.scrollEntered = true
    if (this.scrollBlocked) {
      this.scrollBlocked = false
      await new Promise<void>(r => { this.pendingScroll = r })
    }
  }
  /** 滚动中止信号 spy：pause() 应触发 abortScroll（页面级即时停止，不等 scrollToBottom 跑完） */
  abortScroll = vi.fn()
  /** R20：看门狗判卡住时刷新页面的 spy */
  resetPage = vi.fn()
  async findBottomText(): Promise<string | null> { return this.bottomText }
  /** R11-4：模拟验证码文案（findVerifyIndicator 命中）；null=未弹验证码 */
  verifyText: string | null = null
  async findVerifyIndicator(): Promise<string | null> { return this.verifyText }
  loginText: string | null = null
  async findLoginIndicator(): Promise<string | null> { return this.loginText }
  setVisible(_v: boolean): void {}
  dispose(): void {}
}

class FakeDownloader {
  listeners: Array<(e: DlEvent) => void> = []
  enqueued: number[] = []
  onEvent(cb: (e: DlEvent) => void): void { this.listeners.push(cb) }
  enqueue(id: number): void { this.enqueued.push(id) }
  emit(e: DlEvent): void { for (const l of this.listeners) l(e) }
  start(): void {}
  isIdle(): boolean { return true }
}

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '测试',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}

const rawUrl = 'https://www.douyin.com/aweme/v1/web/search/item/?device_platform=webapp'
// 稀疏数据：接口仍零星返回新视频（每轮 1-2 条，kept>0 → emptyRounds 归零、停滞分支永远到不了）
function sparseJson(i: number): unknown {
  return {
    aweme_list: [{
      aweme_id: `733${String(1000 + i).padStart(16, '0')}`,
      desc: `稀疏数据${i}`,
      create_time: 1710000000,
      author: { sec_uid: `SEC_SPARSE_${i}`, nickname: '稀疏作者' },
      video: { play_addr: { url_list: [`https://cdn.test/sparse${i}.mp4`] } },
      statistics: { digg_count: 1 },
      duration: 8000
    }]
  }
}

const rawJson = {
  aweme_list: [{
    aweme_id: '7330000000000000001',
    desc: '测试视频标题',
    create_time: 1710000000,
    author: { sec_uid: 'SEC_001', nickname: '作者一号' },
    video: {
      play_addr: { url_list: ['https://cdn.test/v1.mp4'] },
      origin_cover: { url_list: ['https://cdn.test/v1.jpg'] },
      width: 1080,
      height: 1920
    },
    statistics: { digg_count: 42, comment_count: 17 },
    duration: 8000
  }]
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  return db
}

function setup(db: DatabaseSync, dl: FakeDownloader, browser: FakeBrowser, scrollIntervalMs = 1) {
  const events: unknown[] = []
  const logs: string[] = []
  const s = new Scheduler({
    db, browser, analyzer: null, downloader: dl, emit: e => events.push(e),
    onFilterLog: msg => logs.push(msg),
    getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs }),
    // R11：默认测试阈值 0.01 秒（10ms）——Task4 加了动态下限后，实际生效阈值会被抬高到 ≥12s
    // （(scrollIntervalMs+1500)/1000+5.5+5）。依赖"自然停滞"收尾的用例改用 advancingClock() 让虚拟时钟
    // 快进，不再单靠这个 0.01s raw 值拖快；只关心其它行为、不关心停滞原因的用例改用 s.pause() 收尾。
    getStallThresholdSec: () => 0.01
  })
  return { s, events, logs }
}

// 固定随机数让滚动 sleep 稳定为 scrollIntervalMs，跑得快且不依赖真实时长
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.restoreAllMocks() })

describe('Scheduler 滚动循环终止（C1）', () => {
  it('页面静默（无任何 raw 响应）且未达目标 → 停滞后自动暂停（error=stalled，不再无限"进行中"）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('Scheduler 异常兜底与串行（I3）', () => {
  it('browser.load 抛错 → 任务 failed + 触发 paused 事件 + running 复位', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.failLoad = true
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    const row = db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId) as { status: string; error: string | null }
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network')
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'scheduler_error' })
    expect((s as any).running).toBe(false)
  })

  it('运行中重复 run 被忽略（串行）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextLoad()
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const { s } = setup(db, new FakeDownloader(), browser)
    const p1 = s.run(taskId)
    await new Promise(r => setTimeout(r, 20))
    expect((s as any).running).toBe(true)
    await s.run(taskId) // 应被 running 挡回
    expect((s as any).running).toBe(true)
    browser.releaseLoad()
    await p1
    expect((s as any).running).toBe(false)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('R18 作者主页按日期段抓：翻过起点就算抓完', () => {
  const authorInput: CreateTaskInput = {
    ...input, type: 'author', query: 'https://www.douyin.com/user/SEC_R18',
    filters: { timeRange: 'custom', startDate: '2024-03-10', endDate: '2024-03-20', duration: 'all', targetCount: 200 }
  }
  const authorUrl = 'https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp'
  function json(id: string, createTime: number): unknown {
    return { aweme_list: [{ aweme_id: id, desc: '作品', create_time: createTime, author: { sec_uid: 'SEC_R18', nickname: '作者' },
      video: { play_addr: { url_list: ['https://cdn.test/r18.mp4'] } }, statistics: { digg_count: 1 }, duration: 8000 }] }
  }

  it('一批全比 startDate 老 → pastRange、中断滚动、不入库；之后任务以 done 结束（不是 stalled/风控）', async () => {
    const db = newDb()
    const taskId = createTask(db, authorInput)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    // 日期段内的一条 → 正常入库
    await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000000101', Date.UTC(2024, 2, 15) / 1000))
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 1 })
    expect((s as any).pastRange).toBe(false)
    // 比起点老的一批 → 翻过日期段
    const r = await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000000102', Date.UTC(2024, 2, 1) / 1000))
    expect(r).toEqual({ items: 1, kept: 0 })
    expect((s as any).pastRange).toBe(true)
    expect(browser.abortScroll).toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 1 })
    browser.releaseLoad()
    await p
    const row = db.prepare('SELECT status, error, fetched_count FROM tasks WHERE id=?').get(taskId) as { status: string; error: string | null; fetched_count: number }
    expect(row.status).toBe('done')
    expect(row.error).toBeNull()
    expect(row.fetched_count).toBe(1)
  }, 10000)

  it('关键词任务不适用（搜索结果不按时间排）：老视频只是被过滤，不会置 pastRange', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, filters: { timeRange: 'custom', startDate: '2024-03-10', endDate: '2024-03-20', duration: 'all', targetCount: 200 } })
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    await s.handleRaw(douyinAdapter, rawUrl, json('7330000000000000103', Date.UTC(2024, 2, 1) / 1000))
    expect((s as any).pastRange).toBe(false)
    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)
})

describe('handleRaw 入库与作者（I4）+ pendingVideoIds 清理（I1）', () => {
  it('写入作者、入库视频、入队下载；下载完成从 pendingVideoIds 移除', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad() // 任务挂起在 load：保持 taskId/adapter 就绪且任务仍在运行（I5 后任务结束即清理上下文）
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)
    expect(authors[0].sec_uid).toBe('SEC_001')

    const videos = db.prepare('SELECT * FROM videos WHERE task_id=?').all(taskId) as Array<{
      id: number; author_id: number | null; aweme_id: string
      cover_url: string | null; video_width: number; video_height: number
      source_url: string | null; stats: string
    }>
    expect(videos).toHaveLength(1)
    expect(videos[0].aweme_id).toBe('7330000000000000001')
    expect(videos[0].author_id).toBe(authors[0].id)
    expect(videos[0].cover_url).toBe('https://cdn.test/v1.jpg')
    expect(videos[0].video_width).toBe(1080)
    expect(videos[0].video_height).toBe(1920)
    expect(videos[0].source_url).toBe('https://www.douyin.com/video/7330000000000000001')
    expect(JSON.parse(videos[0].stats)).toEqual({ likes: 42, comments: 17 })
    expect(dl.enqueued).toContain(videos[0].id)
    expect((s as any).pendingVideoIds).toEqual([videos[0].id])

    // 重复 raw（同 aweme_id）不重复入库
    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 1 })

    // 下载器报告 done → pendingVideoIds 清理
    dl.emit({ type: 'video:status', id: videos[0].id, status: 'done' })
    expect((s as any).pendingVideoIds).toEqual([])

    browser.releaseLoad()
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('AI 过滤的视频也保留封面、宽高、评论与作品链接元数据', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, aiFilterEnabled: true })
    const browser = new FakeBrowser()
    const downloader = new FakeDownloader()
    const analyzer = {
      judgeFilter: vi.fn(async () => ({ pass: false }))
    } as unknown as import('../src/main/analyzer').Analyzer
    const s = new Scheduler({
      db, browser, analyzer, downloader, emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad()
    const running = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    expect(db.prepare(
      'SELECT status, cover_url, video_width, video_height, source_url, stats FROM videos WHERE task_id=?'
    ).get(taskId)).toEqual({
      status: 'filtered', cover_url: 'https://cdn.test/v1.jpg', video_width: 1080, video_height: 1920,
      source_url: 'https://www.douyin.com/video/7330000000000000001',
      stats: JSON.stringify({ likes: 42, comments: 17 })
    })
    expect(downloader.enqueued).toHaveLength(0)

    browser.releaseLoad()
    await s.pause()
    await running
  }, 10000)
})

describe('resume（I2）', () => {
  it('resume 重跑同一任务并正常结束（重搜计数随 run 重置）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
    await s.resume(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
    expect((s as any).running).toBe(false)
  }, 10000)
})

describe('任务结束清理上下文（I5）', () => {
  it('run 结束后 handleRaw 被拒绝，浏览流量不污染已完成任务', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const { s } = setup(db, dl, new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    expect(listAuthors(db, 'douyin')).toHaveLength(0)
    expect(dl.enqueued).toHaveLength(0)
  }, 10000)
})

describe('下载方式：手动 / 自动（Task5）', () => {
  it('手动模式（autoDownload:false）→ 视频 status=collected，不入队下载', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, autoDownload: false })
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad() // 任务挂起在 load：保持 taskId/adapter 就绪且任务仍在运行
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const videos = db.prepare('SELECT * FROM videos WHERE task_id=?').all(taskId) as Array<{ id: number; status: string }>
    expect(videos).toHaveLength(1)
    expect(videos[0].status).toBe('collected')
    expect(dl.enqueued).toHaveLength(0)
    expect((s as any).pendingVideoIds).toEqual([])

    // Task4：不再依赖自然停滞收尾（动态下限后需要 ≥12s）——本用例只关心下载状态，显式 pause 收尾即可
    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('自动模式（autoDownload:true）→ 视频 status=pending 且入队下载', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const videos = db.prepare('SELECT * FROM videos WHERE task_id=?').all(taskId) as Array<{ id: number; status: string }>
    expect(videos).toHaveLength(1)
    expect(videos[0].status).toBe('pending')
    expect(dl.enqueued).toContain(videos[0].id)
    expect((s as any).pendingVideoIds).toEqual([videos[0].id])

    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)
})

describe('下载完成触发作者整理（Task5 替代 I7 逐视频整理）', () => {
  const organizeInput: CreateTaskInput = { ...input, aiOrganizeEnabled: true }

  it('视频 done 且任务开启整理 → organizer.markAuthorPending 被调 + organizePending 触发', async () => {
    const db = newDb()
    const taskId = createTask(db, organizeInput)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    // 注入 organizer spy（结构上不满足私有成员，故按需转型）
    const organizer = {
      markAuthorPending: vi.fn(),
      organizePending: vi.fn(async () => 0)
    } as unknown as import('../src/main/organizer').Organizer
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: dl,
      emit: e => events.push(e),
      organizer, organizeDebounceMs: 0,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)

    dl.emit({ type: 'video:status', id: (db.prepare('SELECT id FROM videos WHERE task_id=?').get(taskId) as { id: number }).id, status: 'done' })

    expect(organizer.markAuthorPending).toHaveBeenCalledWith(authors[0].id)
    expect(organizer.organizePending).toHaveBeenCalled()

    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('任务未勾选 AI 整理（aiOrganizeEnabled=false）→ 视频 done 仍标记作者 pending（总是自动归档）', async () => {
    const db = newDb()
    const taskId = createTask(db, input) // input 的 aiOrganizeEnabled=false
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const organizer = {
      markAuthorPending: vi.fn(),
      organizePending: vi.fn(async () => 0)
    } as unknown as import('../src/main/organizer').Organizer
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: dl,
      emit: e => events.push(e),
      organizer, organizeDebounceMs: 0,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)

    dl.emit({ type: 'video:status', id: (db.prepare('SELECT id FROM videos WHERE task_id=?').get(taskId) as { id: number }).id, status: 'done' })

    expect(organizer.markAuthorPending).toHaveBeenCalledWith(authors[0].id)
    expect(organizer.organizePending).toHaveBeenCalled()

    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)
})

describe('暂停即时打断（A1）', () => {
  it('pause() 置 aborted、打断当前 sleep，run 完全退出后 promise 才 resolve', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser(), 50)
    const pRun = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // run 已进入循环，正在第一个 sleep
    const pPause = s.pause()
    let pauseResolved = false
    void pPause.then(() => { pauseResolved = true })
    await new Promise(r => setTimeout(r, 50))
    expect(pauseResolved).toBe(true) // run 退出后 pause 才返回
    expect((s as any).running).toBe(false)
    await pRun
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('pause() 触发 abortScroll 滚动中止信号（页面级即时停止，不等 scrollToBottom 跑完）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser, 50)
    const pRun = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // run 已进入循环，正在第一个 sleep
    await s.pause()
    expect(browser.abortScroll).toHaveBeenCalledTimes(1)
    await pRun
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('暂停落在 scrollToBottom 内（abortWait 为 null）→ 返回后跳过收尾 sleep 立即进暂停态', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const events: unknown[] = []
    // 收尾 sleep=min(1500,2000,1000)=1000ms；本用例用显式 pause 触发，不依赖停滞阈值大小
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 500 }),
      getStallThresholdSec: () => 2
    })
    const pRun = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true) // run 已进入 scrollToBottom
    const pPause = s.pause() // 此时 abortWait 为 null：abortScroll 已发，但收尾 sleep 无人唤醒
    await new Promise(r => setTimeout(r, 10))
    browser.releaseScroll() // 页面脚本收到中止信号后返回
    await new Promise(r => setTimeout(r, 200)) // 若无守卫，run 还睡在 1000ms 收尾 sleep 里
    expect((s as any).running).toBe(false) // 已跳过收尾 sleep 退出
    await pPause
    await pRun
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('暂停后不等待立刻 resume → 等当前 run 退出后恢复运行（不被 running 挡回）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    advancingClock() // Task4：动态下限后 resume 出的第二个 run 需自然停滞（≥12s）才会终止，用虚拟时钟快进
    const { s } = setup(db, new FakeDownloader(), browser, 50)
    const pRun = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    const pPause = s.pause()
    browser.blockNextLoad() // resume 的新 run 将阻塞在 load，便于观察它确实重新开始
    const pResume = s.resume(taskId) // 不等待 pause 完成
    // 等 run#1 完全退出（暂停生效），再给 run#2 一点时间跑到阻塞的 load
    await Promise.all([pRun, pPause])
    await new Promise(r => setTimeout(r, 20))
    expect((s as any).running).toBe(true) // run#2 已开始（未被 running 挡回）
    browser.releaseLoad()
    await pResume
    expect((s as any).running).toBe(false)
  }, 10000)
})

describe('抓取硬截断到目标（A2）', () => {
  it('target=200、fetched=195、解析10条去重后8条 → 只插5条，fetched 恰为 200，DB 不超', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    // 预置 fetched_count=195（模拟已抓 195 条）
    db.prepare('UPDATE tasks SET fetched_count=195 WHERE id=?').run(taskId)
    // 预置 2 条同平台重复视频（进 seen，10 条去重后剩 8 条）
    for (const n of [9, 10]) {
      db.prepare(
        "INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,play_addr,duration,publish_time,stats,status,ai_verdict,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).run('douyin', 9999, `733${String(n).padStart(16, '0')}`, '重复', 'https://cdn.test/dup.mp4', 8000,
           new Date(1710000000 * 1000).toISOString(), '{}', 'pending', 'pass', new Date().toISOString())
    }
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad() // 挂起在 load：保持 taskId/adapter 就绪且任务仍在运行
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    const manyRawJson = {
      aweme_list: Array.from({ length: 10 }, (_, i) => ({
        aweme_id: `733${String(i + 1).padStart(16, '0')}`,
        desc: `测试视频标题${i + 1}`,
        create_time: 1710000000,
        author: { sec_uid: `SEC_00${i + 1}`, nickname: `作者${i + 1}` },
        video: { play_addr: { url_list: [`https://cdn.test/v${i + 1}.mp4`] } },
        statistics: { digg_count: 42 },
        duration: 8000
      }))
    }
    const r = await s.handleRaw(douyinAdapter, rawUrl, manyRawJson)
    expect(r).toEqual({ items: 10, kept: 8 })

    expect((s as any).fetched).toBe(200) // 恰好到 target，不超
    expect(db.prepare('SELECT fetched_count FROM tasks WHERE id=?').get(taskId)).toEqual({ fetched_count: 200 })
    const rows = db.prepare('SELECT aweme_id FROM videos WHERE task_id=? ORDER BY aweme_id').all(taskId) as Array<{ aweme_id: string }>
    expect(rows.map(x => x.aweme_id)).toEqual([
      '7330000000000000001', '7330000000000000002', '7330000000000000003',
      '7330000000000000004', '7330000000000000005'
    ]) // 只插前 5 条，第 6 条起被截断

    // 199→200 已通过 handleRaw 内的 fetched>=target 分支中止在途滚动，走 reached 收尾，无需等停滞
    browser.releaseLoad()
    await p
  }, 10000)

  it('AI 过滤批处理中途被暂停 → fetched_count 已持久化（resume 不越界）', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, aiFilterEnabled: true })
    const browser = new FakeBrowser()
    browser.blockNextLoad()
    // 受控 AI 过滤器：judgeFilter 挂起直到门闩打开，制造批处理中途的暂停窗口
    let gate!: () => void
    const gateP = new Promise<void>(r => { gate = r })
    const analyzer = {
      judgeFilter: vi.fn(async () => { await gateP; return { pass: true } })
    } as unknown as import('../src/main/analyzer').Analyzer
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01
    })
    const pRun = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // 任务挂起在 load，taskId 就绪

    const twoRawJson = {
      aweme_list: Array.from({ length: 2 }, (_, i) => ({
        aweme_id: `733${String(i + 1).padStart(16, '0')}`,
        desc: `测试视频标题${i + 1}`,
        create_time: 1710000000,
        author: { sec_uid: `SEC_00${i + 1}`, nickname: `作者${i + 1}` },
        video: { play_addr: { url_list: [`https://cdn.test/v${i + 1}.mp4`] } },
        statistics: { digg_count: 42 },
        duration: 8000
      }))
    }
    const pRaw = s.handleRaw(douyinAdapter, rawUrl, twoRawJson)
    await new Promise(r => setTimeout(r, 10)) // 批内第 1 条卡在 AI 过滤
    const pPause = s.pause() // 暂停落在 AI 过滤窗口（不 await：run 还挂在 load，pause 等 runExit）
    gate()
    await pRaw
    // 关键断言：abort 前 fetched_count 已持久化，resume 按新值重算 remaining 不会越界
    expect(db.prepare('SELECT fetched_count FROM tasks WHERE id=?').get(taskId)).toEqual({ fetched_count: 1 })
    expect((s as any).fetched).toBe(1)
    browser.releaseLoad()
    await Promise.all([pRun, pPause])
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)
})

describe('滚动参数传递（T2）', () => {
  it('run 时把每页等待秒数参数传给 scrollToBottom', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    db.prepare('UPDATE tasks SET fetched_count=200 WHERE id=?').run(taskId) // 预置爬满：首轮滚动后即 reached 结束
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'scrollToBottom')
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      // 阈值 1s：首轮等待(1ms)不可能判停滞，确保滚动先发生（R11-3 心跳等待小步检查会提前截胡微阈值）
      getStallThresholdSec: () => 1
    })
    await s.run(taskId)
    expect(spy).toHaveBeenCalledWith({ waitMs: 8000 })
  }, 10000)
})

describe('停滞自救重搜（R12，删筛选后唯一自救）', () => {
  it('停滞 → 直接重搜：load 被调、URL 含关键词、reSearchCount 递增、progress 事件带值', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    advancingClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    // 第 2 次 load = 第 1 次重搜，URL 为关键词搜索页
    const searchUrl = douyinAdapter.buildSearchUrl('测试', input.filters)
    expect(loadSpy).toHaveBeenNthCalledWith(2, douyinAdapter, searchUrl)
    expect(loadSpy.mock.calls.length).toBe(4) // 初始 + 重搜 3 次
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 3 次）' })
    // progress 事件带重搜次数（渲染层展示用）
    const progress = events.filter(e => (e as { type?: string }).type === 'task:progress' && (e as { reSearchCount?: number }).reSearchCount !== undefined)
    expect(progress.map(e => (e as { reSearchCount: number }).reSearchCount)).toEqual([1, 2, 3])
    expect((s as any).reSearchCount).toBe(3)
  }, 10000)

  it('重搜 3 次仍爬不满 → paused error=stalled + notice「已重搜 3 次仍爬不满」', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    advancingClock()
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(events).toContainEqual({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('5 秒停滞（阈值注入 5s + fake 时钟 6s）→ 秒数制判定触发重搜', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    // 递增时钟：lastFetchedAt 之后每次 Date.now() 都多走 6 秒 → 每轮必停滞（6s > 5s 阈值）
    let now = 1000000
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 6000))
    const loadSpy = vi.spyOn(browser, 'load')
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 5 // 注入 5s 阈值
    })
    await s.run(taskId)
    // 5s 停滞走完整自救循环（重搜 ×3）后真正暂停（不是 stalled_verify）
    expect(loadSpy.mock.calls.length).toBe(4)
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('未停滞（时钟恒定，elapsed 恒 0）→ 不重搜、不暂停，直到手动暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = null
    vi.spyOn(Date, 'now').mockReturnValue(1000000) // 时钟恒定：elapsed 恒为 0，永远判不到停滞
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 80)) // 跑几轮：未停滞则持续抓取
    await s.pause()
    await p
    expect(loadSpy).toHaveBeenCalledTimes(1) // 只有初始加载，无重搜
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('作者任务停滞 → 同样重搜（重搜与任务类型无关，作者=主页/关键词=搜索页）', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, type: 'author', query: 'MS4wLjABAAAA1' })
    const browser = new FakeBrowser()
    advancingClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    // 重搜复用任务首屏 URL（作者=主页），不依赖任务类型判断
    expect(loadSpy.mock.calls.length).toBe(4) // 初始 + 重搜 3 次
    expect(loadSpy).toHaveBeenNthCalledWith(2, douyinAdapter, douyinAdapter.buildAuthorUrl('MS4wLjABAAAA1'))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('爬满目标 → done 不变（自救循环不干扰正常完成）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    db.prepare('UPDATE tasks SET fetched_count=200 WHERE id=?').run(taskId) // 模拟已爬满
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy).toHaveBeenCalledTimes(1) // 无重搜
    expect(events).toContainEqual({ type: 'task:done', taskId, fetched: 200 })
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
  }, 10000)

  it('非到底停滞 → 首轮即重搜（无观察延迟）；重搜 3 次超限后暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = null
    advancingClock()
    const bottomSpy = vi.spyOn(browser, 'findBottomText')
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad() // 初始加载
    const p = s.run(taskId)
    browser.releaseLoad() // 放行初始加载，进入循环
    browser.blockNextLoad() // 立即重新设锁（同步，先于 run 的微任务继续）：block 第 1 次重搜
    for (let i = 0; i < 300 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(2) // 已停在第 1 次重搜的 load（被 block）
    expect(bottomSpy.mock.calls.length).toBe(1) // 第 1 轮停滞即重搜：无观察延迟（若先观察一轮，此处为 2）
    expect((s as any).reSearchCount).toBe(1)
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    browser.releaseLoad()
    await p
    expect(loadSpy.mock.calls.length).toBe(4) // 初始 + 重搜 3 次
    expect((s as any).reSearchCount).toBe(3)
    expect(events).toContainEqual({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('零星数据持续流入（kept>0 → lastFetchedAt 持续刷新）→ 不误判停滞、不重搜', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser() // bottomText 默认「暂时没有更多了」
    const loadSpy = vi.spyOn(browser, 'load')
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 1 // 1 秒阈值：数据持续流入（<1s 间隔）则永不判停滞
    })
    const p = s.run(taskId)
    // 持续喂零星数据（每轮 kept>0 → lastFetchedAt 刷新），到底文案命中也不重搜——触发前提是停滞
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4))
      await s.handleRaw(douyinAdapter, rawUrl, sparseJson(i))
    }
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    await s.pause()
    await p
  }, 10000)

  it('停滞自救全链路日志（onFilterLog）：停滞检测 → 到底命中 → 每次重搜 → 重搜超限', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const logs: string[] = []
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12s，用虚拟时钟快进代替真实等待
    const s = new Scheduler({
      db, browser: new FakeBrowser(), analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    const all = logs.join('\n')
    // 触发决策每步：停滞检测（秒数制）→ 到底文案命中 → 立即重搜
    expect(all).toContain('停滞检测')
    expect(all).toContain('秒无新视频')
    expect(all).toContain('到底文案命中')
    expect(all).toContain('立即重搜')
    expect(all).toContain('第 1 次重搜')
    expect(all).toContain('第 3 次重搜')
    expect(all).toContain('已重搜 3 次仍爬不满')
  }, 10000)
})

/** 递增时钟：lastFetchedAt 之后每次 Date.now() 都多走 6 秒 → 每轮必停滞（6s > 默认 5s 阈值，
 *  Task4 动态下限后 minStall 也远小于 6 秒的累计增量，几次调用即可越过任意合理下限） */
function advancingClock(): void {
  let now = 1000000
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 6000))
}

describe('重搜冷却与到底立即重搜（R12）', () => {
  /** 受控时钟：now 由测试手动推进（停滞阈值用 0.01s，推进即判停滞） */
  function controlledClock(): (ms: number) => void {
    let t = 1000000
    vi.spyOn(Date, 'now').mockImplementation(() => t)
    return (ms: number) => { t += ms }
  }

  it('冷却期内再次自救 → 跳过本轮不重搜（日志「重搜冷却中」）；冷却过后才重搜', async () => {
    // Task4 说明：动态下限后，自然停滞阈值恒 ≥12s（(scrollIntervalMs+1500)/1000+5.5+5），
    // 而默认重搜冷却仅 10s——一旦触发外层"停滞"，reSearch 后 lastFetchedAt 与 lastRescueAt 会在
    // 同一时刻重置，下一次"停滞"必然已经过了 10s 冷却窗口，无法再用同一组时间戳自然构造出
    // "停滞已再次触发、但仍在重搜冷却内"的场景。改为直接调用被测的私有方法 rescueStall
    // （测试文件本就大量以 (s as any) 反射私有状态），绕开外层"停滞"触发门槛，只聚焦 rescueStall
    // 自身的冷却分支——冷却机制代码本身未改动，仍是真实调用真实实现。
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = null // 不走"到底立即重搜"，专测冷却分支
    const advance = controlledClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 999 // 阈值足够大：本用例不依赖外层"停滞"自然触发
    })
    browser.blockNextLoad() // 阻塞在初始 load：run 处于运行中（taskId/adapter/taskUrl 就绪），但不进入主循环
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    // 注：run() 自身卡在初始 load（被 blockNextLoad 阻塞、悬而未决）已经算 loadSpy 的第 1 次调用；
    // rescueStall 自己的重搜 load 另计一次，所以第 1 次重搜后 loadSpy 是 2 次，不是 1 次。
    const r1 = await (s as any).rescueStall(douyinAdapter, 200, 999)
    expect(r1).toBe('continue')
    expect(loadSpy.mock.calls.length).toBe(2) // 初始 load（悬而未决）+ 第 1 次重搜的 load
    expect((s as any).reSearchCount).toBe(1)

    advance(5000) // 冷却期内：距上次重搜仅 5s（< 10s 默认冷却）
    const r2 = await (s as any).rescueStall(douyinAdapter, 200, 999)
    expect(r2).toBe('skip')
    expect(logs.some(l => l.includes('重搜冷却中'))).toBe(true)
    expect(loadSpy.mock.calls.length).toBe(2) // 冷却中：未新增重搜
    expect((s as any).reSearchCount).toBe(1)

    advance(6000) // 冷却已过（累计 11s > 10s 默认冷却）
    const r3 = await (s as any).rescueStall(douyinAdapter, 200, 999)
    expect(r3).toBe('continue')
    expect(loadSpy.mock.calls.length).toBe(3) // 第 2 次重搜
    expect((s as any).reSearchCount).toBe(2)

    browser.releaseLoad()
    await s.pause()
    await p
    // 收尾落盘断言（审查补回）：暂停后 DB 必须是 paused/error=null——
    // 确认走的是用户暂停路径，没有被自然停滞误判成 stalled
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId))
      .toEqual({ status: 'paused', error: null })
  }, 10000)

  it('到底文案命中 → 忽略冷却立即重搜（冷却窗口内也不等）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = '暂时没有更多了' // 到底命中：冷却不生效
    const advance = controlledClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad() // 初始加载
    const p = s.run(taskId)
    // Task4：动态下限后自然停滞阈值 ≥12.001s（scrollIntervalMs=1）；每步推进需越过该下限
    advance(13000) // 停滞
    browser.releaseLoad() // → 第 1 次重搜（到底命中，lastRescueAt 起算）
    for (let i = 0; i < 500 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(2)
    expect((s as any).reSearchCount).toBe(1)
    // 冷却窗口内（距上次重搜远小于 10s 默认冷却）再次停滞 → 到底命中 → 立即第 2 次重搜，不等冷却
    advance(13000)
    for (let i = 0; i < 500 && loadSpy.mock.calls.length < 3; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(3) // 冷却被忽略
    expect((s as any).reSearchCount).toBe(2)
    expect(logs.some(l => l.includes('重搜冷却中'))).toBe(false) // 冷却分支从未走
    expect(logs.some(l => l.includes('到底文案命中') && l.includes('立即重搜'))).toBe(true)
    // 继续 → 第 3 次重搜（冷却同样被忽略）
    advance(13000)
    for (let i = 0; i < 500 && loadSpy.mock.calls.length < 4; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(4)
    expect((s as any).reSearchCount).toBe(3)
    // 再停滞 → 重搜超限 → 暂停（受控时钟需再推进一步触发本轮停滞判定）
    advance(13000)
    await p
    expect((s as any).reSearchCount).toBe(3)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('停滞检测秒级心跳（R11-3）', () => {
  it('心跳 1s 粒度检测停滞（滚动中）→ abortScroll 中断在途滚动（不等整轮 ~4-15s 滚动自然结束）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const events: unknown[] = []
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12.001s，用虚拟时钟快进代替真实等待
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.1
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true)
    // 心跳每 1s 真实一次 tick，虚拟时钟每次 Date.now() 调用快进 6s，几个 tick 内即可越过 ≥12.001s 下限
    for (let i = 0; i < 600 && browser.abortScroll.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.abortScroll).toHaveBeenCalledTimes(1) // 心跳触发：停滞 && 滚动中 → 中断在途滚动
    browser.releaseScroll()
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('滚动中停滞 → 滚动返回后立即自救（重搜；不进整轮等待）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const events: unknown[] = []
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12.001s，用虚拟时钟快进代替真实等待
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.1
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true)
    for (let i = 0; i < 600 && browser.abortScroll.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.abortScroll).toHaveBeenCalled() // 心跳已中断在途滚动
    // Date.now 已被 advancingClock 接管，这里改用 performance.now()（不受该 mock 影响）量真实反应耗时
    const t0 = performance.now()
    browser.releaseScroll()
    for (let i = 0; i < 100 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 10))
    expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // 滚动返回后立即自救（重搜）
    expect(performance.now() - t0).toBeLessThan(500)
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('心跳等待阶段停滞 → 直接自救（未进滚动即重搜）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = null
    // Task4：动态下限后单次 advancingClock 增量（6s）不足以在等待阶段的第一次检查就越过 ≥12.001s 下限
    // （等待阶段 waitTotal 极小、只检查一次就会进入滚动）。用「自动递增 + 一次性额外推远」的混合时钟：
    // load 被阻塞期间先额外推远一大步，确保 load 放行后等待阶段的第一次停滞检查就直接命中、不先进入滚动；
    // 之后仍按 advancingClock 的节奏持续递增，保证后续仍能自然走完 3 次重搜耗尽的收尾。
    let now = 1000000
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 6000))
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad() // 初始加载
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // run 卡在 load，lastFetchedAt 已用首次 Date.now() 捕获
    now += 20000 // 一次性额外推远，越过动态下限（scrollIntervalMs=1 时约 12.001s）
    browser.releaseLoad()
    browser.blockNextLoad() // block 第 1 次重搜（等待阶段触发）
    for (let i = 0; i < 300 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(2)
    expect(browser.scrollEntered).toBe(false) // 尚未滚动：停滞在等待阶段就被自救捕获
    expect((s as any).reSearchCount).toBe(1)
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    browser.releaseLoad()
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('rescuing 期间心跳不重复触发（重搜挂起时即使滚动标志置位也不 abortScroll）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    advancingClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad() // 初始加载
    const p = s.run(taskId)
    browser.releaseLoad()
    browser.blockNextLoad() // block 第 1 次重搜（rescuing 期间挂起）
    for (let i = 0; i < 300 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 2))
    expect(loadSpy.mock.calls.length).toBe(2) // 已进入重搜（load 被 block，rescuing 置位中）
    ;(s as any).scrolling = true // 模拟滚动标志被置位（心跳的唯一触发条件）
    await new Promise(r => setTimeout(r, 1500)) // 跨过 ≥1 个心跳周期
    expect(browser.abortScroll).not.toHaveBeenCalled() // rescuing 期间心跳不触发
    browser.releaseLoad()
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('验证码识别与长操作兜底（R11-4）', () => {
  it('未登录独立暂停为 login_required，并提示先登录当前平台', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.loginText = '扫码登录'
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 60
    })
    const p = s.run(taskId)
    for (let i = 0; i < 400; i++) {
      const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }
      if (row.status === 'paused') break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId))
      .toEqual({ status: 'paused', error: 'login_required' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'login_required' })
    expect(events).toContainEqual({ type: 'task:notice', text: '请先在内置浏览器登录 抖音' })
    expect(events).not.toContainEqual(expect.objectContaining({ reason: 'stalled_verify' }))
    await p
  }, 10000)

  it('心跳检测到验证码（任意时刻）→ 自动暂停 stalled_verify（error=stalled_verify + task:paused reason=stalled_verify）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.verifyText = '请完成安全验证'
    const events: unknown[] = []
    // 阈值 60s：远高于 Task4 动态下限（scrollIntervalMs=1 时约 12.001s），原样使用，不干扰自救；验证码是唯一退出路径
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 60
    })
    const p = s.run(taskId)
    // 心跳每 2s 查一次验证码：第 2 个 tick（~2s）命中 → 主循环检查点 break → 暂停
    for (let i = 0; i < 400; i++) {
      const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }
      if (row.status === 'paused') break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled_verify' })
    await p
  }, 10000)

  it('停滞自救先查验证码 → 命中直接暂停 stalled_verify（不重搜、不查到底）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.verifyText = '请完成机器人验证'
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy).toHaveBeenCalledTimes(1) // 只有初始加载：自救先查验证码，绝不重搜
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled_verify' })
  }, 10000)

  it('verifyFound 已置位（心跳命中）→ 停滞自救直接暂停，不重搜', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    ;(s as any).verifyFound = '请完成机器人验证' // 模拟心跳已检测到验证码
    browser.releaseLoad()
    await p
    expect(loadSpy).toHaveBeenCalledTimes(1) // 未重搜
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled_verify' })
  }, 10000)

  it('重搜加载失败/超时 → 重搜计数已消耗并继续（任务不判失败，走重搜上限）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12.001s，需多次自然停滞（4 轮），用虚拟时钟快进
    // 初始加载成功；第 1 次重搜抛超时标记错误；后续重搜成功
    const loadSpy = vi.spyOn(browser, 'load')
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(Object.assign(new Error('页面加载超时（30000ms）'), { code: 'OP_TIMEOUT' }))
      .mockResolvedValue()
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy).toHaveBeenCalledTimes(4) // 初始 + 3 次重搜（超时那次也算一次计数）
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    expect((s as any).reSearchCount).toBe(3)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('心跳等待阶段停滞 → 心跳直接触发自救（fake timers：轮末检查点未到已重搜）', async () => {
    vi.useFakeTimers()
    try {
      const db = newDb()
      const taskId = createTask(db, input)
      const browser = new FakeBrowser()
      const loadSpy = vi.spyOn(browser, 'load')
      const events: unknown[] = []
      // 滚动间隔 700ms + Task4 动态下限：minStall=(700+1500)/1000+5.5+5=12.7s，
      // 阈值注入 5s 远低于下限，实际按 12.7s 执行；推进虚拟时钟到 13.5s 确保跨过下限触发心跳自救
      const s = new Scheduler({
        db, browser, analyzer: null, downloader: new FakeDownloader(),
        emit: e => events.push(e),
        getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 700 }),
        getStallThresholdSec: () => 5
      })
      const p = s.run(taskId)
      await vi.advanceTimersByTimeAsync(13500)
      expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // 心跳已触发重搜（初始 + 重搜）
      expect((s as any).reSearchCount).toBeGreaterThanOrEqual(1)
      expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
      await s.pause()
      await p
    } finally {
      vi.useRealTimers()
    }
  }, 10000)
})

describe('爬满即停与启动即时进度（R11-2）', () => {
  it('handleRaw 填满 target → abortScroll 被调（中断在途滚动，不再等整轮结束）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    db.prepare('UPDATE tasks SET fetched_count=199 WHERE id=?').run(taskId) // 差 1 条填满
    const browser = new FakeBrowser()
    const dl = new FakeDownloader()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson) // 199→200 填满
    expect(browser.abortScroll).toHaveBeenCalledTimes(1)

    browser.releaseLoad()
    await p
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
  }, 10000)

  it('滚动中爬满 → 滚动返回后立即 done（reached 检查在收尾 sleep 前，不等 1000ms）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    db.prepare('UPDATE tasks SET fetched_count=199 WHERE id=?').run(taskId)
    const browser = new FakeBrowser()
    const dl = new FakeDownloader()
    const events: unknown[] = []
    // 收尾 sleep = min(1500, 8000/4, 1000) = 1000ms；fetched>=target 检查在滚动返回后无条件执行，不依赖停滞阈值
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: dl,
      emit: e => events.push(e),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 500 }),
      getStallThresholdSec: () => 2
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true) // run 已进入 scrollToBottom

    await s.handleRaw(douyinAdapter, rawUrl, rawJson) // 199→200 填满（滚动进行中）
    expect(browser.abortScroll).toHaveBeenCalledTimes(1)

    const t0 = performance.now()
    browser.releaseScroll()
    await p
    expect(performance.now() - t0).toBeLessThan(500) // 未经 1000ms 收尾 sleep，立即进 reached
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
  }, 10000)

  it('run 启动立即发首个 progress 事件（任务一运行 UI 即显示"进行中"，不用等第一轮数据）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextLoad() // 挂起在 load：首轮数据还没到，进度事件应已发出
    const { s, events } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    expect(events[0]).toEqual({ type: 'task:progress', taskId, fetched: 0, status: 'running' })
    // Task4：不依赖自然停滞收尾——本用例只关心启动即发的首个事件，显式 pause 即可
    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('status=pending 的任务可被 run 正常启动（UI「开始」/重启恢复走同一通道）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'pending' }) // 创建即 pending
    advancingClock() // Task4：动态下限后自然停滞阈值 ≥12.001s，用虚拟时钟快进代替真实等待
    const { s, events } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(events[0]).toEqual({ type: 'task:progress', taskId, fetched: 0, status: 'running' }) // 启动即进行中
    // run 对 pending 无阻碍：正常跑完自救循环（停滞自动暂停）
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('停滞阈值动态下限（Task4：真机验收实测——阈值小于正常周期需要值时自救循环绞杀正常滚动）', () => {
  it('用户阈值低于「滚动周期」需要值 → 按下限执行（阈值内不该触发自救），且打印抬高说明日志（不静默覆盖用户配置）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const logs: string[] = []
    // scrollIntervalMs=3500（默认档位）→ minStall=(3500+1500)/1000+5.5+5=15.5s；用户设 1s，远低于下限
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 3500 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 1
    })
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // 等 run 跑过首个 await（load），this.stallSec 才被赋值
    expect((s as any).stallSec).toBeCloseTo(15.5, 5)
    expect(logs.some(l => l.includes('停滞阈值：用户设 1 秒 < 滚动周期需要 15.5 秒 → 实际按 15.5 秒执行'))).toBe(true)
    // 等待时长远超用户设的 1 秒阈值（若未加下限，此时早已判停滞并触发过重搜），但仍在 15.5s 下限内，不该触发自救
    await new Promise(r => setTimeout(r, 3000))
    expect(loadSpy).toHaveBeenCalledTimes(1) // 只有初始加载：阈值内不该触发自救重搜
    await s.pause()
    await p
  }, 10000)

  it('用户阈值高于「滚动周期」需要值 → 原样使用用户设置，不打印抬高日志', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 3500 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 100 // 远高于 15.5s 下限
    })
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 20))
    expect((s as any).stallSec).toBe(100)
    expect(logs.some(l => l.includes('停滞阈值'))).toBe(false)
    await s.pause()
    await p
  }, 10000)
})

describe('scrollIntervalMs 每次 run 现读（Task4：设置保存不重启也生效）', () => {
  it('改设置后不重启，下一次 run/resume 使用新的 scrollIntervalMs', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    let interval = 111
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: interval }),
      getStallThresholdSec: () => 999 // 阈值足够大：本用例只关心 scrollIntervalMs 是否现读，不依赖自然停滞
    })
    const p1 = s.run(taskId)
    await new Promise(r => setTimeout(r, 20))
    expect((s as any).scrollIntervalMs).toBe(111)
    await s.pause()
    await p1

    interval = 222 // 模拟设置页保存了新值（scheduler 实例不重启，getScrollParams 桩可变）
    const p2 = s.resume(taskId)
    await new Promise(r => setTimeout(r, 20))
    expect((s as any).scrollIntervalMs).toBe(222)
    await s.pause()
    await p2
  }, 10000)
})

describe('自救日志顺序（Task4：重搜用尽后不再打印撒谎的"执行重搜"）', () => {
  it('重搜 3 次用尽后再次停滞 → 不再出现"执行重搜"日志行，只有"自动暂停"', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.bottomText = null // 走"未找到到底文案...执行重搜"分支（旧版超限时仍会打印这条撒谎日志）
    advancingClock()
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    const executeLogs = logs.filter(l => l.includes('执行重搜'))
    const pausedLogs = logs.filter(l => l.includes('已重搜 3 次仍爬不满'))
    expect(executeLogs.length).toBe(3) // 3 次真实重搜各打 1 条；重搜用尽那一轮不再多打这条假日志
    expect(pausedLogs.length).toBe(1)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('P1.5：URL 双重包裹修复——scheduler 防御性归一', () => {
  it('query=完整主页 URL 的历史任务（重启恢复的老 pending 行）→ browser.load 收到单层 URL，不双重包裹', async () => {
    const db = newDb()
    const fullUrl = 'https://www.douyin.com/user/SEC_LEGACY_1'
    // 模拟老版本写入的历史行：query 直接存了完整 URL（P1.5 修复前 FilterForm 的行为）
    const taskId = createTask(db, { ...input, type: 'author', query: fullUrl })
    const browser = new FakeBrowser()
    advancingClock()
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(browser.lastUrl).toBe('https://www.douyin.com/user/SEC_LEGACY_1') // 单层，不是套了两层 buildAuthorUrl
  }, 10000)
})

// 导入作者的「名称强绑定链接」校验。搭爬主页那次页面加载的车——不额外开页面、不增加风控。
describe('导入作者的名称校验（R16）', () => {
  function seed(db: DatabaseSync, nickname: string) {
    const a = insertAuthorIfAbsent(db, {
      platform: 'douyin', secUid: 'SEC_V', nickname,
      homeUrl: 'https://www.douyin.com/user/SEC_V'
    })
    const taskId = createTask(db, { ...input, type: 'author', query: 'SEC_V' })
    return { authorId: a.id, taskId }
  }
  const verifyRow = (db: DatabaseSync, id: number) =>
    db.prepare('SELECT verify_state, verify_error FROM authors WHERE id = ?').get(id) as
      { verify_state: string; verify_error: string | null }
  const taskRow = (db: DatabaseSync, id: number) =>
    db.prepare('SELECT status, error FROM tasks WHERE id = ?').get(id) as
      { status: string; error: string | null }

  it('昵称对得上（真实昵称多带后缀）→ 标 ok，不中断爬取', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '张三 日常'
    const { authorId, taskId } = seed(db, '张三')
    const { s } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 30))
    await s.pause()
    await p
    expect(verifyRow(db, authorId).verify_state).toBe('ok')
    expect(verifyRow(db, authorId).verify_error).toBe(null)
    expect(taskRow(db, taskId).error).not.toBe('author_mismatch')
  })

  it('昵称对不上 → 中止任务 + 标 failed + 原因写明两个名字（不放行）', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '王五'
    const { authorId, taskId } = seed(db, '张三')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    const v = verifyRow(db, authorId)
    expect(v.verify_state).toBe('failed')
    expect(v.verify_error).toContain('王五')
    expect(v.verify_error).toContain('张三')
    expect(taskRow(db, taskId).status).toBe('paused')
    expect(taskRow(db, taskId).error).toBe('author_mismatch')
  })

  it('页面打不开/取不到昵称 → 同样拒绝，原因与「对不上」区分开', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = null
    const { authorId, taskId } = seed(db, '张三')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(verifyRow(db, authorId).verify_state).toBe('failed')
    expect(verifyRow(db, authorId).verify_error).toContain('没取到')
    expect(taskRow(db, taskId).error).toBe('author_unverifiable')
  })

  it('抓取自动收录的作者（verify_state 为 null）不做校验——数据来自真实接口', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '完全无关的名字'
    upsertAuthor(db, {
      awemeId: 'A', title: 't', authorSecUid: 'SEC_V', authorNickname: '原作者',
      authorHomeUrl: 'u', playUrl: 'p', coverUrl: '', width: 0, height: 0, durationSec: 1, publishTime: 1, likes: 0
    }, 'douyin')
    const taskId = createTask(db, { ...input, type: 'author', query: 'SEC_V' })
    const { s } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 30))
    await s.pause()
    await p
    expect(taskRow(db, taskId).error).not.toBe('author_mismatch')
    expect(taskRow(db, taskId).error).not.toBe('author_unverifiable')
  })

  // 边界：作者行在任务真正 run 之前被删除（例如导入后、爬主页前手动删除该作者）。
  // 当前实现按 sec_uid 在 listAuthors() 里找不到行就直接放行（不校验、不暂停），
  // 而不是把它当「校验失败」处理。锁住这个现状，供项目负责人评估是否符合预期
  // （风险：被删除作者的任务会无提示地继续跑，用户不会看到任何校验相关提示）。
  it('作者已被删除（任务 run 前该 sec_uid 已无作者行）→ 不校验、不暂停，任务照常推进', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '随便什么昵称' // 即便页面能取到昵称，也不该被读取——因为压根没有作者行可比对
    const taskId = createTask(db, { ...input, type: 'author', query: 'SEC_DELETED' })
    const { s } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 30))
    await s.pause()
    await p
    // 注意：这里的 'paused' 是测试自己调用 s.pause() 造成的（收尾动作，避免测试挂起），
    // 不是校验失败导致的暂停——所以只断言 error 原因，不断言 status。
    expect(taskRow(db, taskId).error).not.toBe('author_mismatch')
    expect(taskRow(db, taskId).error).not.toBe('author_unverifiable')
    expect(browser.readAuthorNicknameCalls).toBe(0) // 没有作者行可校验，直接跳过，不发起昵称读取
  })
})

// ---------------------------------------------------------------------------
// 任务接口匹配下沉到适配器：scheduler 不再自己认抖音路径。
// 快手关键词/作者/详情共用同一个 /graphql，URL 区分不了，判定必须由适配器做。
// ---------------------------------------------------------------------------
describe('handleRaw 把任务接口匹配委托给适配器', () => {
  /** 起一个挂在 load 上的关键词任务，保持 taskId/adapter 就绪 */
  async function runningKeywordTask() {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    advancingClock()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad()
    void s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    return { db, taskId, s, browser }
  }

  it('适配器说不匹配 → 拒收，即使 URL 长得像抖音搜索接口', async () => {
    const { db, taskId, s } = await runningKeywordTask()
    const spy = vi.spyOn(douyinAdapter, 'matchesTaskResponse').mockReturnValue(false)

    expect(await s.handleRaw(douyinAdapter, rawUrl, rawJson)).toBeNull()
    expect(spy).toHaveBeenCalledWith('keyword', rawUrl, rawJson)
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 0 })
  })

  it('适配器说匹配 → 收下，即使 URL 不含 /search/（快手全走 /graphql 时必须如此）', async () => {
    const { db, taskId, s } = await runningKeywordTask()
    vi.spyOn(douyinAdapter, 'matchesTaskResponse').mockReturnValue(true)
    // 这条 URL 命中 apiUrlPatterns 但不含 /search/：旧的硬编码规则会把它判给"作者任务"而拒绝
    const postUrl = 'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC_001'

    expect(await s.handleRaw(douyinAdapter, postUrl, rawJson)).toMatchObject({ kept: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 1 })
  })

  it('apiUrlPatterns 仍是第一道闸：URL 不属于本平台接口时，适配器判定根本不会被问', async () => {
    const { s } = await runningKeywordTask()
    const spy = vi.spyOn(douyinAdapter, 'matchesTaskResponse').mockReturnValue(true)

    expect(await s.handleRaw(douyinAdapter, 'https://www.douyin.com/static/logo.png', rawJson)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('抖音三类任务的原有规则不回退（真实适配器，不打桩）', async () => {
    const search = 'https://www.douyin.com/aweme/v1/web/search/item/?device_platform=webapp'
    const post = 'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC_001'
    expect(douyinAdapter.matchesTaskResponse('keyword', search, rawJson)).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('keyword', post, rawJson)).toBe(false)
    expect(douyinAdapter.matchesTaskResponse('author', post, rawJson)).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('author', search, rawJson)).toBe(false)
  })
})

// 真机踩到的诊断黑洞：run() 外面是个兜底 catch，任何异常一律记成 error='network'。
// 用户看到「网络错误」，而真实原因（页面 30 秒没打开、代码抛错…）被整个吞掉，
// 日志里一个字都没有，只能靠猜。
describe('任务失败要留下可读原因（不再是"network"黑洞）', () => {
  it('页面加载超时 → 错误码是 page_timeout，不再笼统记成 network', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.failLoad = true
    browser.loadError = Object.assign(new Error('页面加载超时'), { code: 'OP_TIMEOUT' })
    const { s } = setup(db, new FakeDownloader(), browser)

    await s.run(taskId)
    const row = db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId) as { status: string; error: string }
    expect(row.status).toBe('failed')
    expect(row.error).toBe('page_timeout')
  })

  it('任何失败都把真实原因写进日志面板，排查不用再猜', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.failLoad = true
    browser.loadError = new Error('ERR_CONNECTION_TIMED_OUT')
    const { s, logs } = setup(db, new FakeDownloader(), browser)

    await s.run(taskId)
    expect(logs.some(l => l.includes('ERR_CONNECTION_TIMED_OUT'))).toBe(true)
  })

  it('非超时异常仍记 network（既有分类不变），但日志里能看到它到底是什么', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.failLoad = true
    browser.loadError = new Error('boom')
    const { s, logs } = setup(db, new FakeDownloader(), browser)

    await s.run(taskId)
    expect((db.prepare('SELECT error FROM tasks WHERE id=?').get(taskId) as { error: string }).error).toBe('network')
    expect(logs.some(l => l.includes('boom'))).toBe(true)
  })
})

describe('R20 作者主页按日期段：比结束日期还新的作品要翻过去，不算卡住也不算风控', () => {
  const authorUrl = 'https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp'
  const authorInput: CreateTaskInput = {
    ...input, type: 'author', query: 'https://www.douyin.com/user/SEC_R20',
    filters: { timeRange: 'custom', startDate: '2024-03-10', endDate: '2024-03-20', duration: 'all', targetCount: 200 }
  }
  function json(id: string, createTime: number): unknown {
    return { aweme_list: [{ aweme_id: id, desc: '作品', create_time: createTime, author: { sec_uid: 'SEC_R20', nickname: '作者' },
      video: { play_addr: { url_list: ['https://cdn.test/r20.mp4'] } }, statistics: { digg_count: 1 }, duration: 8000 }] }
  }
  const cst = (iso: string): number => Date.parse(iso + '+08:00') / 1000

  it('连续多批都比结束日期新 → 不累计空轮、不当风控暂停，且刷新「最近有进展」时刻（不会被判停滞重搜回顶部）', async () => {
    const db = newDb()
    const taskId = createTask(db, authorInput)
    const browser = new FakeBrowser()
    const { s, logs } = setup(db, new FakeDownloader(), browser)
    let now = 5_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    for (let i = 0; i < 6; i++) {
      now += 60_000
      const r = await s.handleRaw(douyinAdapter, authorUrl, json(`73300000000000020${i}0`, cst('2024-04-01T12:00:00')))
      expect(r).toEqual({ items: 1, kept: 0 })
      expect((s as any).emptyRounds).toBe(0)
      expect((s as any).aborted).toBe(false)
      expect((s as any).lastFetchedAt).toBe(now)
    }
    expect(logs.filter(l => l.includes('还没到你选的日期段')).length).toBe(1) // 只打一次，不刷屏

    // 翻到日期段内 → 正常入库
    await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000002999', cst('2024-03-15T12:00:00')))
    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 1 })

    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('结束日期当天北京时间 23:59 发的算在段内；次日 00:00 发的算「更新」要翻过去', async () => {
    const db = newDb()
    const taskId = createTask(db, authorInput)
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    expect(await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000003001', cst('2024-03-21T00:00:00')))).toEqual({ items: 1, kept: 0 })
    expect(await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000003002', cst('2024-03-20T23:59:00')))).toEqual({ items: 1, kept: 1 })

    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('起点按北京时间算：起始日当天早上 1 点发的（UTC 还是前一天）不能被当成「翻过日期段」', async () => {
    const db = newDb()
    const taskId = createTask(db, authorInput)
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    expect(await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000004001', cst('2024-03-10T01:00:00')))).toEqual({ items: 1, kept: 1 })
    expect((s as any).pastRange).toBe(false)
    await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000004002', cst('2024-03-09T23:59:59')))
    expect((s as any).pastRange).toBe(true)

    browser.releaseLoad()
    await p
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('done')
  }, 10000)

  it('只填「从」：没有结束日期，新作品照常收', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...authorInput, filters: { timeRange: 'custom', startDate: '2024-03-10', duration: 'all', targetCount: 200 } })
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    expect(await s.handleRaw(douyinAdapter, authorUrl, json('7330000000000005001', cst('2025-01-01T12:00:00')))).toEqual({ items: 1, kept: 1 })
    browser.releaseLoad()
    await s.pause()
    await p
  }, 10000)

  it('对照：关键词任务不适用（搜索结果不按时间排）——连续空批仍按原规则当风控', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, filters: authorInput.filters })
    const browser = new FakeBrowser()
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    for (let i = 0; i < 3; i++) {
      await s.handleRaw(douyinAdapter, rawUrl, json(`73300000000000060${i}0`, cst('2024-04-01T12:00:00')))
    }
    expect((s as any).aborted).toBe(true)
    browser.releaseLoad()
    await p
  }, 10000)
})

describe('R20 看门狗：任务卡住不动 → 强制停下、标「卡住」、放行下一个', () => {
  function build(db: DatabaseSync, browser: FakeBrowser, over: Record<string, unknown> = {}) {
    const events: Array<Record<string, unknown>> = []
    const logs: string[] = []
    const s = new Scheduler({
      db, browser: browser as never, analyzer: null, downloader: new FakeDownloader() as never,
      emit: e => events.push(e as never),
      onFilterLog: m => logs.push(m),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01,
      getStuckTimeoutMin: () => 3,
      ...over
    })
    return { s, events, logs }
  }
  afterEach(() => { vi.useRealTimers() })

  it('滚动卡死（页面不回话）→ 3 分钟没进展即强制停：paused/stuck、发 task:paused(stuck)、刷新页面、调度器空出来', async () => {
    vi.useFakeTimers()
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll() // 永不释放 = 页面卡死
    const { s, events, logs } = build(db, browser)
    void s.run(taskId)
    await vi.advanceTimersByTimeAsync(10)
    expect(browser.scrollEntered).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(s.isRunning).toBe(true) // 还没到 3 分钟
    await vi.advanceTimersByTimeAsync(60 * 1000 + 5000)

    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stuck' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stuck' })
    expect(events.some(e => e.type === 'task:notice' && String(e.text).includes('卡住'))).toBe(true)
    expect(logs.some(l => l.includes('任务卡住了'))).toBe(true)
    expect(browser.resetPage).toHaveBeenCalled()
    expect(s.isRunning).toBe(false)
    expect(s.currentTaskId).toBe(0)
  })

  it('强制停之后下一个任务能正常开跑；卡住的旧 run 事后醒来不会碰新任务的状态、也不改旧任务的「卡住」标记', async () => {
    vi.useFakeTimers()
    const db = newDb()
    const t1 = createTask(db, input)
    const t2 = createTask(db, { ...input, query: '第二个' })
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const { s, events } = build(db, browser)
    const p1 = s.run(t1)
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 10000)
    expect(s.isRunning).toBe(false)

    const p2 = s.run(t2)
    await vi.advanceTimersByTimeAsync(10)
    expect(s.isRunning).toBe(true)
    expect(s.currentTaskId).toBe(t2)
    const t1EventsBefore = events.filter(e => e.taskId === t1).length

    browser.releaseScroll() // 旧 run 醒来
    await p1
    await vi.advanceTimersByTimeAsync(10)
    expect(s.currentTaskId).toBe(t2)
    expect(s.isRunning).toBe(true)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(t1)).toEqual({ status: 'paused', error: 'stuck' })
    expect(events.filter(e => e.taskId === t1).length).toBe(t1EventsBefore)

    const pp = s.pause()
    await vi.advanceTimersByTimeAsync(100)
    await pp
    await p2
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(t2) as { status: string }).status).toBe('paused')
  })

  it('数据一直在来（虽然滚动很慢）→ 看门狗不误伤', async () => {
    vi.useFakeTimers()
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const { s } = build(db, browser)
    const p = s.run(taskId)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60 * 1000)
      await s.handleRaw(douyinAdapter, rawUrl, sparseJson(9000 + i))
    }
    expect(s.isRunning).toBe(true)
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('running')
    browser.releaseScroll()
    const pp = s.pause()
    await vi.advanceTimersByTimeAsync(100)
    await pp
    await p
  })

  it('卡住判定分钟数来自设置（这里设 10 分钟：5 分钟时不动手）', async () => {
    vi.useFakeTimers()
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const { s } = build(db, browser, { getStuckTimeoutMin: () => 10 })
    void s.run(taskId)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10000)
    expect(s.isRunning).toBe(true)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(s.isRunning).toBe(false)
    expect((db.prepare('SELECT error FROM tasks WHERE id=?').get(taskId) as { error: string }).error).toBe('stuck')
  })
})

describe('R20 暂停/删除不再跟着卡死', () => {
  it('run 卡在页面里不退出 → pause() 最多等设定时间就强制停（paused、发暂停事件、调度器空出来）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll() // abortScroll 是 spy，不会真的让滚动返回 = 页面卡死
    const events: Array<Record<string, unknown>> = []
    const s = new Scheduler({
      db, browser: browser as never, analyzer: null, downloader: new FakeDownloader() as never,
      emit: e => events.push(e as never),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 999,
      pauseWaitMs: 50
    })
    const p = s.run(taskId)
    await vi.waitFor(() => expect(browser.scrollEntered).toBe(true))

    const started = performance.now()
    await s.pause()
    expect(performance.now() - started).toBeLessThan(2000)
    expect(s.isRunning).toBe(false)
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('paused')
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'user' })

    browser.releaseScroll()
    await p // 旧 run 事后退出，不报错、不改状态
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('paused')
  }, 10000)

  it('平台不存在（早退）→ 除了记 failed 还要发事件，队列才知道该放行下一个', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, platform: 'no_such_platform' })
    const { s, events } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('failed')
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'scheduler_error' })
  })
})

describe('R20 复查：作者主页按日期段的空批 / 重复批 / 翻到底', () => {
  const authorUrl = 'https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp'
  const authorInput: CreateTaskInput = {
    ...input, type: 'author', query: 'https://www.douyin.com/user/SEC_R20',
    filters: { timeRange: 'custom', startDate: '2024-03-10', endDate: '2024-03-20', duration: 'all', targetCount: 200 }
  }
  const cst = (iso: string): number => Date.parse(iso + '+08:00') / 1000
  function aweme(id: string, createTime: number, durationMs = 8000): Record<string, unknown> {
    return { aweme_id: id, desc: '作品', create_time: createTime, author: { sec_uid: 'SEC_R20', nickname: '作者' },
      video: { play_addr: { url_list: ['https://cdn.test/r20.mp4'] } }, statistics: { digg_count: 1 }, duration: durationMs }
  }
  const page = (list: unknown[], extra: Record<string, unknown> = {}): unknown => ({ aweme_list: list, ...extra })

  async function startBlocked(filters = authorInput.filters, seedIds: string[] = []) {
    const db = newDb()
    if (seedIds.length > 0) {
      // 以前抓过这段：库里已有这些作品（补抓同一段时 seen 去重会把它们全丢掉）
      const old = createTask(db, { ...authorInput, filters })
      insertVideos(db, douyinAdapter.parseApiJson(authorUrl, page(seedIds.map(id => aweme(id, cst('2024-03-15T12:00:00'))))), old, 'douyin')
    }
    const taskId = createTask(db, { ...authorInput, filters })
    const browser = new FakeBrowser()
    const { s, events, logs } = setup(db, new FakeDownloader(), browser)
    let now = 7_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    return { db, taskId, browser, s, events, logs, p, tick: (ms: number) => { now += ms }, now: () => now }
  }

  it('补抓同一段：日期段内的作品全都抓过（seen）→ 不累计空轮、不当风控；页面在往下翻就算进展', async () => {
    const ids = ['7330000000000007001', '7330000000000007002', '7330000000000007003', '7330000000000007004']
    const c = await startBlocked(authorInput.filters, ids)
    for (const id of ids) {
      c.tick(30_000)
      expect(await c.s.handleRaw(douyinAdapter, authorUrl, page([aweme(id, cst('2024-03-15T12:00:00'))]))).toEqual({ items: 1, kept: 0 })
      expect((c.s as any).emptyRounds).toBe(0)
      expect((c.s as any).aborted).toBe(false)
      expect((c.s as any).lastFetchedAt).toBe(c.now())
    }
    c.browser.releaseLoad()
    await c.s.pause()
    await c.p
  }, 10000)

  it('日期段内但被时长筛掉 → 同样不当风控', async () => {
    const c = await startBlocked({ ...authorInput.filters, duration: 'under30' })
    for (let i = 0; i < 4; i++) {
      await c.s.handleRaw(douyinAdapter, authorUrl, page([aweme(`733000000000000710${i}`, cst('2024-03-15T12:00:00'), 120_000)]))
    }
    expect((c.s as any).emptyRounds).toBe(0)
    expect((c.s as any).aborted).toBe(false)
    c.browser.releaseLoad()
    await c.s.pause()
    await c.p
  }, 10000)

  it('同一批「比结束日期还新」的作品反复出现（游标卡住 / 软风控）→ 只有第一次算进展，之后不刷新停滞计时', async () => {
    const c = await startBlocked()
    const same = page([aweme('7330000000000007201', cst('2024-04-01T12:00:00'))])
    c.tick(1000)
    await c.s.handleRaw(douyinAdapter, authorUrl, same)
    const first = c.now()
    expect((c.s as any).lastFetchedAt).toBe(first)
    for (let i = 0; i < 3; i++) {
      c.tick(30_000)
      await c.s.handleRaw(douyinAdapter, authorUrl, same)
    }
    expect((c.s as any).lastFetchedAt).toBe(first) // 没被重复批刷新 → 停滞检测会照常触发
    expect((c.s as any).aborted).toBe(false) // 也不当风控
    c.browser.releaseLoad()
    await c.s.pause()
    await c.p
  }, 10000)

  it('接口真的一条都没有（空列表）连续 3 批 → 仍按疑似风控暂停：error=risk、事件 reason=risk', async () => {
    const c = await startBlocked()
    for (let i = 0; i < 3; i++) await c.s.handleRaw(douyinAdapter, authorUrl, page([]))
    expect((c.s as any).aborted).toBe(true)
    c.browser.releaseLoad()
    await c.p
    expect(c.db.prepare('SELECT status, error FROM tasks WHERE id=?').get(c.taskId)).toEqual({ status: 'paused', error: 'risk' })
    expect(c.events).toContainEqual({ type: 'task:paused', taskId: c.taskId, reason: 'risk' })
  }, 10000)

  it('接口说后面没有了（has_more=0）→ 这一批处理完就算抓完（done）', async () => {
    const c = await startBlocked({ timeRange: 'custom', endDate: '2024-03-20', duration: 'all', targetCount: 200 })
    await c.s.handleRaw(douyinAdapter, authorUrl, page([aweme('7330000000000007301', cst('2024-03-01T12:00:00'))], { has_more: 0 }))
    expect((c.s as any).pastRange).toBe(true)
    c.browser.releaseLoad()
    await c.p
    const row = c.db.prepare('SELECT status, fetched_count FROM tasks WHERE id=?').get(c.taskId) as { status: string; fetched_count: number }
    expect(row).toEqual({ status: 'done', fetched_count: 1 })
    expect(c.logs.some(l => l.includes('已经翻到底'))).toBe(true)
  }, 10000)

  it('has_more=1 不收尾', async () => {
    const c = await startBlocked()
    await c.s.handleRaw(douyinAdapter, authorUrl, page([aweme('7330000000000007401', cst('2024-03-15T12:00:00'))], { has_more: 1 }))
    expect((c.s as any).pastRange).toBe(false)
    c.browser.releaseLoad()
    await c.s.pause()
    await c.p
  }, 10000)

  it('只填「到」、页面翻到底（停滞自救看到「暂时没有更多了」）→ 按抓完收尾（done），不重搜回顶部', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...authorInput, filters: { timeRange: 'custom', endDate: '2024-03-20', duration: 'all', targetCount: 200 } })
    const browser = new FakeBrowser() // bottomText 默认「暂时没有更多了」
    const loadSpy = vi.spyOn(browser, 'load')
    advancingClock()
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status).toBe('done')
    expect(loadSpy).toHaveBeenCalledTimes(1) // 只有开头那次，没有重搜
  }, 10000)

  it('对照：关键词任务到底照旧重搜（不适用「到底即抓完」）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    advancingClock()
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy.mock.calls.length).toBeGreaterThan(1)
  }, 10000)

  it('接口地址带的 sec_user_id 不是本任务的作者（上一个任务的页面数据）→ 不收', async () => {
    const c = await startBlocked()
    const body = page([aweme('7330000000000007501', cst('2024-03-15T12:00:00'))])
    expect(await c.s.handleRaw(douyinAdapter, authorUrl + '&sec_user_id=SOMEONE_ELSE', body)).toBeNull()
    expect(c.db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(c.taskId)).toEqual({ c: 0 })
    expect(await c.s.handleRaw(douyinAdapter, authorUrl + '&sec_user_id=SEC_R20', body)).toEqual({ items: 1, kept: 1 })
    c.browser.releaseLoad()
    await c.s.pause()
    await c.p
  }, 10000)
})

describe('R20 复查：暂停原因分清「用户」和「风控」', () => {
  it('用户点暂停 → 事件 reason=user（主进程据此按住队列）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const { s, events } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    browser.releaseLoad()
    await s.pause()
    await p
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'user' })
  }, 10000)
})

describe('R20 复查：卡住判定分钟数夹到 2-60', () => {
  afterEach(() => { vi.useRealTimers() })
  function build(db: DatabaseSync, browser: FakeBrowser, minutes: unknown) {
    const logs: string[] = []
    const s = new Scheduler({
      db, browser: browser as never, analyzer: null, downloader: new FakeDownloader() as never,
      emit: () => {}, onFilterLog: m => logs.push(m),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01,
      getStuckTimeoutMin: () => minutes as number
    })
    return { s, logs }
  }

  it('设成 100 分钟 → 按 60 分钟执行（并打日志说明）', async () => {
    vi.useFakeTimers()
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const { s, logs } = build(db, browser, 100)
    void s.run(taskId)
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(s.isRunning).toBe(true)
    await vi.advanceTimersByTimeAsync(60 * 1000 + 5000)
    expect(s.isRunning).toBe(false)
    expect((db.prepare('SELECT error FROM tasks WHERE id=?').get(taskId) as { error: string }).error).toBe('stuck')
    expect(logs.some(l => l.includes('按 60 分钟执行'))).toBe(true)
  })

  it.each([[0, 5], [Number.NaN, 5], [1, 2]])('设成 %s → 按 %s 分钟执行', async (v, expected) => {
    vi.useFakeTimers()
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    browser.blockNextScroll()
    const { s } = build(db, browser, v)
    void s.run(taskId)
    await vi.advanceTimersByTimeAsync(expected * 60 * 1000 - 20000)
    expect(s.isRunning).toBe(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(s.isRunning).toBe(false)
  })
})

// 2026-10-06 全面检查「数据安全」第二组：爬取提前收工 / 串任务
describe('B4 AI 筛选还没判完时任务被暂停 → 不往库里乱写', () => {
  it('判完时任务已经结束：视频不以 task_id=0 入库，也不发 taskId=0 的进度事件', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...input, aiFilterEnabled: true })
    const browser = new FakeBrowser()
    browser.blockNextLoad()
    let gate!: () => void
    const gateP = new Promise<void>(r => { gate = r })
    const analyzer = {
      judgeFilter: vi.fn(async () => { await gateP; return { pass: true } })
    } as unknown as import('../src/main/analyzer').Analyzer
    const events: Array<{ type: string; taskId?: number }> = []
    const s = new Scheduler({
      db, browser, analyzer, downloader: new FakeDownloader(),
      emit: e => events.push(e as { type: string; taskId?: number }),
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000, scrollIntervalMs: 1 }),
      getStallThresholdSec: () => 0.01
    })
    const pRun = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))
    const raw = {
      aweme_list: Array.from({ length: 2 }, (_, i) => ({
        aweme_id: `734${String(i + 1).padStart(16, '0')}`, desc: `标题${i + 1}`, create_time: 1710000000,
        author: { sec_uid: `SEC_AI${i}`, nickname: `作者${i}` },
        video: { play_addr: { url_list: [`https://cdn.test/ai${i}.mp4`] } }, statistics: { digg_count: 1 }, duration: 8000
      }))
    }
    const pRaw = s.handleRaw(douyinAdapter, rawUrl, raw)
    await new Promise(r => setTimeout(r, 10)) // 第 1 条卡在 AI 判定
    const pPause = s.pause()
    browser.releaseLoad()
    await Promise.all([pRun, pPause]) // 任务已经完全停下（调度器 taskId 已清零）
    const before = events.length
    gate()
    await pRaw
    expect(db.prepare('SELECT COUNT(*) n FROM videos WHERE task_id = 0').get()).toEqual({ n: 0 })
    expect(events.slice(before).filter(e => e.type === 'task:progress')).toEqual([])
  }, 10000)
})

describe('#7 被接管的旧 run 不再动新任务的状态', () => {
  it('两段式列表循环：stopped() 为真（哪怕 aborted 被新任务重置成 false）就不再查到底、不改 listEnded', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.bottomText = '暂时没有更多了'
    const bottomSpy = vi.spyOn(browser, 'findBottomText')
    const { s } = setup(db, new FakeDownloader(), browser)
    const anyS = s as any
    anyS.aborted = false
    anyS.lastFetchedAt = Date.now()
    const r = await anyS.runListDetails(douyinAdapter, 10, () => true)
    expect(r).toBe('reached')
    expect(bottomSpy).not.toHaveBeenCalled()
    expect(anyS.listEnded).toBe(false)
  })

  it('详情循环遍历的是开始时的候选快照：途中加进来的（新任务的）候选不会被旧 run 打开', async () => {
    const db = newDb()
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    const anyS = s as any
    anyS.listEnded = true
    anyS.listStubs.set('OLD1', { noteId: 'OLD1' })
    const opened: string[] = []
    anyS.resolveDetail = async (_a: unknown, stub: { noteId: string }) => {
      opened.push(stub.noteId)
      anyS.listStubs.set('NEW1', { noteId: 'NEW1' }) // 模拟新任务往同一个 Map 里加候选
      return null
    }
    await anyS.runListDetails(douyinAdapter, 10, () => false)
    expect(opened).toEqual(['OLD1'])
  })
})

describe('#9 校验没通过的导入作者，下次再爬还要校验', () => {
  function seedFailed(db: DatabaseSync, nickname: string) {
    const a = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'SEC_F', nickname, homeUrl: 'https://www.douyin.com/user/SEC_F' })
    setAuthorVerify(db, a.id, 'failed', '上次对不上')
    const taskId = createTask(db, { ...input, type: 'author', query: 'SEC_F' })
    return { authorId: a.id, taskId }
  }
  const state = (db: DatabaseSync, id: number) =>
    (db.prepare('SELECT verify_state FROM authors WHERE id = ?').get(id) as { verify_state: string }).verify_state

  it('上次失败、这次还是对不上 → 照样拦下', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '王五'
    const { authorId, taskId } = seedFailed(db, '张三')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(browser.readAuthorNicknameCalls).toBe(1)
    expect(state(db, authorId)).toBe('failed')
    expect(db.prepare('SELECT status, error FROM tasks WHERE id = ?').get(taskId)).toEqual({ status: 'paused', error: 'author_mismatch' })
  })

  it('上次失败（比如页面没打开）、这次对上了 → 标成通过，正常爬', async () => {
    const db = newDb()
    const browser = new FakeBrowser()
    browser.authorNickname = '张三'
    const { authorId, taskId } = seedFailed(db, '张三')
    const { s } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 30))
    await s.pause()
    await p
    expect(state(db, authorId)).toBe('ok')
  })
})

// 2026-10-09 「以前下过的也重新下」：任务勾了这个，抓到库里已有的视频也领过来重新下，并算进这个任务的条数
describe('任务勾了「以前下过的也重新下」', () => {
  const url = 'https://www.douyin.com/aweme/v1/web/search/item/?keyword=x'
  const json = (ids: string[]): unknown => ({ data: ids.map(id => ({ aweme_info: { aweme_id: id, desc: '作品', create_time: 1759000000,
    author: { sec_uid: 'SEC_RE', nickname: '作者' }, video: { play_addr: { url_list: ['https://cdn.test/' + id + '.mp4'] } },
    statistics: { digg_count: 1 }, duration: 8000 } })) })

  async function crawl(redownload: boolean): Promise<{ db: DatabaseSync; dl: FakeDownloader; t2: number }> {
    const db = newDb()
    const t1 = createTask(db, input)
    db.prepare("INSERT INTO videos (platform, task_id, aweme_id, title, status, fetched_at) VALUES ('douyin', ?, '7330000000000000301', 'old', 'deleted', '')").run(t1)
    const t2 = createTask(db, { ...input, filters: { ...input.filters, redownload } })
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad()
    const p = s.run(t2)
    await new Promise(r => setTimeout(r, 10))
    await s.handleRaw(douyinAdapter, url, json(['7330000000000000301', '7330000000000000302']))
    browser.releaseLoad()
    await s.pause()
    await p
    return { db, dl, t2 }
  }

  it('勾了 → 以前抓过的那条也领到这个任务、进下载队列', async () => {
    const { db, dl, t2 } = await crawl(true)
    const rows = db.prepare('SELECT aweme_id, status FROM videos WHERE task_id = ? ORDER BY aweme_id').all(t2) as Array<{ aweme_id: string; status: string }>
    expect(rows.map(r => r.aweme_id)).toEqual(['7330000000000000301', '7330000000000000302'])
    expect(dl.enqueued).toHaveLength(2)
  })

  it('没勾 → 以前抓过的跳过，只下新的', async () => {
    const { db, dl, t2 } = await crawl(false)
    const rows = db.prepare('SELECT aweme_id FROM videos WHERE task_id = ?').all(t2) as Array<{ aweme_id: string }>
    expect(rows.map(r => r.aweme_id)).toEqual(['7330000000000000302'])
    expect(dl.enqueued).toHaveLength(1)
  })
})
