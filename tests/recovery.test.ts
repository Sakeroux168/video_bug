import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask } from '../src/main/db'
import { enqueuePendingTasks } from '../src/main/recovery'
import type { CreateTaskInput } from '../src/shared/types'

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '测试',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  return db
}

describe('重启恢复：遗留 pending 任务重新入队（R11-3）', () => {
  it('DB 中 status=pending 的任务按 id 顺序全部入队（已完成/暂停/失败的不入队）', () => {
    const db = newDb()
    const a = createTask(db, input) // pending
    const b = createTask(db, input) // pending
    const c = createTask(db, input)
    const d = createTask(db, input)
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(c)
    db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(d)

    const enqueued: number[] = []
    enqueuePendingTasks(db, id => enqueued.push(id))
    expect(enqueued).toEqual([a, b]) // 按 id 顺序，只含 pending
  })

  it('无 pending 任务 → 不入队任何任务', () => {
    const db = newDb()
    createTask(db, input)
    createTask(db, input)
    db.prepare("UPDATE tasks SET status='done' WHERE 1=1").run()
    const enqueued: number[] = []
    enqueuePendingTasks(db, id => enqueued.push(id))
    expect(enqueued).toEqual([])
  })
})
