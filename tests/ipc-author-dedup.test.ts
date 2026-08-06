import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { initDb, createTask, listTasks } from '../src/main/db'
import type { CreateTaskInput } from '../src/shared/types'

// task:create 作者去重（ipc 层编排，纯主进程逻辑）：
// type=author 且不允许重复时，同 query 的 done 任务存在 → 跳过（skipped）不入队；
// allowDuplicateAuthor（任务级）覆盖全局设置；仅 done 状态算"已爬过"。

// mock electron：app.getPath 指向本测试专属临时目录（settings.json 可写，用于测全局允许重复）
const mockIpc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    /** app.getPath 的返回值：settings.json 落此目录（不能引用模块顶层变量，mock factory 先于其初始化执行） */
    userData: process.cwd() + '/.tmp-ipc-author-dedup',
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown): void => { handlers.set(channel, fn) },
      on: () => {},
      removeHandler: () => {}
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: mockIpc.ipcMain,
  app: { getPath: () => mockIpc.userData, getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

const AUTHOR_URL = 'https://www.douyin.com/user/abc'

function input(over: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    platform: 'douyin', type: 'keyword', query: 'q',
    filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
    aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true,
    ...over
  }
}

function setup(): {
  db: DatabaseSync
  enqueued: number[]
  create: (task: CreateTaskInput) => Promise<{ id: number | null; skipped: boolean; reason?: string }>
} {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  const enqueued: number[] = []
  mockIpc.handlers.clear()
  registerIpc({
    db,
    scheduler: {} as never,
    downloader: {} as never,
    analyzer: null,
    browser: {} as never,
    getWindow: () => ({}) as never,
    reloadAnalyzer: () => {},
    reloadOrganizer: () => {},
    getOrganizer: () => null,
    enqueueTask: id => enqueued.push(id),
    setBrowserVisible: () => {}
  })
  const create = mockIpc.handlers.get('task:create')!
  return {
    db, enqueued,
    create: (task) => create(null, task) as Promise<{ id: number | null; skipped: boolean; reason?: string }>
  }
}

/** 造一个同 query 的 done author 任务（模拟已爬过主页） */
function seedDoneAuthor(db: DatabaseSync): void {
  const id = createTask(db, input({ type: 'author', query: AUTHOR_URL }))
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id)
}

describe('task:create 作者去重', () => {
  beforeEach(() => { mkdirSync(mockIpc.userData, { recursive: true }) })
  afterEach(() => { rmSync(mockIpc.userData, { recursive: true, force: true }) })

  it('同 query 的 author 任务已 done → 返回 skipped，不入队、不建新任务', async () => {
    const { db, enqueued, create } = setup()
    seedDoneAuthor(db)

    const r = await create(input({ type: 'author', query: AUTHOR_URL }))
    expect(r).toEqual({ id: null, skipped: true, reason: '该作者主页已爬取过，可在作者表格中直接管理' })
    expect(enqueued).toEqual([])
    expect(listTasks(db)).toHaveLength(1) // 没有新增任务
  })

  it('同 query 但未 done（pending）→ 不算已爬过，正常创建', async () => {
    const { db, enqueued, create } = setup()
    createTask(db, input({ type: 'author', query: AUTHOR_URL })) // 默认 pending

    const r = await create(input({ type: 'author', query: AUTHOR_URL }))
    expect(r.skipped).toBe(false)
    expect(r.id).toBeTypeOf('number')
    expect(enqueued).toEqual([r.id])
  })

  it('同 query 已 done 但任务级 allowDuplicateAuthor=true → 覆盖去重，正常创建', async () => {
    const { db, enqueued, create } = setup()
    seedDoneAuthor(db)

    const r = await create(input({ type: 'author', query: AUTHOR_URL, allowDuplicateAuthor: true }))
    expect(r.skipped).toBe(false)
    expect(r.id).toBeTypeOf('number')
    expect(enqueued).toEqual([r.id])
  })

  it('全局设置 allowDuplicateAuthor=true（settings.json）→ 同 query done 也允许重复', async () => {
    const { db, enqueued, create } = setup()
    seedDoneAuthor(db)
    // 写全局设置：允许重复爬取作者（getSettings 读 userData/settings.json）
    writeFileSync(join(mockIpc.userData, 'settings.json'), JSON.stringify({ allowDuplicateAuthor: true }))

    const r = await create(input({ type: 'author', query: AUTHOR_URL }))
    expect(r.skipped).toBe(false)
    expect(r.id).toBeTypeOf('number')
    expect(enqueued).toEqual([r.id])
  })

  it('非 author 类型（keyword）→ 不查作者去重，直接创建', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ type: 'keyword', query: '美食' }))
    expect(r.skipped).toBe(false)
    expect(enqueued).toEqual([r.id])
  })
})
