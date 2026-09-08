import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos } from '../src/main/db'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 真机踩到的幽灵任务：删掉正在跑的任务后，调度器还攥着内存里的 taskId 继续滚页面、
// 继续停滞重搜（日志里连滚三轮），最后想把任务标 paused 时那行已经没了，UPDATE 静默失败。
// 用户在界面上完全看不到，只看见浏览器自己在动。
//
// 删任务必须把这个任务相关的活全停掉：调度器、排队、在途下载。

const mockIpc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { handlers, userData: process.cwd() + '/.tmp-ipc-task-delete' }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (...args: unknown[]) => unknown): void => { mockIpc.handlers.set(c, fn) },
    on: () => {},
    removeHandler: () => {}
  },
  app: { getPath: () => mockIpc.userData, getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

const input: CreateTaskInput = {
  platform: 'kuaishou', type: 'author', query: '3xAUTHOR1',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}

const item = (id: string): VideoItem => ({
  awemeId: id, title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 0, height: 0,
  durationSec: 10, publishTime: 1710000000, likes: 0, comments: null,
  sourceUrl: 'https://www.kuaishou.com/short-video/' + id
})

function setup(runningTaskId = 0) {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  mockIpc.handlers.clear()
  const paused: number[] = []
  const dequeued: number[] = []
  const cancelled: number[][] = []
  const kicked: boolean[] = []
  const scheduler = {
    get currentTaskId() { return runningTaskId },
    get isRunning() { return runningTaskId !== 0 },
    pause: vi.fn(async () => { paused.push(runningTaskId) }),
    resume: vi.fn(),
    run: vi.fn()
  }
  registerIpc({
    db,
    scheduler: scheduler as never,
    downloader: { cancel: (ids: number[]) => cancelled.push(ids) } as never,
    analyzer: null,
    browser: {} as never,
    getWindow: () => ({}) as never,
    reloadAnalyzer: () => {},
    reloadOrganizer: () => {},
    getOrganizer: () => null,
    enqueueTask: () => {},
    dequeueTask: (id: number) => { dequeued.push(id) },
    kickQueue: () => { kicked.push(true) },
    setBrowserVisible: () => {}
  } as never)
  const del = mockIpc.handlers.get('task:delete')!
  return { db, del: (id: number) => del(null, id) as Promise<unknown>, paused, dequeued, cancelled, kicked, scheduler }
}

beforeEach(() => { mockIpc.handlers.clear() })

describe('task:delete 必须停掉这个任务相关的活', () => {
  it('删的正是在跑的任务 → 先停调度器，再删数据', async () => {
    const probe = setup()
    const taskId = createTask(probe.db, input)
    const { db, del, paused } = setup(taskId)
    const realId = createTask(db, input)
    expect(realId).toBe(taskId) // 同一套建表流程，id 可预期

    await del(taskId)

    expect(paused).toEqual([taskId]) // 调度器被叫停
    expect(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(taskId)).toEqual({ c: 0 })
  })

  it('删的不是在跑的那个 → 不去打断正在跑的任务', async () => {
    const { db, del, paused } = setup(999)
    const taskId = createTask(db, input)

    await del(taskId)

    expect(paused).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(taskId)).toEqual({ c: 0 })
  })

  it('还在排队没开跑的任务 → 从队列里摘掉，不能等轮到它时再跑一遍', async () => {
    const { db, del, dequeued } = setup(0)
    const taskId = createTask(db, input)

    await del(taskId)

    expect(dequeued).toContain(taskId)
  })

  it('该任务的在途下载要取消，否则文件继续往磁盘写、数据库行却已经没了', async () => {
    const { db, del, cancelled } = setup(0)
    const taskId = createTask(db, input)
    insertVideos(db, [item('AW1'), item('AW2')], taskId, 'kuaishou')
    const ids = listVideos(db, taskId).map(v => v.id)

    await del(taskId)

    expect(cancelled.flat().sort()).toEqual(ids.sort())
  })

  it('视频行和任务行照常删干净', async () => {
    const { db, del } = setup(0)
    const taskId = createTask(db, input)
    insertVideos(db, [item('AW1')], taskId, 'kuaishou')

    await del(taskId)

    expect(db.prepare('SELECT COUNT(*) c FROM videos WHERE task_id=?').get(taskId)).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(taskId)).toEqual({ c: 0 })
  })

  it('停掉正在跑的任务后要放行队列——否则排队中的任务永远没人叫醒', async () => {
    const probe = setup()
    const taskId = createTask(probe.db, input)
    const { db, del, kicked } = setup(taskId)
    createTask(db, input)

    await del(taskId)

    // dequeueAndRun 只在 task:done 时被调用（刻意如此，暂停不放行下一个）。
    // 删除走的是 pause()，不发任何事件——不显式踢一脚，后面排队的任务就卡死在「等待」。
    expect(kicked).toEqual([true])
  })
})
