import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTask, initDb, insertVideos, listVideos } from '../src/main/db'
import { Downloader } from '../src/main/downloader'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync
let dir: string

const taskInput: CreateTaskInput = {
  platform: 'xiaohongshu', type: 'keyword', query: '分段测试',
  filters: { timeRange: 'all', duration: 'all', targetCount: 1 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}

function video(playUrl = 'https://cdn.test/video.mp4'): VideoItem {
  return {
    awemeId: 'SEG-1', title: '分段测试', authorSecUid: 'SEC', authorNickname: '作者',
    authorHomeUrl: '', playUrl, coverUrl: '', width: 1080, height: 1920,
    durationSec: 10, publishTime: 1710000000, likes: 0
  }
}

function sourceBytes(size = 4096): Buffer {
  const source = Buffer.alloc(size)
  for (let i = 0; i < source.length; i++) source[i] = i % 251
  source.write('ftypisom', 4)
  return source
}

function requestedRange(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('range')
}

function rangeResponse(source: Buffer, range: string, contentRange = range): Response {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)
  if (!match) throw new Error(`bad test range: ${range}`)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(new Uint8Array(source.subarray(start, end + 1)), {
    status: 206,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      'content-range': `${contentRange.replace('bytes=', 'bytes ')}/${source.length}`
    }
  })
}

function createVideo(playUrl?: string): { taskId: number; id: number } {
  const taskId = createTask(db, taskInput)
  insertVideos(db, [video(playUrl)], taskId, 'xiaohongshu')
  return { taskId, id: listVideos(db, taskId)[0].id }
}

function downloader(fetchImpl: typeof fetch, segments = 3, idleTimeoutMs = 60_000): Downloader {
  return new Downloader(db, {
    downloadDir: dir, downloadConcurrency: 1, downloadSegments: segments, addressTtlMin: 30
  }, fetchImpl, {
    validator: async file => readFileSync(file).subarray(4, 12).toString() === 'ftypisom',
    idleTimeoutMs,
    // 2026-10-07 性能 F13 起分段重试之间要等一会儿（默认 0.5s、1s）；这里测的是重试次数和顺序，不等
    segmentRetryBaseMs: 0
  })
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'seg-dl-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('同一文件 Range 分段下载', () => {
  it('206 探测成功后并行下载三段，按顺序合并为原内容', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const ranges: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)
      ranges.push(range ?? 'single')
      if (range === 'bytes=0-0') return rangeResponse(source, range)
      if (!range) throw new Error('不应降级单连接')
      await new Promise(resolve => setTimeout(resolve, 5))
      return rangeResponse(source, range)
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))

    const row = listVideos(db, taskId)[0]
    expect(readFileSync(row.local_path!)).toEqual(source)
    expect(ranges).toEqual(expect.arrayContaining(['bytes=0-0', 'bytes=0-1365', 'bytes=1366-2730', 'bytes=2731-4095']))
    expect(readdirSync(dir).some(name => name.includes('.part'))).toBe(false)
  })

  it('服务器忽略 Range 返回 200，自动降级为原来的单连接下载', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const ranges: Array<string | null> = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)
      ranges.push(range)
      return new Response(new Uint8Array(source), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))

    expect(ranges).toEqual(['bytes=0-0', null])
    expect(readFileSync(listVideos(db, taskId)[0].local_path!)).toEqual(source)
  })

  it('某段 Content-Range 不符时只重试这一段', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const counts = new Map<string, number>()
    const badRange = 'bytes=1366-2730'
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      counts.set(range, (counts.get(range) ?? 0) + 1)
      if (range === badRange && counts.get(range) === 1) {
        return rangeResponse(source, range, 'bytes 1367-2730')
      }
      return rangeResponse(source, range)
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))

    expect(counts.get('bytes=0-0')).toBe(1)
    expect(counts.get('bytes=0-1365')).toBe(1)
    expect(counts.get(badRange)).toBe(2)
    expect(counts.get('bytes=2731-4095')).toBe(1)
  })

  it('某段超过重试上限后放弃当前候选，只回退 playwm→play 候选', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo('https://cdn.test/playwm/video.mp4')
    let badAttempts = 0
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      const range = requestedRange(init)!
      urls.push(href)
      if (href.includes('playwm') && range === 'bytes=1366-2730') {
        badAttempts++
        return rangeResponse(source, range, 'bytes 1367-2730')
      }
      return rangeResponse(source, range)
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))

    expect(badAttempts).toBe(3)
    expect(urls.some(url => !url.includes('playwm'))).toBe(true)
    expect(readFileSync(listVideos(db, taskId)[0].local_path!)).toEqual(source)
  })

  it('每段有独立无数据计时：一段卡住只重试该段，三次后走整条网络重试', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const counts = new Map<string, number>()
    const stuckRange = 'bytes=1366-2730'
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      counts.set(range, (counts.get(range) ?? 0) + 1)
      if (range !== stuckRange) return rangeResponse(source, range)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(source.subarray(1366, 1376)) }
      }), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': `bytes 1366-2730/${source.length}`,
          'content-length': '1365'
        }
      })
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl, 3, 50)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].retry_count).toBe(1), { timeout: 3000 })

    expect(counts.get(stuckRange)).toBe(3)
    expect(counts.get('bytes=0-1365')).toBe(1)
    expect(counts.get('bytes=2731-4095')).toBe(1)
    expect(listVideos(db, taskId)[0].status).toBe('pending')
    expect(readdirSync(dir).some(name => name.includes('.part'))).toBe(false)
    dl.cancel([id])
  })

  it('单连接收到伪装成 200 的 HTML 时判坏文件并走现有错误路径', async () => {
    const { taskId, id } = createVideo()
    const html = '<html>risk control</html>'.padEnd(2048, 'x')
    const fetchImpl = vi.fn(async () => new Response(html, {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }
    })) as unknown as typeof fetch

    const dl = downloader(fetchImpl, 1)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].retry_count).toBe(1))

    expect(listVideos(db, taskId)[0]).toMatchObject({ status: 'failed', error: 'parse_error' })
    expect(readdirSync(dir).some(name => name.includes('.part'))).toBe(false)
  })

  it('暂停后保留已完成段，继续时只下载剩余段且不重复探测', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const counts = new Map<string, number>()
    let resuming = false
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      counts.set(range, (counts.get(range) ?? 0) + 1)
      if (!resuming && range !== 'bytes=0-0' && range !== 'bytes=0-1365') {
        const signal = init?.signal!
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' })
        ), { once: true }))
      }
      return rangeResponse(source, range)
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => {
      const part = readdirSync(dir).find(name => name.endsWith('.segment-0.part'))
      expect(part).toBeTruthy()
      expect(statSync(join(dir, part!)).size).toBe(1366)
    })

    dl.pause()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('pending'))
    expect(readdirSync(dir).filter(name => name.includes('.segment-')).length).toBe(1)

    resuming = true
    dl.resume()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))

    expect(counts.get('bytes=0-0')).toBe(1)
    expect(counts.get('bytes=0-1365')).toBe(1)
    expect(counts.get('bytes=1366-2730')).toBe(2)
    expect(counts.get('bytes=2731-4095')).toBe(2)
    expect(readFileSync(listVideos(db, taskId)[0].local_path!)).toEqual(source)
  })

  it('取消会中断所有段并清理 sourcePart 与全部分段 part', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    let blockingStarted = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      if (range === 'bytes=0-0' || range === 'bytes=0-1365') return rangeResponse(source, range)
      blockingStarted++
      const signal = init?.signal!
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      ), { once: true }))
      throw new Error('unreachable')
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(blockingStarted).toBe(2))
    dl.cancel([id])
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('cancelled'))
    await vi.waitFor(() => expect(readdirSync(dir).some(name => name.includes('.part'))).toBe(false))
    expect(listVideos(db, taskId)[0].local_path).toBeNull()
  })

  it('分段数为 1 时不发 Range 探测，行为与原单连接一致', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(requestedRange(init)).toBeNull()
      return new Response(new Uint8Array(source), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as unknown as typeof fetch

    const dl = downloader(fetchImpl, 1)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(existsSync(listVideos(db, taskId)[0].local_path!)).toBe(true)
  })
})

// 2026-10-07 性能 F13：分段失败以前立刻重试、不等；CDN 限流时一口气打 9 轮。现在两次重试之间等一会儿（0.5s、1s……），
// 平台明确拒绝（403 / 429）就不再重试，按「平台拒绝」失败。
describe('分段重试：等一会儿再试；被拒绝就不试了', () => {
  it('某段失败一次 → 等够设定的时间才重试', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const badRange = 'bytes=1366-2730'
    const times: number[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      if (range === badRange) {
        times.push(Date.now())
        if (times.length === 1) return rangeResponse(source, range, 'bytes 1367-2730')
      }
      return rangeResponse(source, range)
    }) as unknown as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, downloadSegments: 3, addressTtlMin: 30 }, fetchImpl, {
      validator: async file => readFileSync(file).subarray(4, 12).toString() === 'ftypisom', segmentRetryBaseMs: 300
    })
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 })
    expect(times).toHaveLength(2)
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(280)
  })

  it('某段被平台拒绝（403）→ 不再重试这一段，整条按「平台拒绝」失败、不走网络重试', async () => {
    const source = sourceBytes()
    const { taskId, id } = createVideo()
    const badRange = 'bytes=1366-2730'
    let badAttempts = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const range = requestedRange(init)!
      if (range === badRange) { badAttempts++; return new Response('no', { status: 403 }) }
      return rangeResponse(source, range)
    }) as unknown as typeof fetch
    const dl = downloader(fetchImpl)
    dl.enqueue(id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('failed'), { timeout: 10_000 })
    expect(badAttempts).toBe(1)
    expect(listVideos(db, taskId)[0].error).toBe('forbidden')
  })
})
