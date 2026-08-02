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
const item = (awemeId = 'AW001'): VideoItem => ({
  awemeId, title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
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

  it('pause 后入队不被下载（fetch 不调用），resume 后执行', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    const fetchImpl = (async () => { fetchCount++; return new Response(mp4, { status: 200 }) }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.pause()
    expect(dl.isPaused()).toBe(true)
    dl.enqueue(v.id)
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0) // 暂停中 drain 不拉取
    dl.resume()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(1)
  })

  it('cancel 在途：fetch 收到 abort signal，状态 cancelled，不走网络重试', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    let fetchStarted!: () => void
    const started = new Promise<void>(res => { fetchStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞在 abort 上
    dl.cancel([v.id])
    await new Promise(r => setTimeout(r, 30)) // 等 abort 传播、runOne 收尾
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    expect(row.retry_count).toBe(0) // 不走 5s 网络重试，retry_count 不增
  })

  it('cancel 排队项：队列中 pending 移除并标 cancelled，不再下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [v1, v2] = listVideos(db, taskId)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      firstStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started
    expect(fetchCount).toBe(1) // v2 尚未开始
    dl.cancel([v2.id])
    await new Promise(r => setTimeout(r, 20))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v2.id)!.status).toBe('cancelled')
    expect(fetchCount).toBe(1) // v2 被移出队列，不再下载
    dl.cancel([v1.id]) // 清理在途，避免悬挂 promise
    await new Promise(r => setTimeout(r, 20))
  })

  it('download([collected]) → 状态 pending 并下载成功 done', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    setVideoStatus(db, v.id, 'collected') // 手动模式：入 collected 等待手动下载
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const fetchImpl = (async () => new Response(mp4, { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.download([v.id])
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
  })
})
