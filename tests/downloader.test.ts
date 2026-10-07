import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus } from '../src/main/db'
import { networkRetryDelayMs, Downloader, buildUserAgent, buildRequestHeaders } from '../src/main/downloader'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { tmpdir } from 'os'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

// 下载链已拆掉自动转码：任何路径都不得调到 normalizeVideo。这里把模块整个替换成会记录调用的 spy，
// 若 Downloader 重新把它接回主流程，下面「原视频直下」用例会直接红。
const normalizeVideoSpy = vi.hoisted(() => vi.fn(async () => { throw new Error('下载链不得调用 normalizeVideo') }))
vi.mock('../src/main/videoNormalizer', () => ({ normalizeVideo: normalizeVideoSpy }))

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'dl-'))
})

afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}
const item = (awemeId = 'AW001', over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId, title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 0, height: 0,
  durationSec: 10, publishTime: 1710000000, likes: 0, ...over
})

describe('buildUserAgent', () => {
  it('包含桌面浏览器标识', () => {
    expect(buildUserAgent('douyin')).toMatch(/Mozilla/)
  })
})

describe('Downloader', () => {
  it('小红书 http 视频 CDN 地址可下载，并携带适配器 Referer', async () => {
    const taskId = createTask(db, { ...input, platform: 'xiaohongshu' })
    insertVideos(db, [item('XHS-HTTP', { playUrl: 'http://sns-video-zl.xhscdn.com/video.mp4' })], taskId, 'xiaohongshu')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048); mp4.writeUInt32BE(0x18, 0); mp4.write('ftypisom', 4)
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://sns-video-zl.xhscdn.com/video.mp4')
      expect(init?.headers).toMatchObject({ referer: 'https://www.xiaohongshu.com/' })
      return new Response(mp4, { status: 200 })
    }) as unknown as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    expect(listVideos(db, taskId)[0]).toMatchObject({ status: 'done' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

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

    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    const events: string[] = []
    dl.onEvent(e => events.push(`${e.type}:${'status' in e ? e.status : ''}`))
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(row.local_path).toBeTruthy()
    expect(existsSync(row.local_path!)).toBe(true)
    expect(readFileSync(row.local_path!)).toEqual(mp4)
    expect(events).toContain('video:status:done')
  })

  it('原视频直下：需要转码的输入也按原样保存，normalizer 不被调用，尺寸不被改动', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('RAW-720P', { width: 720, height: 1280 })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const source = Buffer.alloc(2048, 1)
    source.write('ftypisom', 4)
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 },
      (async () => new Response(source)) as typeof fetch, { validator: async () => true })

    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(readFileSync(row.local_path!)).toEqual(source)
    expect(row.local_path).toMatch(/\.mp4$/)
    expect(row.local_path).not.toMatch(/\.part\./)
    // 720×1280 就保留 720×1280：下载器不主动改尺寸，也不产生原片副本或转码诊断
    expect(row.video_width).toBe(720)
    expect(row.video_height).toBe(1280)
    expect(row.original_path).toBeNull()
    expect(row.normalization_error).toBeNull()
    expect(normalizeVideoSpy).not.toHaveBeenCalled()
    expect(readdirSync(dir).some(name => name.includes('.part.'))).toBe(false)
    expect(readdirSync(dir).some(name => name.endsWith('.original.mp4'))).toBe(false)
  })

  it('历史 settings.json 里残留 normalizeVideo/keepOriginalVideo=true 也不再影响下载链', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('LEGACY-SETTING', { width: 720, height: 1280 })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const source = Buffer.alloc(2048, 2)
    source.write('ftypisom', 4)
    // 旧版设置对象原样传入（updateSettings 收的是整份 AppSettings，老配置文件里仍可能带这两个键）
    const legacy = { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30, normalizeVideo: true, keepOriginalVideo: true }
    const dl = new Downloader(db, legacy as never, (async () => new Response(source)) as typeof fetch, { validator: async () => true })
    dl.updateSettings(legacy as never)

    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(readFileSync(row.local_path!)).toEqual(source)
    expect(row.original_path).toBeNull()
    expect(row.normalization_error).toBeNull()
    expect(normalizeVideoSpy).not.toHaveBeenCalled()
  })

  it('封面下载期间全局暂停：保留已验证下载断点，继续后不重复请求视频', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('PAUSE-COVER', { coverUrl: 'https://img.test/c' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const source = Buffer.alloc(2048, 7)
    source.write('ftypisom', 4)
    let videoFetchCount = 0
    let coverFetchCount = 0
    let coverStarted!: () => void
    const started = new Promise<void>(resolve => { coverStarted = resolve })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('img.test')) { videoFetchCount++; return new Response(source) }
      coverFetchCount++
      if (coverFetchCount === 1) {
        coverStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })

    dl.enqueue(v.id)
    await started
    dl.pause()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('pending'))
    const paused = listVideos(db, taskId)[0]
    expect(paused.local_path).toMatch(/\.download\.part\.mp4$/)
    expect(existsSync(paused.local_path!)).toBe(true)
    expect(videoFetchCount).toBe(1)

    dl.resume()
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(readFileSync(row.local_path!)).toEqual(source)
    expect(row.cover_path).toBeTruthy()
    expect(videoFetchCount).toBe(1)
    expect(coverFetchCount).toBe(2)
  })

  it('程序重启后复用数据库中的已验证源文件断点，不再请求过期视频地址', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('RESTART-CHECKPOINT')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const source = Buffer.alloc(2048, 9)
    source.write('ftypisom', 4)
    const checkpoint = join(dir, `.video-${v.id}.download.part.mp4`)
    writeFileSync(checkpoint, source)
    db.prepare("UPDATE videos SET status='pending', local_path=?, fetched_at='2000-01-01T00:00:00.000Z' WHERE id=?")
      .run(checkpoint, v.id)
    const fetchImpl = vi.fn(async () => { throw new Error('不应重新请求') })
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 1 },
      fetchImpl as unknown as typeof fetch, { validator: async () => true })

    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(readFileSync(row.local_path!)).toEqual(source)
    expect(existsSync(checkpoint)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('视频与封面下载成功：保存为完全相同的文件名主体', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('PAIR1', { coverUrl: 'https://img.test/c' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const cover = new Uint8Array([9, 8, 7])
    const fetchImpl = (async (url: unknown) => String(url).includes('img.test')
      ? new Response(cover, { status: 200, headers: { 'content-type': 'image/webp' } })
      : new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })

    dl.enqueue(v.id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(extname(row.cover_path!)).toBe('.webp')
    expect(basename(row.local_path!, '.mp4')).toBe(basename(row.cover_path!, '.webp'))
    expect(readFileSync(row.cover_path!)).toEqual(Buffer.from(cover))
  })

  it('R19 任务带 outputDir：视频直接下到那个文件夹，文件名只用标题、不下封面，下载目录里什么都没有', async () => {
    const target = join(dir, '达人', '暂存')            // 还不存在，下载器自己建
    const other = join(dir, '下载目录')
    const taskId = createTask(db, { ...input, outputDir: target })
    insertVideos(db, [item('JOB1', { title: '他用手把湿土捏成仕女', coverUrl: 'https://img.test/c' }),
      item('JOB2', { title: '', authorNickname: '奶龙' })], taskId, 'douyin')
    const vids = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const hits: string[] = []
    const fetchImpl = (async (url: unknown) => {
      hits.push(String(url))
      return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: other, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    for (const v of vids) dl.enqueue(v.id)
    await vi.waitFor(() => expect(listVideos(db, taskId).every(r => r.status === 'done')).toBe(true))
    const rows = listVideos(db, taskId)
    expect(dirname(rows[0].local_path!)).toBe(target)
    expect(readdirSync(target).sort()).toEqual(['JOB2.mp4', '他用手把湿土捏成仕女.mp4'])
    expect(rows[0].cover_path).toBeNull()
    expect(hits.some(u => u.includes('img.test'))).toBe(false)
    expect(existsSync(other) ? readdirSync(other) : []).toEqual([])
  })

  it('孤立旧封面占名时，视频与新封面共同使用 _1 后缀', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('AW001', { coverUrl: 'https://img.test/c' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    // 文件名主体现在只用标题（不再拼作者名和作品 ID），预占名跟着改；

    // 本用例验的是「孤立封面占名 → 视频与新封面共用 _1 后缀」，该行为未变

    writeFileSync(join(dir, '标题.webp'), 'old')
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const fetchImpl = (async (url: unknown) => String(url).includes('img.test')
      ? new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      : new Response(mp4, { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })

    dl.enqueue(v.id)
    // 等下载真的完成（以前固定等 80ms，CI 机器慢时还没下完就断言）
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 })

    const row = listVideos(db, taskId)[0]
    expect(basename(row.local_path!)).toBe('标题_1.mp4')
    expect(basename(row.cover_path!)).toBe('标题_1.jpg')
  })

  it('下载中修改目录时，当前视频与封面仍使用启动目录且不覆盖新目录旧封面', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('SWITCH', { coverUrl: 'https://img.test/c' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const newDir = mkdtempSync(join(dir, 'switched-'))
    const orphan = join(newDir, '标题.jpg')
    writeFileSync(orphan, 'old cover')
    const fetchImpl = (async (url: unknown) => String(url).includes('img.test')
      ? new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } })
      : new Response(Buffer.alloc(2048))) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, {
      validator: async () => {
        dl.updateSettings({ downloadDir: newDir, downloadConcurrency: 1, addressTtlMin: 30 })
        return true
      }
    })
    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(dirname(row.local_path!)).toBe(dir)
    expect(dirname(row.cover_path!)).toBe(dir)
    expect(readFileSync(orphan, 'utf8')).toBe('old cover')
  })

  it('封面 HTTP 失败不阻断视频完成，cover_path 保持空', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('PAIR2', { coverUrl: 'https://img.test/missing' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const fetchImpl = (async (url: unknown) => String(url).includes('img.test')
      ? new Response(null, { status: 503 })
      : new Response(mp4, { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })

    dl.enqueue(v.id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(row.local_path).toBeTruthy()
    expect(row.cover_path).toBeNull()
  })

  it('封面下载途中取消：状态 cancelled，并清理 MP4 与封面半成品', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('PAIR3', { coverUrl: 'https://img.test/slow' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let coverStarted!: () => void
    const started = new Promise<void>(resolve => { coverStarted = resolve })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('img.test')) return new Response(mp4, { status: 200 })
      const signal = init?.signal!
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          coverStarted()
          signal.addEventListener('abort', () => controller.error(new Error('aborted')))
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })

    dl.enqueue(v.id)
    await started
    dl.cancel([v.id])
    // 取消时状态马上变 cancelled，清理半成品在后面：等清理也做完（以前固定等 50ms，CI 机器慢时误报）
    await vi.waitFor(() => {
      expect(listVideos(db, taskId)[0].local_path).toBeNull()
      expect(readdirSync(dir)).toHaveLength(0)
    }, { timeout: 10_000 })

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    expect(row.local_path).toBeNull() // 已验证断点也一并清空，不留指向已删文件的路径
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('下载内容是坏文件（无 ftyp）→ 标记 failed + parse_error，删除坏文件', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('failed'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('parse_error')
  })

  it('HTTP 500 首次触发网络重试：pending + retry_count=1，5s 后重新入队', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].retry_count).toBe(1), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
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
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('failed'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network')
    expect(row.retry_count).toBe(3)
  })

  // 需求变更（2026-10-06 全面检查 B2）：以前超过 TTL 就不发请求直接判过期，排队 / 暂停 / 重启都会让视频永远下不了；
  // 现在先试着下，平台拒绝（403/404/410）且地址超过 TTL 才判过期（更多用例见 download-safety.test.ts）
  it('地址超过 TTL 且平台拒绝 → failed + 错误码 address_expired，清掉残留半截文件', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET fetched_at=? WHERE id=?').run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), v.id)
    const orphanPart = join(dir, `.video-${v.id}.download.part.mp4`)
    writeFileSync(orphanPart, Buffer.alloc(2048)) // 模拟崩溃发生在写完文件、登记断点之前
    const fetchImpl = (async () => new Response('expired', { status: 403 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('failed'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('address_expired')
    expect(existsSync(orphanPart)).toBe(false)
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
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('failed'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
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
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.pause()
    expect(dl.isPaused()).toBe(true)
    dl.enqueue(v.id)
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0) // 暂停中 drain 不拉取
    dl.resume()
    // 等下载真的完成（以前固定等 50ms，CI 机器慢时会误报）
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 })
    const row = listVideos(db, taskId)[0]
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
    }) as unknown as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞在 abort 上
    dl.cancel([v.id])
    await new Promise(r => setTimeout(r, 30)) // 等 abort 传播、runOne 收尾
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    expect(row.retry_count).toBe(0) // 不走 5s 网络重试，retry_count 不增
  })

  it('校验阶段 cancel：文件已完整落盘但 validator 阻塞期间删除 → done 提交前 signal 守卫走 aborted 收尾，完整文件被删不留孤儿', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let valStarted!: () => void
    let releaseVal!: () => void
    const started = new Promise<void>(res => { valStarted = res })
    // 校验阶段（statSync/isMp4/ffprobe/validator）不感知 abort：阻塞直到外部放行
    const validator = async () => {
      valStarted()
      await new Promise<void>(res => { releaseVal = res })
      return true
    }
    const fetchImpl = (async () => new Response(mp4, { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator })
    dl.enqueue(v.id)
    dl.start()
    await started // 已进入校验阶段，文件已完整写盘
    dl.cancel([v.id]) // 删除/取消发生在此非 abort 感知窗口
    releaseVal() // 校验结束 → runOne 继续 → done 提交前的 signal 守卫应拦截
    await new Promise(r => setTimeout(r, 30)) // 等 runOne aborted 收尾
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled') // 不提交 done
    expect(row.local_path).toBeNull()
    expect(readdirSync(dir)).toHaveLength(0) // 完整文件被 rmSync，不留孤儿
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
    }) as unknown as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl)
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
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.download([v.id])
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
  })

  it('网络重试回退窗口内 cancel → 清定时器，5s 后不再重新下载', async () => {
    // 只伪造 setTimeout/clearTimeout，避免影响 Date/微任务
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const taskId = createTask(db, input)
      insertVideos(db, [item()], taskId, 'douyin')
      const [v] = listVideos(db, taskId)
      let fetchCount = 0
      const fetchImpl = (async () => { fetchCount++; return new Response('err', { status: 500 }) }) as typeof fetch
      const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
      dl.enqueue(v.id)
      dl.start()
      // 让第一次下载(500)跑完 → 进入 5s 网络重试回退（status=pending, retry_count=1）
      await vi.advanceTimersByTimeAsync(0)
      let row = listVideos(db, taskId)[0]
      expect(row.status).toBe('pending')
      expect(row.retry_count).toBe(1)
      // 回退窗口内取消：应清掉定时器
      dl.cancel([v.id])
      await vi.advanceTimersByTimeAsync(6000) // 超过 5s 回退窗口
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('cancelled') // 未被重新下载
      expect(fetchCount).toBe(1) // 定时器被清，不再发起 fetch
    } finally {
      vi.useRealTimers()
    }
  })

  it('全局 pause 中断在途：fetch 收到 abort，状态回 pending，resume 后重新下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) { // 第一次在途阻塞，等 abort；之后的调用直接成功
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞在 abort 上
    dl.pause() // 全局暂停：应中断在途
    await new Promise(r => setTimeout(r, 30))
    let row = listVideos(db, taskId)[0]
    expect(row.status).toBe('pending') // 全局暂停中断 → 回 pending（非 cancelled）
    expect(row.error).toBeNull()
    expect(fetchCount).toBe(1) // 暂停中不重新拉取
    dl.resume()
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done') // resume 后重新下载成功
    expect(fetchCount).toBe(2)
  })

  it('单条 pause 在途：中断标 paused（区别于全局暂停的 pending 与取消的 cancelled），resumeVideo 后恢复', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pauseVideo([v.id]) // 单条暂停在途
    await new Promise(r => setTimeout(r, 30))
    let row = listVideos(db, taskId)[0]
    expect(row.status).toBe('paused')
    expect(row.error).toBeNull()
    expect(fetchCount).toBe(1) // 暂停后不重新拉取
    dl.resumeVideo([v.id]) // 单条继续
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 10_000 }) // 等到真的结束（以前固定等几十毫秒，CI 机器慢时误报）
    row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(2)
  })

  it('单条 pause 排队项：移出队列标 paused，不再下载', async () => {
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
    }) as unknown as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started
    expect(fetchCount).toBe(1) // v2 尚未开始
    dl.pauseVideo([v2.id])
    await new Promise(r => setTimeout(r, 20))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v2.id)!.status).toBe('paused')
    expect(fetchCount).toBe(1) // 移出队列，不再下载
    dl.cancel([v1.id]) // 清理在途，避免悬挂 promise
    await new Promise(r => setTimeout(r, 20))
  })

  it('AbortError 路由：全局暂停中断后若被 cancel 抢先 → 保持 cancelled 不再重排', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
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
    }) as unknown as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pause() // 全局暂停中断在途
    dl.cancel([v.id]) // 中断后立刻取消：应优先于重排
    await new Promise(r => setTimeout(r, 30))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    dl.resume()
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(1) // 未被重新下载
  })

  it('全局 resume 同时恢复单条暂停项（清空 pausedIds）', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [v1, v2] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started // v1 在途阻塞
    dl.pauseVideo([v2.id]) // 单条暂停排队项 v2
    expect(listVideos(db, taskId).find(r => r.id === v2.id)!.status).toBe('paused')
    dl.pause() // 全局暂停（中断 v1）
    await new Promise(r => setTimeout(r, 30))
    expect(listVideos(db, taskId).find(r => r.id === v1.id)!.status).toBe('pending')
    dl.resume() // 全局继续：v1 重新下载，单条暂停的 v2 也一并恢复
    await new Promise(r => setTimeout(r, 80))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v1.id)!.status).toBe('done')
    expect(rows.find(r => r.id === v2.id)!.status).toBe('done')
    expect(fetchCount).toBe(3) // v1(中断) + v1(重下) + v2
  })

  it('单条 pause 后立即全局 resume：延迟 abort 回调不误标 cancelled，恢复下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        // 模拟写盘路径经 stream/fs macrotask 传播的延迟：abort 后 50ms 才抛 AbortError
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), 50)
          })
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞
    dl.pauseVideo([v.id]) // 单条暂停在途：abort 已发，回调 50ms 后才落定
    dl.resume() // 期间全局继续：清空 pausedIds，abort 回调此时尚未执行
    await new Promise(r => setTimeout(r, 150)) // 等延迟回调落定 + 重新下载完成
    const row = listVideos(db, taskId)[0]
    expect(row.status).not.toBe('cancelled') // 不能因回调迟到被误标取消
    expect(row.status).toBe('done') // 已回队恢复，drain 续下
    expect(fetchCount).toBe(2)
  })

  it('全局 pause 后立即 resume：延迟 abort 回调不误标 cancelled，pending 回队续下', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        // 同上：模拟 abort 事件经 macrotask 延迟传播
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), 50)
          })
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pause() // 全局暂停：中断在途
    dl.resume() // 在 abort 回调落定前已恢复
    await new Promise(r => setTimeout(r, 150))
    const row = listVideos(db, taskId)[0]
    expect(row.status).not.toBe('cancelled') // 不能因回调迟到被误标取消
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(2)
  })

  it('网络重试回退窗口内单条 pause → 清定时器，5s 后不再重新下载', async () => {
    // 只伪造 setTimeout/clearTimeout，避免影响 Date/微任务
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const taskId = createTask(db, input)
      insertVideos(db, [item()], taskId, 'douyin')
      const [v] = listVideos(db, taskId)
      let fetchCount = 0
      const fetchImpl = (async () => { fetchCount++; return new Response('err', { status: 500 }) }) as typeof fetch
      const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, addressTtlMin: 30 }, fetchImpl)
      dl.enqueue(v.id)
      dl.start()
      // 让第一次下载(500)跑完 → 进入 5s 网络重试回退（status=pending, retry_count=1）
      await vi.advanceTimersByTimeAsync(0)
      let row = listVideos(db, taskId)[0]
      expect(row.status).toBe('pending')
      expect(row.retry_count).toBe(1)
      // 回退窗口内单条暂停：应清掉定时器并标 paused
      dl.pauseVideo([v.id])
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('paused')
      await vi.advanceTimersByTimeAsync(6000) // 超过 5s 回退窗口
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('paused') // 定时器被清，未被重新下载
      expect(fetchCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('下载请求头按平台取，不再靠 www.{platform}.com 拼字符串', () => {
  it('抖音与快手各用自己的 Referer', () => {
    expect(buildRequestHeaders('douyin').referer).toBe('https://www.douyin.com/')
    expect(buildRequestHeaders('kuaishou').referer).toBe('https://www.kuaishou.com/')
  })

  it('未注册平台不猜 Referer（宁可不带，也不发一个编出来的来源）', () => {
    expect(buildRequestHeaders('unknown').referer).toBeUndefined()
  })

  it('User-Agent 照常带上', () => {
    expect(buildRequestHeaders('kuaishou')['user-agent']).toMatch(/Mozilla/)
  })
})

describe('R20 下载卡住：一段时间没收到数据就掐断，交给原来的自动重试', () => {
  it('服务器发了一点就不动了 → 无数据超时掐断，按网络错误自动重试（不会永远占着一个下载名额）', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('IDLE-1')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(100)) } // 发 100 字节后再也不动，也不结束
    }), { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl,
      { validator: async () => true, idleTimeoutMs: 80 })
    const events: Array<{ status: string; error?: string }> = []
    dl.onEvent(e => { if (e.type === 'video:status') events.push(e) })
    dl.enqueue(v.id)

    await vi.waitFor(() => expect(events.some(e => e.status === 'failed')).toBe(true), { timeout: 3000 })
    expect(events.find(e => e.status === 'failed')!.error).toBe('network')
    // 走的是原来的网络重试：回到 pending、重试次数 +1（5 秒后自动再下）
    expect(db.prepare('SELECT status, retry_count FROM videos WHERE id=?').get(v.id)).toEqual({ status: 'pending', retry_count: 1 })
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true)) // 名额已经让出来
    expect(readdirSync(dir).some(n => n.includes('.part.'))).toBe(false) // 半截文件已清掉
    dl.cancel([v.id]) // 清掉 5 秒后的重试计时器
  })

  it('慢但一直在传（每次间隔都小于超时）→ 不算卡住，正常下完', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('SLOW-1')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const chunk = Buffer.alloc(256)
    chunk.write('ftypisom', 4)
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        for (let i = 0; i < 8; i++) {
          c.enqueue(new Uint8Array(chunk))
          await new Promise(r => setTimeout(r, 30))
        }
        c.close()
      }
    }), { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, addressTtlMin: 30 }, fetchImpl,
      { validator: async () => true, idleTimeoutMs: 150 })
    dl.enqueue(v.id)
    await vi.waitFor(() => expect(listVideos(db, taskId)[0].status).toBe('done'), { timeout: 3000 })
    expect(listVideos(db, taskId)[0].file_size).toBe(256 * 8)
  })
})

// 2026-10-07 性能 F13：整条视频网络重试以前固定 5 秒；现在第一次 5 秒、第二次 15 秒（越来越慢，别跟着限流一起猛打）
describe('整条视频网络重试的等待', () => {
  it('第 1 次 5 秒，第 2 次 15 秒', () => {
    expect(networkRetryDelayMs(1)).toBe(5000)
    expect(networkRetryDelayMs(2)).toBe(15000)
  })
})
