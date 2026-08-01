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
  async scrollToBottom(): Promise<void> {}
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
  aiFilterEnabled: false, aiOrganizeEnabled: false
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  return db
}

function setup(db: DatabaseSync, dl: FakeDownloader, browser: FakeBrowser, scrollIntervalMs = 1) {
  const events: unknown[] = []
  const s = new Scheduler({ db, browser, analyzer: null, downloader: dl, emit: e => events.push(e), scrollIntervalMs })
  return { s, events }
}

// 固定随机数让滚动 sleep 稳定为 scrollIntervalMs，跑得快且不依赖真实时长
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.restoreAllMocks() })

describe('Scheduler 滚动循环终止（C1）', () => {
  it('页面静默（无任何 raw 响应）时 run 终止，任务置为 done', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
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
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
  }, 10000)
})

describe('handleRaw 入库与作者（I4）+ pendingVideoIds 清理（I1）', () => {
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

  it('写入作者、入库视频、入队下载；下载完成从 pendingVideoIds 移除', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const dl = new FakeDownloader()
    const { s } = setup(db, dl, new FakeBrowser())
    await s.run(taskId) // 先让 run 完成，taskId/adapter 就绪

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
  }, 10000)
})

describe('resume（I2）', () => {
  it('resume 重跑同一任务并正常结束', async () => {
    const db = newDb()
    const taskId = createTask(db, input)
    const { s } = setup(db, new FakeDownloader(), new FakeBrowser())
    await s.run(taskId)
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
    await s.resume(taskId)
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'done' })
    expect((s as any).running).toBe(false)
  }, 10000)
})
