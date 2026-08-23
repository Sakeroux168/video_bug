import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, setVideoStatus, globalStats, recentDownloads } from '../src/main/db'
import type { CreateTaskInput, Filters } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

// 概览页的数据来源。**用两条 GROUP BY 代替原来的 1 + N 次调用**：
// 此前想拿全站计数只能 listTasks() 再对每个任务 getTaskStats()，
// 任务一多就是几十次 IPC，而且每次都在事件风暴里重复。

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId: 'AW1', title: '标题1', authorSecUid: 'SEC1', authorNickname: '作者1',
  authorHomeUrl: 'u', playUrl: 'p', durationSec: 60, publishTime: 1710000000, likes: 10, ...over
})

describe('globalStats', () => {
  it('空库返回全零而不是 undefined（概览页不能显示 NaN）', () => {
    const g = globalStats(db)
    expect(g.videos.total).toBe(0)
    expect(g.tasks.total).toBe(0)
    expect(g.videos.done).toBe(0)
  })

  it('跨任务汇总视频分状态计数', () => {
    const t1 = createTask(db, input)
    const t2 = createTask(db, { ...input, query: '旅行' })
    insertVideos(db, [item({ awemeId: 'A1' }), item({ awemeId: 'A2' })], t1, 'douyin')
    insertVideos(db, [item({ awemeId: 'B1' })], t2, 'douyin')
    const ids = db.prepare('SELECT id FROM videos ORDER BY id').all() as Array<{ id: number }>
    setVideoStatus(db, ids[0].id, 'done')
    setVideoStatus(db, ids[1].id, 'failed')

    const g = globalStats(db)
    expect(g.videos.total).toBe(3)
    expect(g.videos.done).toBe(1)
    expect(g.videos.failed).toBe(1)
    expect(g.videos.pending).toBe(1)   // 入库初始态是 pending（videos.status DEFAULT 'pending'）
  })

  it('汇总任务分状态计数', () => {
    createTask(db, input)
    createTask(db, { ...input, query: '旅行' })
    const g = globalStats(db)
    expect(g.tasks.total).toBe(2)
    expect(g.tasks.pending).toBe(2)
  })
})

describe('recentDownloads', () => {
  it('只取已完成且有下载时间的，按时间倒序，带作者昵称', () => {
    const t = createTask(db, input)
    insertVideos(db, [
      item({ awemeId: 'A1', title: '早的' }),
      item({ awemeId: 'A2', title: '晚的' }),
      item({ awemeId: 'A3', title: '没下完的' })
    ], t, 'douyin')
    const ids = db.prepare('SELECT id FROM videos ORDER BY id').all() as Array<{ id: number }>
    db.prepare("UPDATE videos SET status='done', downloaded_at='2026-08-01T10:00:00Z' WHERE id=?").run(ids[0].id)
    db.prepare("UPDATE videos SET status='done', downloaded_at='2026-08-01T12:00:00Z' WHERE id=?").run(ids[1].id)

    const r = recentDownloads(db, 8)
    expect(r.length).toBe(2)                    // 没下完的不算
    expect(r[0].title).toBe('晚的')              // 倒序
    expect(r[0].author_nickname).toBe('作者1')   // 带作者，不是光秃秃一个 id
    expect(r[0].downloaded_at).toBeTruthy()
  })

  it('limit 生效', () => {
    const t = createTask(db, input)
    insertVideos(db, Array.from({ length: 12 }, (_, i) => item({ awemeId: `A${i}` })), t, 'douyin')
    db.prepare("UPDATE videos SET status='done', downloaded_at='2026-08-01T10:00:00Z'").run()
    expect(recentDownloads(db, 5).length).toBe(5)
  })
})
