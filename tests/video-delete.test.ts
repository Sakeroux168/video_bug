import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, listAuthors } from '../src/main/db'
import { deleteVideoRows } from '../src/main/videoDelete'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput, Filters } from '../src/shared/types'

// Task 3 review 补测：deleteVideoRows 编排——cancel 先行（防孤儿文件）、部分成功 deleted 数、路径防护

let db: DatabaseSync
let tmp: string

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}

const item = (awemeId: string): VideoItem => ({
  awemeId, title: `标题${awemeId}`, authorSecUid: 'SEC1', authorNickname: '作者1',
  authorHomeUrl: 'https://www.douyin.com/user/SEC1', playUrl: 'https://v/play/1',
  coverUrl: '', width: 0, height: 0,
  durationSec: 60, publishTime: 1710000000, likes: 10
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  tmp = mkdtempSync(join(tmpdir(), 'vd-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function setupVideos(n: number): number {
  const id = createTask(db, input)
  insertVideos(db, Array.from({ length: n }, (_, i) => item(`AW${i + 1}`)), id, 'douyin')
  return id
}

describe('deleteVideoRows（ipc video:delete 编排）', () => {
  it('cancel 先行调用且调用时行还没删（防孤儿文件顺序）', async () => {
    setupVideos(2)
    const ids = listVideos(db, 1).map(v => v.id)
    let rowsAtCancel = -1
    const dler = { cancel: vi.fn((_ids: number[]) => { rowsAtCancel = (db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c }) }

    const r = await deleteVideoRows({ db, downloader: dler, downloadDir: tmp }, ids)
    expect(r).toEqual({ ok: true, deleted: 2 })
    expect(dler.cancel).toHaveBeenCalledWith(ids)
    expect(rowsAtCancel).toBe(2) // cancel 时行全在 → cancel 发生在删行之前
  })

  it('全部成功：删行 + 作者 video_count 重算', async () => {
    setupVideos(2)
    const ids = listVideos(db, 1).map(v => v.id)
    const dler = { cancel: vi.fn() }
    const r = await deleteVideoRows({ db, downloader: dler, downloadDir: tmp }, ids)
    expect(r).toEqual({ ok: true, deleted: 2 })
    expect(listVideos(db, 1)).toHaveLength(0)
    expect(listAuthors(db)[0].video_count).toBe(0) // 2 条全删 → 计数归 0
  })

  it('视频和封面路径都安全时，两份文件一起删除后再删数据库行', async () => {
    setupVideos(1)
    const [video] = listVideos(db, 1)
    const videoPath = join(tmp, 'pair.mp4')
    const coverPath = join(tmp, 'pair.webp')
    writeFileSync(videoPath, 'video')
    writeFileSync(coverPath, 'cover')
    db.prepare('UPDATE videos SET local_path=?, cover_path=? WHERE id=?')
      .run(videoPath, coverPath, video.id)

    const result = await deleteVideoRows({ db, downloader: { cancel: vi.fn() }, downloadDir: tmp }, [video.id])

    expect(result).toEqual({ ok: true, deleted: 1 })
    expect(existsSync(videoPath)).toBe(false)
    expect(existsSync(coverPath)).toBe(false)
    expect(listVideos(db, 1)).toHaveLength(0)
  })

  it('部分成功：一条文件删成功（文件消失+行删），一条 unlink 失败（报错+保留行）', async () => {
    setupVideos(2)
    const vs = listVideos(db, 1)
    const goodFile = join(tmp, 'good.mp4')
    writeFileSync(goodFile, 'x')
    const dirPath = join(tmp, 'adir')
    mkdirSync(dirPath)
    db.prepare('UPDATE videos SET local_path = ? WHERE id = ?').run(goodFile, vs[0].id)
    db.prepare('UPDATE videos SET local_path = ? WHERE id = ?').run(dirPath, vs[1].id)

    const r = await deleteVideoRows({ db, downloader: { cancel: vi.fn() }, downloadDir: tmp }, vs.map(v => v.id))
    expect(r.ok).toBe(false)
    expect(r.deleted).toBe(1)
    expect(r.error).toContain('删除文件失败')
    // 成功那条：文件消失 + 行被删；失败那条：行保留
    expect(existsSync(goodFile)).toBe(false)
    const rest = listVideos(db, 1)
    expect(rest).toHaveLength(1)
    expect(rest[0].id).toBe(vs[1].id)
    // 计数联动：2 → 1
    expect(listAuthors(db)[0].video_count).toBe(1)
  })

  it('路径不安全（downloadDir 外）→ 不删任何资源，保留数据库行并报告错误', async () => {
    setupVideos(1)
    const v = listVideos(db, 1)[0]
    const outside = join(tmp, '..', 'evil.mp4') // 穿越路径
    db.prepare('UPDATE videos SET local_path = ? WHERE id = ?').run(outside, v.id)

    const r = await deleteVideoRows({ db, downloader: { cancel: vi.fn() }, downloadDir: tmp }, [v.id])
    expect(r.ok).toBe(false)
    expect(r.deleted).toBe(0)
    expect(r.error).toContain('不在下载目录内')
    expect(listVideos(db, 1)).toHaveLength(1)
  })

  it('封面路径在下载目录外时，不先删安全的 MP4，保留数据库行并报告错误', async () => {
    setupVideos(1)
    const [video] = listVideos(db, 1)
    const videoPath = join(tmp, 'safe.mp4')
    const outsideCover = join(tmp, '..', 'outside.webp')
    writeFileSync(videoPath, 'video')
    db.prepare('UPDATE videos SET local_path=?, cover_path=? WHERE id=?')
      .run(videoPath, outsideCover, video.id)

    const result = await deleteVideoRows({ db, downloader: { cancel: vi.fn() }, downloadDir: tmp }, [video.id])

    expect(result.ok).toBe(false)
    expect(result.deleted).toBe(0)
    expect(result.error).toContain('不在下载目录内')
    expect(existsSync(videoPath)).toBe(true)
    expect(listVideos(db, 1)).toHaveLength(1)
  })

  it('ENOENT 忽略：本地文件已不存在 → 照常删 DB 行并计数', async () => {
    setupVideos(2)
    const vs = listVideos(db, 1)
    db.prepare('UPDATE videos SET local_path = ? WHERE id = ?').run(join(tmp, 'gone.mp4'), vs[0].id) // 文件不存在

    const r = await deleteVideoRows({ db, downloader: { cancel: vi.fn() }, downloadDir: tmp }, vs.map(v => v.id))
    expect(r).toEqual({ ok: true, deleted: 2 })
    expect(listVideos(db, 1)).toHaveLength(0)
    expect(listAuthors(db)[0].video_count).toBe(0)
  })

  it('在途(downloading)行：cancel 把状态标 cancelled 后行仍被删', async () => {
    setupVideos(1)
    const v = listVideos(db, 1)[0]
    db.prepare("UPDATE videos SET status='downloading' WHERE id=?").run(v.id)
    // 模拟真实 cancel 语义：在途 abort → 状态标 cancelled（删行流程不受影响）
    const dler = { cancel: vi.fn((ids: number[]) => { for (const id of ids) db.prepare("UPDATE videos SET status='cancelled' WHERE id=?").run(id) }) }

    const r = await deleteVideoRows({ db, downloader: dler, downloadDir: tmp }, [v.id])
    expect(r).toEqual({ ok: true, deleted: 1 })
    expect(listVideos(db, 1)).toHaveLength(0)
    expect(dler.cancel).toHaveBeenCalledWith([v.id])
  })

  it('空 id 列表：cancel 不调用，返回 deleted 0', async () => {
    const dler = { cancel: vi.fn() }
    const r = await deleteVideoRows({ db, downloader: dler, downloadDir: tmp }, [])
    expect(r).toEqual({ ok: true, deleted: 0 })
    expect(dler.cancel).not.toHaveBeenCalled()
  })
})
