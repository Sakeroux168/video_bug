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

  // 需求变更（2026-10-06，体验测试 老陈复测 🟠「批量不查重」）：同一个作者已经在排队，
  // 再建一个只会重复抓，改为跳过并说明原因。「已爬过」仍只看 done（见上下两条），这里只多拦排队中 / 正在跑的。
  // 重启时排队中的任务会被重新入队，不存在「一直排着、又建不了新的」的死角。
  it('同 query 但还在排队（pending）→ 不算已爬过，但也不重复建，提示已经在排队', async () => {
    const { db, enqueued, create } = setup()
    createTask(db, input({ type: 'author', query: AUTHOR_URL })) // 默认 pending

    const r = await create(input({ type: 'author', query: AUTHOR_URL }))
    expect(r.skipped).toBe(true)
    expect(r.reason).toMatch(/已经在排队/)
    expect(enqueued).toEqual([])
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

  // R20 复查：只按日期段抓过的不算「主页已爬取过」——那只抓了一段时间
  it('只按日期段抓过（done 且 timeRange=custom）→ 之后正常整页抓取不被拦', async () => {
    const { db, enqueued, create } = setup()
    const id = createTask(db, input({ type: 'author', query: AUTHOR_URL,
      filters: { timeRange: 'custom', startDate: '2026-09-01', endDate: '2026-09-20', duration: 'all', targetCount: 50 } }))
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id)

    const r = await create(input({ type: 'author', query: AUTHOR_URL }))
    expect(r.skipped).toBe(false)
    expect(enqueued).toEqual([r.id])
  })

  it('整页抓过一次（非日期段）仍然照旧拦（日期段行只是不参与判断）', async () => {
    const { db, create } = setup()
    seedDoneAuthor(db)
    const id = createTask(db, input({ type: 'author', query: AUTHOR_URL,
      filters: { timeRange: 'custom', startDate: '2026-09-01', duration: 'all', targetCount: 50 } }))
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id)
    expect((await create(input({ type: 'author', query: AUTHOR_URL }))).skipped).toBe(true)
  })

  it('非 author 类型（keyword）→ 不查作者去重，直接创建', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ type: 'keyword', query: '美食' }))
    expect(r.skipped).toBe(false)
    expect(enqueued).toEqual([r.id])
  })
})

// P1.5：URL 双重包裹修复——task:create 对 type=author 的 query 先 parseAuthorInput 归一化，
// 避免 FilterForm 存完整 URL、scheduler 又套一层 buildAuthorUrl 拼出双重 URL；
// 同时去重比对做了归一化，URL 与 sec_uid 两种输入格式能命中同一条去重记录。
describe('task:create 作者 URL 归一化（P1.5）', () => {
  beforeEach(() => { mkdirSync(mockIpc.userData, { recursive: true }) })
  afterEach(() => { rmSync(mockIpc.userData, { recursive: true, force: true }) })

  it('完整主页 URL 输入 → 落库 tasks.query 是 sec_uid（不是原始 URL）', async () => {
    const { db, create } = setup()
    const r = await create(input({ type: 'author', query: 'https://www.douyin.com/user/SEC_NORM_1' }))
    expect(r.skipped).toBe(false)
    expect(r.id).toBeTypeOf('number')
    const row = db.prepare('SELECT query FROM tasks WHERE id=?').get(r.id) as { query: string }
    expect(row.query).toBe('SEC_NORM_1')
  })

  it('URL 与 sec_uid 两种输入命中同一条去重记录', async () => {
    const { db, create } = setup()
    const r1 = await create(input({ type: 'author', query: 'https://www.douyin.com/user/SEC_NORM_2' }))
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(r1.id)

    const r2 = await create(input({ type: 'author', query: 'SEC_NORM_2' }))
    expect(r2).toEqual({ id: null, skipped: true, reason: '该作者主页已爬取过，可在作者表格中直接管理' })
  })

  it('短链接 → skipped:true 且提示去粘完整主页链接，不建任务', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ type: 'author', query: 'https://v.douyin.com/iZZZZZZZ/' }))
    // 短链不联网解析，必须让用户自己粘完整主页；这句与批量导入路径完全一致
    expect(r).toEqual({ id: null, skipped: true, reason: '暂不支持短链接，请粘贴完整主页链接' })
    expect(enqueued).toEqual([])
  })

  it('非本平台链接/非法字符 → reason 指名当前平台，不建任务', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ type: 'author', query: 'https://www.baidu.com/user/x' }))
    expect(r).toEqual({ id: null, skipped: true, reason: '未识别到抖音主页链接或作者 ID' })
    expect(enqueued).toEqual([])
  })

  it('快手任务的提示说的是快手，不再张冠李戴', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ platform: 'kuaishou', type: 'author', query: 'https://www.douyin.com/user/SEC_X' }))
    expect(r).toEqual({ id: null, skipped: true, reason: '未识别到快手主页链接或作者 ID' })
    expect(enqueued).toEqual([])
  })
})

// 小红书关键词、话题与作者主页均已接通。
describe('任务创建遵守平台能力', () => {
  it('小红书关键词任务接通后可正常入队', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ platform: 'xiaohongshu', type: 'keyword', query: '美食' }))

    expect(r.id).not.toBeNull()
    expect(r.skipped).toBe(false)
    expect(enqueued).toEqual([r.id])
  })

  it('小红书作者 ID 会归一化并正常入队', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ platform: 'xiaohongshu', type: 'author', query: '5f2a1b3c0000000001' }))
    expect(r.skipped).toBe(false)
    expect(r.id).not.toBeNull()
    expect(enqueued).toEqual([r.id])
  })

  it('已就绪平台不受影响', async () => {
    const { enqueued, create } = setup()
    const r = await create(input({ platform: 'douyin', type: 'keyword', query: '美食' }))
    expect(r.id).not.toBeNull()
    expect(enqueued).toHaveLength(1)
  })
})
