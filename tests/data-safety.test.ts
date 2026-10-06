import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, listAuthors, taskStats, globalStats, refreshSeenVideo, setVideoStatus } from '../src/main/db'
import { deleteVideoRows } from '../src/main/videoDelete'
import { deleteFileDir } from '../src/main/fileManager'
import { Downloader } from '../src/main/downloader'
import { Organizer, ALL_ORGANIZE_LEVELS } from '../src/main/organizer'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

vi.mock('../src/main/videoNormalizer', () => ({ normalizeVideo: vi.fn() }))

// 2026-10-06 全面检查「数据安全」第三组：B5 软删除 + 回收站、#8 自动整理互斥

let db: DatabaseSync
let dir: string
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db); dir = mkdtempSync(join(tmpdir(), 'data-safe-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (awemeId: string, over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId, title: `标题${awemeId}`, authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: `https://cdn.test/${awemeId}.mp4`, coverUrl: '', width: 1080, height: 1920,
  durationSec: 10, publishTime: 1710000000, likes: 0, ...over
})

/** 一个任务两条已下好的视频（文件真实存在），返回任务 id 与视频行 */
function twoDone() {
  const taskId = createTask(db, input)
  insertVideos(db, [item('A', { publishTime: 1720000000 }), item('B', { publishTime: 1710000000 })], taskId, 'douyin')
  const rows = listVideos(db, taskId).map(v => {
    const path = join(dir, `${v.aweme_id}.mp4`)
    writeFileSync(path, 'mp4')
    setVideoStatus(db, v.id, 'done', { local_path: path })
    return { ...v, local_path: path }
  })
  return { taskId, rows }
}

describe('B5 删掉的视频做个记号，不再被追更 / 重搜下回来', () => {
  it('删除后：文件没了，数据库行留着、标成 deleted；任务列表、统计、作者视频数都不算它', async () => {
    const { taskId, rows } = twoDone()
    const [a] = rows
    const r = await deleteVideoRows({ db, downloader: { cancel: () => {} }, downloadDir: dir }, [a.id])
    expect(r).toEqual({ ok: true, deleted: 1 })
    expect(existsSync(a.local_path)).toBe(false)
    expect(db.prepare('SELECT status, local_path FROM videos WHERE id = ?').get(a.id)).toEqual({ status: 'deleted', local_path: null })
    expect(listVideos(db, taskId).map(v => v.aweme_id)).toEqual(['B'])
    expect(taskStats(db, taskId).total).toBe(1)
    expect(globalStats(db).videos.total).toBe(1)
    expect(listAuthors(db)[0].video_count).toBe(1)
  })

  it('再爬到同一条：不重新入库、不重新下载，也不给它换地址', async () => {
    const { taskId, rows } = twoDone()
    await deleteVideoRows({ db, downloader: { cancel: () => {} }, downloadDir: dir }, [rows[0].id])
    const t2 = createTask(db, input)
    expect(insertVideos(db, [item('A', { playUrl: 'https://cdn.test/new.mp4' })], t2, 'douyin')).toBe(0)
    refreshSeenVideo(db, 'douyin', item('A', { playUrl: 'https://cdn.test/new.mp4' }))
    expect(db.prepare('SELECT status, play_addr FROM videos WHERE id = ?').get(rows[0].id))
      .toEqual({ status: 'deleted', play_addr: 'https://cdn.test/A.mp4' })
    expect(listVideos(db, taskId).length).toBe(1)
  })

  it('删掉最新的一条后，追更的起点不往回退（不然会把删掉的重新抓回来）', async () => {
    const { rows } = twoDone()
    const before = listAuthors(db)[0].latest_video_at
    await deleteVideoRows({ db, downloader: { cancel: () => {} }, downloadDir: dir }, [rows[0].id]) // A 是最新的
    expect(listAuthors(db)[0].latest_video_at).toBe(before)
  })

  it('下载器不会把已删除的视频再下载', () => {
    const { rows } = twoDone()
    setVideoStatus(db, rows[0].id, 'deleted')
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetch)
    dl.download([rows[0].id])
    expect(dl.isIdle()).toBe(true)
    expect(db.prepare('SELECT status FROM videos WHERE id = ?').get(rows[0].id)).toEqual({ status: 'deleted' })
  })

  it('给了回收站函数就把文件放进回收站，不直接删', async () => {
    const { rows } = twoDone()
    const trashed: string[] = []
    const trash = vi.fn(async (p: string) => { trashed.push(p); rmSync(p) })
    await deleteVideoRows({ db, downloader: { cancel: () => {} }, downloadDir: dir, trash }, [rows[0].id])
    expect(trashed).toEqual([rows[0].local_path])
  })

  it('文件管理删文件夹：文件夹进回收站，里面视频的行也标成 deleted', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('C')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const sub = join(dir, '美食'); mkdirSync(sub)
    const path = join(sub, 'C.mp4'); writeFileSync(path, 'mp4')
    setVideoStatus(db, v.id, 'done', { local_path: path })
    const trash = vi.fn(async (p: string) => { rmSync(p, { recursive: true }) })
    const r = await deleteFileDir({ db, downloadDir: dir, trash }, ['美食'])
    expect(r).toMatchObject({ ok: true, deleted: 1 })
    expect(trash).toHaveBeenCalledWith(sub)
    expect(db.prepare('SELECT status, local_path FROM videos WHERE id = ?').get(v.id)).toEqual({ status: 'deleted', local_path: null })
  })
})

describe('#8 自动整理同一时间只跑一个', () => {
  function organizer(resolveCategory: () => Promise<string | null>) {
    return new Organizer({ db, downloadDir: dir, levels: ALL_ORGANIZE_LEVELS, resolveCategory })
  }

  it('两次「整理」同时触发 → 一个作者只整理一次（不重复花 AI 费用）', async () => {
    twoDone()
    db.prepare("UPDATE authors SET organize_state = 'pending'").run()
    const resolve = vi.fn(async () => { await new Promise(r => setTimeout(r, 20)); return '美食' })
    const o = organizer(resolve)
    await Promise.all([o.organizePending(), o.organizePending()])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('整理途中这个作者又下完一条 → 整理完状态是「待整理」而不是「已完成」，下一轮会把它也整理掉', async () => {
    const { taskId } = twoDone()
    insertVideos(db, [item('LATE')], taskId, 'douyin')
    const late = listVideos(db, taskId).find(v => v.aweme_id === 'LATE')!
    const latePath = join(dir, 'LATE.mp4')
    let o!: Organizer
    const resolve = vi.fn(async () => {
      if (resolve.mock.calls.length === 1) {
        // 第一轮整理进行中：又下完一条，下载完成事件把作者标成待整理
        writeFileSync(latePath, 'mp4')
        setVideoStatus(db, late.id, 'done', { local_path: latePath })
        o.markAuthorPending(late.author_id!)
      }
      return '美食'
    })
    o = organizer(resolve)
    db.prepare("UPDATE authors SET organize_state = 'pending'").run()
    await o.organizePending()
    expect(db.prepare('SELECT organize_state FROM authors').get()).toEqual({ organize_state: 'pending' })
    await o.organizePending()
    expect(existsSync(latePath)).toBe(false) // 第二轮把它也挪进分类目录了
    expect(db.prepare('SELECT organize_state FROM authors').get()).toEqual({ organize_state: 'done' })
  })
})
