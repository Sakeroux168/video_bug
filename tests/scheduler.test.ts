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

const rawUrl = 'https://www.douyin.com/aweme/v1/web/search/item/?device_platform=webapp'
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
    getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 })
  })
  return { s, events }
}

// 固定随机数让滚动 sleep 稳定为 scrollIntervalMs，跑得快且不依赖真实时长
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.restoreAllMocks() })

describe('Scheduler 滚动循环终止（C1）', () => {
  it('页面静默（无任何 raw 响应）且未达目标时 run 终止，任务置为 paused(stalled_verify) 供人工验证', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
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
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
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
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)
})

describe('resume（I2）', () => {
  it('resume 重跑同一任务并正常结束', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
    await s.resume(taskId)
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
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
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
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
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 })
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
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 })
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
    const { s } = setup(db, new FakeDownloader(), browser, 500) // 收尾 sleep=min(1500,2000,1000)=1000ms
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
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 })
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
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'scrollToBottom')
    const events: unknown[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: e => events.push(e), scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 })
    })
    await s.run(taskId)
    expect(spy).toHaveBeenCalledWith({ waitMs: 8000 })
  }, 10000)
})

describe('抖音筛选续爬（T3）', () => {
  const filterInput: CreateTaskInput = {
    ...input,
    filters: {
      ...input.filters,
      douyinFilter: { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }
    }
  }

  it('搜索停滞 + 启用筛选 + keyword → applyDouyinFilter 被调且只一次；重置停滞后按原逻辑停止', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    // 只应用一次：应用后继续跑了几轮，再停滞时不再调用
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 1 }), expect.any(Function))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('底部文案触发（findBottomText 命中「暂时没有更多了」）→ 应用筛选', async () => {
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
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('15 秒无新视频入库（无底部文案）→ 触发筛选续爬', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    browser.bottomText = null
    // 模拟时钟：lastFetchedAt 首调取 T0，之后每次 Date.now() 都是 T0+16s（>15s 超时）
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000000).mockReturnValue(1000000 + 16000)
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 1 }), expect.any(Function))
  }, 10000)

  it('无底部文案且未到 15 秒 → 不应用筛选，按原逻辑停止', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    browser.bottomText = null
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).not.toHaveBeenCalled()
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('筛选应用返回 false → 发 notice「筛选续爬未生效」+ 按原逻辑停止（不重试）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(false)
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），已按原逻辑停止' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('筛选脚本抛错 → 同样 notice + 按原逻辑停止', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockRejectedValue(new Error('script_error'))
    const { s, events } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'task:notice', text: '筛选续爬未生效（页面结构可能已变），已按原逻辑停止' })
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('非 keyword 任务（作者）→ 不调 applyDouyinFilter', async () => {
    const db = newDb()
    const taskId = createTask(db, { ...filterInput, type: 'author', query: 'https://www.douyin.com/user/abc' })
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
  }, 10000)

  it('未启用筛选（enabled=false）→ 不调 applyDouyinFilter', async () => {
    const db = newDb()
    const taskId = createTask(db, {
      ...input,
      filters: { ...input.filters, douyinFilter: { enabled: false, publishTime: 0, duration: 0, searchScope: 0, contentType: 0 } }
    })
    const browser = new FakeBrowser()
    const spy = vi.spyOn(browser, 'applyDouyinFilter').mockResolvedValue(true)
    const { s } = setup(db, new FakeDownloader(), browser)
    await s.run(taskId)
    expect(spy).not.toHaveBeenCalled()
  }, 10000)

  it('触发决策与 CDP 步骤逐条写入 onFilterLog（全链路日志，成功路径）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const logs: string[] = []
    const s = new Scheduler({
      db, browser: new FakeBrowser(), analyzer: null, downloader: new FakeDownloader(),
      emit: () => {}, scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m)
    })
    await s.run(taskId)
    const all = logs.join('\n')
    // 触发决策每步：停滞判定 → 到底文案 → 计时 → 执行
    expect(all).toContain('筛选触发判定：停滞命中')
    expect(all).toContain('到底文案命中')
    expect(all).toContain('开始执行筛选流程')
    // browser CDP 步骤（经 onLog 回调汇入同一通道）
    expect(all).toContain('CDP attach 成功')
    expect(all).toContain('面板出现')
    // scheduler 汇总执行结果 + 重置计数
    expect(all).toContain('执行结果：成功')
    expect(all).toContain('筛选已生效：重置停滞计数')
  }, 10000)

  it('不满足触发条件时 onFilterLog 记录不触发原因', async () => {
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
      onFilterLog: m => logs.push(m)
    })
    await s.run(taskId)
    const all = logs.join('\n')
    expect(all).toContain('筛选触发判定：停滞命中')
    expect(all).toContain('不触发筛选：未启用筛选')
  }, 10000)

  it('筛选执行失败时 onFilterLog 记录失败结果（含异常信息）', async () => {
    const db = newDb()
    const taskId = createTask(db, filterInput)
    const browser = new FakeBrowser()
    vi.spyOn(browser, 'applyDouyinFilter').mockRejectedValue(new Error('cdp_boom'))
    const logs: string[] = []
    const s = new Scheduler({
      db, browser, analyzer: null, downloader: new FakeDownloader(),
      emit: () => {}, scrollIntervalMs: 1,
      getScrollParams: () => ({ scrollSpeed: 'slow' as const, scrollPageWaitMs: 8000 }),
      onFilterLog: m => logs.push(m)
    })
    await s.run(taskId)
    const all = logs.join('\n')
    expect(all).toContain('执行结果：失败')
    expect(all).toContain('cdp_boom')
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
      onFilterLog: m => logs.push(m)
    })
    await s.run(taskId)
    // busy 不消耗 filterApplied：下一轮重试调用了一次，最终按原逻辑自然停止（不是被 busy 误停）
    expect(spy).toHaveBeenCalledTimes(2)
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'task:notice' }))
    const all = logs.join('\n')
    expect(all).toContain('筛选流程进行中（可能是手动测试在跑）')
    expect(all).toContain('执行结果：成功')
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'paused', error: 'stalled_verify' })
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
      onFilterLog: m => logs.push(m)
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
})
