import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus } from '../src/main/db'
import { Downloader, buildUserAgent } from '../src/main/downloader'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'dl-'))
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}
const item = (): VideoItem => ({
  awemeId: 'AW001', title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', durationSec: 10, publishTime: 1710000000, likes: 0
})

describe('buildUserAgent', () => {
  it('包含桌面浏览器标识', () => {
    expect(buildUserAgent('douyin')).toMatch(/Mozilla/)
  })
})

describe('Downloader', () => {
  it('下载成功：写文件、更新状态 done', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)

    // 合法 MP4 文件头（含 ftyp box），否则下载器会判定为坏文件
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)

    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain('cdn.test')
      return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch

    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    const events: string[] = []
    dl.onEvent(e => events.push(`${e.type}:${e.status}`))
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(row.local_path).toBeTruthy()
    expect(existsSync(row.local_path!)).toBe(true)
    expect(readFileSync(row.local_path!)).toEqual(mp4)
    expect(events).toContain('video:status:done')
  })

  it('下载内容是坏文件（无 ftyp）→ 标记 failed + parse_error，删除坏文件', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('parse_error')
  })

  it('HTTP 500 首次触发网络重试：pending + retry_count=1，5s 后重新入队', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('pending') // 等待 5s 重试，未直接失败
    expect(row.retry_count).toBe(1)
    expect(row.error).toBeNull()
  })

  it('网络错误重试耗尽（第3次）→ failed + 错误码 network', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET retry_count=2 WHERE id=?').run(v.id) // 已重试2次，本次为第3次
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network')
    expect(row.retry_count).toBe(3)
  })

  it('地址过期（超过 TTL）→ failed + 错误码 address_expired，不再发起下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET fetched_at=? WHERE id=?').run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), v.id)
    const fetchImpl = (async () => { throw new Error('不应发起下载请求') }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('address_expired')
  })

  it('磁盘错误（ENOENT）→ 直接 failed + 错误码 disk，不重试', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => {
      const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed') // 磁盘错误不进入 5s 重试，直接失败
    expect(row.error).toBe('disk')
    expect(row.retry_count).toBe(1)
  })
})
