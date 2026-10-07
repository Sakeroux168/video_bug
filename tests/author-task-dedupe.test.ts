import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, setTaskStatus } from '../src/main/db'
import { createTaskChecked } from '../src/main/taskCreate'
import type { CreateTaskInput } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-author-task-dedupe' } }))

// 全面检查（老陈复测 🟠）：同一个博主已经在排队 / 正在爬，再点一次（尤其是批量）不能又建一个一样的任务
let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db) })

const author = (over: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  platform: 'xiaohongshu', type: 'author', query: '5f86825c0000000001007dbc',
  filters: { timeRange: 'custom', startDate: '2026-10-01', duration: 'all', targetCount: 3 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true, allowDuplicateAuthor: true,
  ...over
})

describe('作者任务：已经在排队 / 正在爬就不再重复建', () => {
  it('同一个作者已有排队中的任务 → 跳过，原因写「已经在排队」', () => {
    createTask(db, author())
    const enqueue = vi.fn()
    const r = createTaskChecked(db, author(), enqueue)
    expect(r).toMatchObject({ id: null, skipped: true })
    expect(r.reason).toMatch(/已经在排队/)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('同一个作者正在爬 → 跳过，原因写「正在爬」', () => {
    const id = createTask(db, author())
    setTaskStatus(db, id, 'running')
    const r = createTaskChecked(db, author(), vi.fn())
    expect(r.reason).toMatch(/正在爬/)
  })

  it('上一个已经结束（done / paused / failed）→ 可以再建；别的作者不受影响', () => {
    const id = createTask(db, author())
    setTaskStatus(db, id, 'paused')
    expect(createTaskChecked(db, author(), vi.fn()).skipped).toBe(false)
    expect(createTaskChecked(db, author({ query: '64cdc30b000000000e024320' }), vi.fn()).skipped).toBe(false)
  })

  it('完整主页链接和裸 ID 认作同一个作者', () => {
    createTask(db, author())
    const r = createTaskChecked(db, author({ query: 'https://www.xiaohongshu.com/user/profile/5f86825c0000000001007dbc' }), vi.fn())
    expect(r.skipped).toBe(true)
  })
})
