import { describe, it, expect, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, tuneDb, inTransaction, createTask, insertVideos, listVideos, setVideoStatus, taskStats, allTaskStats, globalStats, insertAuthorIfAbsent, setAuthorVerify } from '../src/main/db'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

// 2026-10-06 全面检查「性能」C1/C3：数据库写入方式、缺的索引、任务统计一次查完、概览不再拉整张作者表

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (awemeId: string, sec = 'SEC'): VideoItem => ({
  awemeId, title: '标题', authorSecUid: sec, authorNickname: '作者' + sec,
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 0, height: 0,
  durationSec: 10, publishTime: 1710000000, likes: 0
})
const mem = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); initDb(db); return db }
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })

describe('C1 数据库写入方式', () => {
  it('真实库文件：WAL 日志 + NORMAL 同步 + 忙等 3 秒（单条写入从 2～4 毫秒降到零点几毫秒）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-perf-')); dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'scraper.db'))
    tuneDb(db)
    initDb(db)
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 3000 })
    db.close()
  })

  it('inTransaction：出错整批回滚；嵌套调用不报错', () => {
    const db = mem()
    expect(() => inTransaction(db, () => {
      createTask(db, input)
      inTransaction(db, () => createTask(db, input))
      throw new Error('中途出错')
    })).toThrow('中途出错')
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 })
    inTransaction(db, () => { createTask(db, input) })
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 1 })
  })
})

describe('C3 常用查询都走索引', () => {
  const plan = (db: DatabaseSync, sql: string, ...args: unknown[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map(r => r.detail).join(' | ')

  it('概览「最近完成」、按文件路径找视频、按任务数状态', () => {
    const db = mem()
    expect(plan(db, "SELECT id FROM videos WHERE status = 'done' AND downloaded_at IS NOT NULL ORDER BY downloaded_at DESC LIMIT 8"))
      .toMatch(/idx_videos_status_downloaded/)
    expect(plan(db, 'SELECT id FROM videos WHERE local_path = ?', 'x')).toMatch(/idx_videos_local_path/)
    expect(plan(db, 'SELECT task_id, status, COUNT(*) c FROM videos GROUP BY task_id, status')).toMatch(/idx_videos_task_status/)
  })
})

describe('C3 任务统计一次查完（以前每个任务单独查一次）', () => {
  it('allTaskStats 和逐个 taskStats 结果一致；没有视频的任务也有一行全 0', () => {
    const db = mem()
    const t1 = createTask(db, input)
    const t2 = createTask(db, input)
    const t3 = createTask(db, input)
    insertVideos(db, [item('A'), item('B'), item('C')], t1, 'douyin')
    insertVideos(db, [item('D')], t2, 'douyin')
    const [a, b, c] = listVideos(db, t1)
    setVideoStatus(db, a.id, 'done'); setVideoStatus(db, b.id, 'failed'); setVideoStatus(db, c.id, 'deleted')
    const all = allTaskStats(db, [t1, t2, t3])
    expect(all[t1]).toEqual(taskStats(db, t1))
    expect(all[t2]).toEqual(taskStats(db, t2))
    expect(all[t3]).toEqual(taskStats(db, t3))
    expect(all[t1]).toMatchObject({ total: 2, done: 1, failed: 1, deleted: 1 })
  })
})

describe('C3 概览页的作者数字直接算好（以前把整张作者表拉过去数）', () => {
  it('globalStats 带上作者总数、待校验、未分类', () => {
    const db = mem()
    const t = createTask(db, input)
    insertVideos(db, [item('A', 'S1'), item('B', 'S2')], t, 'douyin')
    db.prepare("UPDATE authors SET category = '美食' WHERE sec_uid = 'S1'").run()
    const imported = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'S3', nickname: '导入的', homeUrl: 'h' })
    const failed = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'S4', nickname: '没通过', homeUrl: 'h' })
    setAuthorVerify(db, failed.id, 'failed', 'x')
    expect(imported.id).toBeGreaterThan(0)
    expect(globalStats(db).authors).toEqual({ total: 4, pendingVerify: 1, uncategorized: 3 })
  })
})
