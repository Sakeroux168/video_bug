import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTask, initDb, insertVideos, listVideos } from '../src/main/db'
import { Downloader } from '../src/main/downloader'
import type { CreateTaskInput } from '../src/shared/types'

vi.mock('../src/main/videoNormalizer', () => ({ normalizeVideo: vi.fn() }))

// 2026-10-06 全面检查「界面」D8：下载时看不到百分比和速度，大文件不知道还要等多久

let db: DatabaseSync
let dir: string
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db); dir = mkdtempSync(join(tmpdir(), 'dl-progress-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 1 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
function source(size: number): Buffer { const b = Buffer.alloc(size, 7); b.write('ftypisom', 4); return b }
/** 分好几块慢慢吐数据的响应，模拟真实下载 */
function slowBody(buf: Buffer, chunks: number, extraHeaders: Record<string, string> = {}, status = 200): Response {
  const size = Math.ceil(buf.length / chunks)
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= buf.length) { c.close(); return }
      await new Promise(r => setTimeout(r, 5))
      c.enqueue(buf.subarray(i, i + size)); i += size
    }
  })
  return new Response(stream, { status, headers: { 'content-type': 'video/mp4', 'content-length': String(buf.length), ...extraHeaders } })
}
type Progress = { type: string; id: number; received: number; total: number | null; speed: number }

function setup(segments: number) {
  const taskId = createTask(db, input)
  insertVideos(db, [{ awemeId: 'P1', title: '进度', authorSecUid: 'S', authorNickname: 'a', authorHomeUrl: 'h', playUrl: 'https://v26.douyinvod.com/p.mp4', coverUrl: '', width: 0, height: 0, durationSec: 10, publishTime: 1710000000, likes: 0 }], taskId, 'douyin')
  const id = listVideos(db, taskId)[0].id
  return { taskId, id }
}

describe('D8 下载进度（百分比 + 速度）', () => {
  it('单连接：边下边发进度，字节数一路增加，最后一条等于文件大小', async () => {
    const buf = source(40_000)
    const { taskId, id } = setup(1)
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 },
      (async () => slowBody(buf, 8)) as typeof fetch, { validator: async () => true, progressIntervalMs: 0 })
    const events: Progress[] = []
    dl.onEvent(e => { if (e.type === 'video:progress') events.push(e as unknown as Progress) })
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // CI 机器慢，1 秒默认值不够
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every(e => e.id === id && e.total === buf.length)).toBe(true)
    for (let i = 1; i < events.length; i++) expect(events[i].received).toBeGreaterThanOrEqual(events[i - 1].received)
    expect(events.at(-1)!.received).toBe(buf.length)
    expect(events.some(e => e.speed > 0)).toBe(true)
  })

  it('分段下载：几段的字节数加在一起算，不超过总大小', async () => {
    const buf = source(30_000)
    const { taskId, id } = setup(3)
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')
      if (!range) return slowBody(buf, 4)
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number)
      return slowBody(buf.subarray(a, b + 1), 3, { 'content-range': `bytes ${a}-${b}/${buf.length}` }, 206)
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, downloadSegments: 3, addressTtlMin: 30 },
      fetchImpl, { validator: async () => true, progressIntervalMs: 0 })
    const events: Progress[] = []
    dl.onEvent(e => { if (e.type === 'video:progress') events.push(e as unknown as Progress) })
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // CI 机器慢，1 秒默认值不够
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every(e => e.total === buf.length && e.received <= buf.length)).toBe(true)
    expect(events.at(-1)!.received).toBe(buf.length)
  })

  it('默认最多每秒发一次（不刷屏）', async () => {
    const buf = source(40_000)
    const { taskId, id } = setup(1)
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 },
      (async () => slowBody(buf, 8)) as typeof fetch, { validator: async () => true })
    const events: Progress[] = []
    dl.onEvent(e => { if (e.type === 'video:progress') events.push(e as unknown as Progress) })
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // CI 机器慢，1 秒默认值不够
    expect(events.length).toBeLessThanOrEqual(2) // 第一块 + 下完那一下
  })
})
