import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { buildStopDecision, Scheduler } from '../src/main/scheduler'
import { initDb, createTask, listAuthors } from '../src/main/db'
import { douyinAdapter } from '../src/main/adapters/douyin'
import type { PlatformAdapter } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

describe('buildStopDecision', () => {
  it('达到目标 → reached', () => expect(buildStopDecision(200, 200, 0)).toBe('reached'))
  it('连续5轮空 → stop', () => expect(buildStopDecision(100, 200, 5)).toBe('stop'))
  it('否则继续', () => expect(buildStopDecision(100, 200, 2)).toBe('continue'))
})

type DlEvent = { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }

class FakeBrowser {
  failLoad = false
  /** 模拟页面底部文案（如抖音「暂时没有更多了」）；null 表示未滚到底/未命中 */
  bottomText: string | null = '暂时没有更多了'
  private loadBlocked = false
  private pendingLoad: (() => void) | null = null

  blockNextLoad(): void { this.loadBlocked = true }
  releaseLoad(): void { if (this.pendingLoad) { this.pendingLoad(); this.pendingLoad = null } }

  async init(): Promise<void> {}
  async load(_adapter: PlatformAdapter, _url: string): Promise<void> {
    if (this.failLoad) throw new Error('load_failed')
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
  async findBottomText(): Promise<string | null> { return this.bottomText }
  /** onLog：模拟 browser 的 CDP 步骤打点（供全链路日志测试走真实接线） */
  async applyDouyinFilter(_sel: unknown, _f: unknown, onLog?: (m: string) => void): Promise<boolean> {
    onLog?.('CDP attach 成功')
    onLog?.('面板出现')
    return true
  }
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

/** 启用抖音筛选续爬的任务（T3 + R11 共用的模块级入参） */
const filterInput: CreateTaskInput = {
  ...input,
  filters: {
    ...input.filters,
    douyinFilter: { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }
  }
}

const rawUrl = 'https://www.douyin.com/aweme/v1/web/search/item/?device_platform=webapp'
// 稀疏数据：到底后接口仍零星返回新视频（每轮 1-2 条，kept>0 → emptyRounds 归零、停滞分支永远到不了）
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
    video: { play_addr: { url_list: ['https://cdn.test/v1.mp4'] } },
    statistics: { digg_count: 42 },
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
  const s = new Scheduler({
    db, browser, analyzer: null, downloader: dl, emit: e => events.push(e), scrollIntervalMs,
    getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
    // R11：默认测试阈值 0.01 秒（10ms）——跑完的用例几毫秒内即判停滞，不拖慢套件；专门测 5s 语义的用例单独注入
    getStallThresholdSec: () => 0.01
  })
  return { s, events }
}

// 固定随机数让滚动 sleep 稳定为 scrollIntervalMs，跑得快且不依赖真实时长
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.restoreAllMocks() })

describe('Scheduler 滚动循环终止（C1）', () => {
  it('页面静默（无任何 raw 响应）且未达目标 → 停滞后自动暂停（error=stalled，不再无限"进行中"）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
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

describe('handleRaw 入库与作者（I4）+ pendingVideoIds 清理（I1）', () => {
  it('写入作者、入库视频、入队下载；下载完成从 pendingVideoIds 移除', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    const browser = new FakeBrowser()
    const { s } = setup(db, dl, browser)
    browser.blockNextLoad() // 任务挂起在 load：保持 taskId/adapter 就绪且任务仍在运行（I5 后任务结束即清理上下文）
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)
    expect(authors[0].sec_uid).toBe('SEC_001')

    const videos = db.prepare('SELECT * FROM videos WHERE task_id=?').all(taskId) as Array<{ id: number; author_id: number | null; aweme_id: string }>
    expect(videos).toHaveLength(1)
    expect(videos[0].aweme_id).toBe('7330000000000000001')
    expect(videos[0].author_id).toBe(authors[0].id)
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
})

describe('resume（I2）', () => {
  it('resume 重跑同一任务并正常结束（重搜/筛选计数随 run 重置）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
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

    browser.releaseLoad()
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
      emit: e => events.push(e), scrollIntervalMs: 1,
      organizer, organizeDebounceMs: 0,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)

    dl.emit({ type: 'video:status', id: db.prepare('SELECT id FROM videos WHERE task_id=?').get(taskId)!.id, status: 'done' })

    expect(organizer.markAuthorPending).toHaveBeenCalledWith(authors[0].id)
    expect(organizer.organizePending).toHaveBeenCalled()

    browser.releaseLoad()
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
      emit: e => events.push(e), scrollIntervalMs: 1,
      organizer, organizeDebounceMs: 0,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 0.01
    })
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10))

    await s.handleRaw(douyinAdapter, rawUrl, rawJson)
    const authors = listAuthors(db, 'douyin')
    expect(authors).toHaveLength(1)

    dl.emit({ type: 'video:status', id: db.prepare('SELECT id FROM videos WHERE task_id=?').get(taskId)!.id, status: 'done' })

    expect(organizer.markAuthorPending).toHaveBeenCalledWith(authors[0].id)
    expect(organizer.organizePending).toHaveBeenCalled()

    browser.releaseLoad()
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
    // 收尾 sleep=min(1500,2000,1000)=1000ms；阈值 2s：等待 500ms 不判停滞（R11-3 等待阶段会检查停滞）
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 500,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
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
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
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
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      // 阈值 1s：首轮等待(1ms)不可能判停滞，确保滚动先发生（R11-3 心跳等待小步检查会提前截胡微阈值）
      getStallThresholdSec: () => 1
    })
    await s.run(taskId)
    expect(spy).toHaveBeenCalledWith({ waitMs: 8000 })
  }, 10000)
})

describe('抖音筛选续爬（T3）', () => {
  it('搜索停滞 + 启用筛选 + keyword → applyDouyinFilter 被调且只一次；应用后停滞走重搜兜底，最终暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    // 只应用一次：应用后继续跑了几轮，再停滞时不再调用（走重搜）
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 1 }), expect.any(Function))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('底部文案触发（findBottomText 命中「暂时没有更多了」）+ 停滞 → 应用筛选', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    browser.bottomText = '暂时没有更多了'
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const bottomSpy = vi.spyOn(browser, 'findBottomText')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(bottomSpy).toHaveBeenCalled()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('5 秒停滞（阈值注入 5s + fake 时钟 6s）→ 触发筛选（秒数制判定，旧 15s 规则不会触发）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    // 递增时钟：lastFetchedAt 之后每次 Date.now() 都多走 6 秒 → 每轮必停滞（6s > 5s 阈值；< 旧 15s 规则）
    let now = 1000000
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 6000))
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 5 // 注入 5s 阈值
    })
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 1 }), expect.any(Function))
    // 5s 停滞走完整自救循环后真正暂停（不是 stalled_verify）
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('未停滞（时钟恒定，elapsed 恒 0）→ 不触发筛选、不重搜、不暂停，直到手动暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    browser.bottomText = null
    vi.spyOn(Date, 'now').mockReturnValue(1000000) // 时钟恒定：elapsed 恒为 0，永远判不到停滞
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 80)) // 跑几轮：未停滞则持续抓取
    await s.pause()
    await p
    expect(spy).not.toHaveBeenCalled()
    expect(loadSpy).toHaveBeenCalledTimes(1) // 只有初始加载，无重搜
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('筛选应用返回 false → 发 notice + 降级到重搜（不直接停）；重搜超限后暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(false)
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1) // 只应用一次：无论成败都不再重试
    expect(events).toContainEqual({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），将自动重新搜索关键词' })
    expect(loadSpy).toHaveBeenCalledTimes(4) // 初始 + 重搜 3 次（失败也降级到重搜兜底）
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('筛选脚本抛错 → 同样 notice + 降级到重搜（不直接停）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockRejectedValue(new Error('script_error'))
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），将自动重新搜索关键词' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('非 keyword 任务（作者）→ 不调 applyDouyinFilter（重搜兜底后暂停）', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...filterInput, type: 'author', query: 'https://www.douyin.com/user/abc' })
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('未启用筛选（enabled=false）→ 不调 applyDouyinFilter；停滞走重搜自救', async () => {
    const db = newDb()
    const taskId = createTask(db, {
      ...input,
      filters: { ...input.filters, douyinFilter: { enabled: false, publishTime: 0, duration: 0, searchScope: 0, contentType: 0 } }
    })
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const loadSpy = vi.spyOn(browser, 'load')
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).not.toHaveBeenCalled()
    expect(loadSpy.mock.calls.length).toBe(4) // 初始 + 重搜 3 次（重搜不依赖筛选配置）
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('停滞检测与 CDP 步骤逐条写入 onFilterLog（全链路日志，成功路径）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const logs: string[] = []
    const s = new Scheduler({
      db, browser: new FakeBrowser(), analyzer: null, downloader: new FakeDownloader(),
      emit: () => {}, scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    const all = logs.join('\n')
    // 触发决策每步：停滞检测（秒数制）→ 到底文案 → 执行筛选
    expect(all).toContain('停滞检测')
    expect(all).toContain('秒无新视频')
    expect(all).toContain('到底文案命中')
    expect(all).toContain('开始执行筛选流程')
    // browser CDP 步骤（经 onLog 回调汇入同一通道）
    expect(all).toContain('CDP attach 成功')
    expect(all).toContain('面板出现')
    // scheduler 汇总执行结果 + 重置计数
    expect(all).toContain('执行结果：成功')
    expect(all).toContain('筛选已生效：重置停滞计数')
  }, 10000)

  it('未启用筛选时 onFilterLog 记录重搜自救（不再直接暂停）', async () => {
    const db = newDb()
    const taskId = createTask(db, {
      ...input,
      filters: { ...input.filters, douyinFilter: { enabled: false, publishTime: 0, duration: 0, searchScope: 0, contentType: 0 } }
    })
    const logs: string[] = []
    const s = new Scheduler({
      db, browser: new FakeBrowser(), analyzer: null, downloader: new FakeDownloader(),
      emit: () => {}, scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    const all = logs.join('\n')
    expect(all).toContain('停滞检测')
    expect(all).toContain('次重搜') // 未启用筛选也重搜
    expect(all).toContain('已重搜 3 次仍爬不满')
  }, 10000)

  it('筛选执行失败时 onFilterLog 记录失败结果（含异常信息）+ 降级重搜日志', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    vi.spyOn(browser, 'applyDouyinFilter').mockRejectedValue(new Error('cdp_boom'))
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {}, scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    const all = logs.join('\n')
    expect(all).toContain('执行结果：失败')
    expect(all).toContain('cdp_boom')
    expect(all).toContain('降级到重新搜索关键词')
  }, 10000)

  it('并发拒绝（FILTER_BUSY）→ 不消耗 filterApplied、不停止、有重试日志；下轮重试成功后正常结束', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    // 第一次被互斥锁拒绝（如手动测试在跑），第二次重试成功
    const busyErr = Object.assign(new Error('filter_busy'), { code: 'FILTER_BUSY' })
    const spy = vi.spyOn(browser, 'applyDouyinFilter')
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(true)
    const logs: string[] = []
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    await s.run(taskId)
    // busy 不消耗 filterApplied：下一轮重试调用了一次，成功后走重搜兜底最终暂停（不是被 busy 误停）
    expect(spy).toHaveBeenCalledTimes(2)
    // busy 不算失败：不误发「筛选未生效」notice（后续重搜 notice 属正常自救流程）
    expect(events).not.toContainEqual({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），将自动重新搜索关键词' })
    const all = logs.join('\n')
    expect(all).toContain('筛选流程进行中（可能是手动测试在跑）')
    expect(all).toContain('执行结果：成功')
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('一直 FILTER_BUSY → 任务不停：持续重试直到成功或条件变化（不误发 notice）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const busyErr = Object.assign(new Error('filter_busy'), { code: 'FILTER_BUSY' })
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockRejectedValue(busyErr)
    const logs: string[] = []
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m),
      getStallThresholdSec: () => 0.01
    })
    // 一直 busy 时任务不会暂停也不会发 notice（等价于"等手动测试结束后再试"）；
    // 为避免无限循环，手动中止（模拟用户暂停），验证期间无 notice、filterApplied 始终未被消耗
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 200))
    await s.pause()
    await p
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2) // 每轮停滞都重试，没被一次性消耗
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    const all = logs.join('\n')
    expect(all).toContain('筛选流程进行中（可能是手动测试在跑）')
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: null })
  }, 10000)

  it('零星数据持续流入（kept>0 → lastFetchedAt 持续刷新）→ 不误判停滞、不触发筛选（本次修复核心）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser() // bottomText 默认「暂时没有更多了」
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 1 // 1 秒阈值：数据持续流入（<1s 间隔）则永不判停滞
    })
    const p = s.run(taskId)
    // 持续喂零星数据（每轮 kept>0 → lastFetchedAt 刷新），到底文案命中也不触发筛选——触发前提是停滞
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4))
      await s.handleRaw(douyinAdapter, rawUrl, sparseJson(i))
    }
    expect(spy).not.toHaveBeenCalled()
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    await s.pause()
    await p
  }, 10000)

  it('已应用过筛选（filterApplied=true）→ 触发分支跳过，不再调用 applyDouyinFilter（走重搜兜底）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad()
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 10)) // 挂起在 load：run 已重置 filterApplied，尚未进入循环
    ;(s as any).filterApplied = true // 模拟本任务已应用过一次筛选
    browser.releaseLoad()
    await p
    expect(spy).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

/** 递增时钟：lastFetchedAt 之后每次 Date.now() 都多走 6 秒 → 每轮必停滞（6s > 默认 5s 阈值） */
function advancingClock(): void {
  let now = 1000000
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 6000))
}

describe('停滞自救循环（R11）', () => {
  it('T2: 筛选生效后再停滞 → 重新搜索关键词（load 被调、URL 含关键词、reSearchCount 递增、progress 事件带值）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    advancingClock()
    const filterSpy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(filterSpy).toHaveBeenCalledTimes(1) // 筛选每任务只一次
    // 第 2 次 load = 第 1 次重搜，URL 为关键词搜索页
    const searchUrl = douyinAdapter.buildSearchUrl('测试')
    expect(loadSpy).toHaveBeenNthCalledWith(2, douyinAdapter, searchUrl)
    expect(loadSpy.mock.calls.length).toBe(4) // 初始 + 重搜 3 次
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 3 次）' })
    // progress 事件带重搜次数（渲染层展示用）
    const progress = events.filter(e => (e as { type?: string }).type === 'task:progress' && (e as { reSearchCount?: number }).reSearchCount !== undefined)
    expect(progress.map(e => (e as { reSearchCount: number }).reSearchCount)).toEqual([1, 2, 3])
    expect((s as any).reSearchCount).toBe(3)
  }, 10000)

  it('T3: 重搜 3 次仍爬不满 → paused error=stalled + notice「已重搜 3 次仍爬不满」', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    advancingClock()
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(events).toContainEqual({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词或筛选条件' })
    expect(events).toContainEqual({ type: 'task:paused', taskId, reason: 'stalled' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('T4: 未启用筛选续爬 → 停滞同样重搜（重搜不依赖筛选配置）；重搜 3 次超限后暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, input) // 无 douyinFilter
    const browser = new FakeBrowser()
    advancingClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy).toHaveBeenCalledTimes(4) // 初始 + 重搜 3 次（未启用筛选也重搜）
    expect(events).toContainEqual({ type: 'task:notice', text: '已自动重新搜索关键词（第 1 次）' })
    expect(events).not.toContainEqual({ type: 'task:notice', text: '爬取停滞已自动暂停' })
    expect(events).toContainEqual({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词或筛选条件' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('T5: 爬满目标 → done 不变（自救循环不干扰正常完成）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    db.prepare('UPDATE tasks SET fetched_count=200 WHERE id=?').run(taskId) // 模拟已爬满
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(loadSpy).toHaveBeenCalledTimes(1) // 无重搜
    expect(events).toContainEqual({ type: 'task:done', taskId, fetched: 200 })
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
  }, 10000)

  it('T6: 非到底停滞 → 立即重搜（去掉"连续 2 轮观察"延迟）；重搜 3 次超限后暂停', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
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
    expect(events).toContainEqual({ type: 'task:notice', text: '已重搜 3 次仍爬不满，请调整关键词或筛选条件' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})

describe('停滞检测秒级心跳（R11-3）', () => {
  it('心跳 1s 粒度检测停滞（滚动中）→ abortScroll 中断在途滚动（不等整轮 ~4-15s 滚动自然结束）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const browser = new FakeBrowser()
    const events: unknown[] = []
    // 阈值 0.1s：首轮等待(1ms)不判停滞，run 先进入滚动；心跳 1s 后看到停滞+滚动中 → 中断
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 0.1
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true)
    for (let i = 0; i < 300 && browser.abortScroll.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.abortScroll).toHaveBeenCalledTimes(1) // 心跳触发：停滞 && 滚动中 → 中断在途滚动
    browser.releaseScroll()
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('滚动中停滞 → 滚动返回后立即自救（重搜；不进整轮等待）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const loadSpy = vi.spyOn(browser, 'load')
    const events: unknown[] = []
    // 阈值 0.1s：run 先进入滚动；心跳 1s 后中断
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 0.1
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true)
    for (let i = 0; i < 300 && browser.abortScroll.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.abortScroll).toHaveBeenCalled() // 心跳已中断在途滚动
    const t0 = Date.now()
    browser.releaseScroll()
    for (let i = 0; i < 100 && loadSpy.mock.calls.length < 2; i++) await new Promise(r => setTimeout(r, 10))
    expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // 滚动返回后立即自救（重搜）
    expect(Date.now() - t0).toBeLessThan(500)
    await p
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)

  it('心跳等待阶段停滞 → 直接自救（未进滚动即重搜）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    browser.bottomText = null // 不走筛选分支，直接重搜
    advancingClock()
    const loadSpy = vi.spyOn(browser, 'load')
    const { s, events } = setup(db, new FakeDownloader(), browser)
    browser.blockNextLoad() // 初始加载
    const p = s.run(taskId)
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
    const taskId = createTask(db, filterInput)
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
    // 收尾 sleep = min(1500, 8000/4, 1000) = 1000ms；阈值 2s：等待 500ms 不判停滞，先进入滚动
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: dl,
      emit: e => events.push(e), scrollIntervalMs: 500,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      getStallThresholdSec: () => 2
    })
    browser.blockNextScroll()
    const p = s.run(taskId)
    for (let i = 0; i < 200 && !browser.scrollEntered; i++) await new Promise(r => setTimeout(r, 10))
    expect(browser.scrollEntered).toBe(true) // run 已进入 scrollToBottom

    await s.handleRaw(douyinAdapter, rawUrl, rawJson) // 199→200 填满（滚动进行中）
    expect(browser.abortScroll).toHaveBeenCalledTimes(1)

    const t0 = Date.now()
    browser.releaseScroll()
    await p
    expect(Date.now() - t0).toBeLessThan(500) // 未经 1000ms 收尾 sleep，立即进 reached
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
    browser.releaseLoad()
    await p
  }, 10000)

  it('status=pending 的任务可被 run 正常启动（UI「开始」/重启恢复走同一通道）', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'pending' }) // 创建即 pending
    const { s, events } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(events[0]).toEqual({ type: 'task:progress', taskId, fetched: 0, status: 'running' }) // 启动即进行中
    // run 对 pending 无阻碍：正常跑完自救循环（未启用筛选 → 停滞自动暂停）
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled' })
  }, 10000)
})
