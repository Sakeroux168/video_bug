import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, refreshSeenVideo } from '../src/main/db'
import { Downloader } from '../src/main/downloader'
import { ensureUniqueStem } from '../src/main/filename'
import { onBeforeQuit } from '../src/main/shutdown'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

vi.mock('../src/main/videoNormalizer', () => ({ normalizeVideo: vi.fn() }))

// 2026-10-06 全面检查「数据安全」第一组：下载安全（B1 同名覆盖、B2 地址过期、#11 分段残片、#12 退出不停 ffmpeg）

let db: DatabaseSync
let dir: string
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'dl-safe-'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (awemeId: string, over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId, title: '同名标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: `https://cdn.test/${awemeId}.mp4`, coverUrl: '', width: 0, height: 0,
  durationSec: 10, publishTime: 1710000000, likes: 0, ...over
})
const mp4 = (fill: number): Buffer => { const b = Buffer.alloc(2048, fill); b.writeUInt32BE(0x18, 0); b.write('ftypisom', 4); return b }
const settings = (over: Record<string, unknown> = {}) => ({ downloadDir: dir, downloadConcurrency: 2, addressTtlMin: 30, ...over })
const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r }); return { p, resolve } }

describe('B1 同名视频不能互相覆盖', () => {
  it('两条同名视频同时下载 → 存成两个文件，内容各是各的', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const gate = deferred()
    let started = 0
    const fetchImpl = (async (url: unknown) => {
      started++
      if (started === 2) gate.resolve()
      await gate.p // 两条都选好文件名、都开始下之后才一起返回
      return new Response(new Uint8Array(mp4(String(url).includes('/A.') ? 1 : 2)))
    }) as typeof fetch
    const dl = new Downloader(db, settings(), fetchImpl, { validator: async () => true })
    for (const v of listVideos(db, taskId)) dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    const rows = listVideos(db, taskId)
    expect(rows.map(r => r.status)).toEqual(['done', 'done'])
    expect(new Set(rows.map(r => r.local_path)).size).toBe(2)
    for (const r of rows) expect(readFileSync(r.local_path!)[100]).toBe(r.aweme_id === 'A' ? 1 : 2)
  })

  it('后一条同名视频下载失败 → 不会把前一条已下完的文件删掉', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const aDone = deferred()
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/A.')) return new Response(new Uint8Array(mp4(1)))
      await aDone.p
      return new Response('no', { status: 403 })
    }) as typeof fetch
    const dl = new Downloader(db, settings(), fetchImpl, { validator: async () => true })
    dl.onEvent(e => { if (e.type === 'video:status' && e.status === 'done') setTimeout(aDone.resolve, 10) })
    for (const v of listVideos(db, taskId)) dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    const [a, b] = listVideos(db, taskId)
    expect(a.status).toBe('done')
    expect(b.status).toBe('failed')
    expect(existsSync(a.local_path!)).toBe(true)
    expect(readFileSync(a.local_path!)[100]).toBe(1)
  })

  it('下载途中别的程序放了一个同名文件 → 不覆盖它，自己换个名字存', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    const outside = join(dir, '同名标题.mp4')
    const fetchImpl = (async () => {
      writeFileSync(outside, 'not mine')
      return new Response(new Uint8Array(mp4(1)))
    }) as typeof fetch
    const dl = new Downloader(db, settings(), fetchImpl, { validator: async () => true })
    dl.enqueue(listVideos(db, taskId)[0].id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    const [a] = listVideos(db, taskId)
    expect(a.status).toBe('done')
    expect(a.local_path).not.toBe(outside)
    expect(readFileSync(outside, 'utf8')).toBe('not mine')
    expect(readFileSync(a.local_path!)[100]).toBe(1)
  })

  it('ensureUniqueStem 可以额外跳过「正在用的名字」', () => {
    expect(ensureUniqueStem(dir, '标题', ['.mp4'], s => s === '标题' || s === '标题_1')).toBe('标题_2')
  })
})

describe('B2 下载地址不按「抓到 30 分钟」一刀切判过期', () => {
  const old = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  it('抓到一天后才轮到下载、地址其实还能用 → 照常下载成功', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET fetched_at=? WHERE id=?').run(old, v.id)
    const dl = new Downloader(db, settings(), (async () => new Response(new Uint8Array(mp4(1)))) as typeof fetch, { validator: async () => true })
    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    expect(listVideos(db, taskId)[0].status).toBe('done')
  })

  it('地址旧了、平台也拒绝了（403/404/410）→ 判「链接过期」，不白白重试', async () => {
    for (const status of [403, 404, 410]) {
      const taskId = createTask(db, input)
      insertVideos(db, [item(`OLD${status}`)], taskId, 'douyin')
      const [v] = listVideos(db, taskId)
      db.prepare('UPDATE videos SET fetched_at=? WHERE id=?').run(old, v.id)
      const fetchImpl = vi.fn(async () => new Response('x', { status }))
      const dl = new Downloader(db, settings(), fetchImpl as unknown as typeof fetch, { validator: async () => true })
      dl.enqueue(v.id)
      await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
      expect(listVideos(db, taskId)[0]).toMatchObject({ status: 'failed', error: 'address_expired' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('地址是新的、平台拒绝 → 仍按「平台拒绝」处理（不误报过期）', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('NEW')], taskId, 'douyin')
    const dl = new Downloader(db, settings(), (async () => new Response('x', { status: 403 })) as typeof fetch, { validator: async () => true })
    dl.enqueue(listVideos(db, taskId)[0].id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    expect(listVideos(db, taskId)[0]).toMatchObject({ status: 'failed', error: 'forbidden' })
  })

  it('重新爬到库里已有、还没下好的视频 → 换上新地址和新时间；已下好的不动地址', () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    db.prepare("UPDATE videos SET status='failed', error='address_expired', fetched_at=? WHERE aweme_id='A'").run(old)
    db.prepare("UPDATE videos SET status='done', fetched_at=? WHERE aweme_id='B'").run(old)
    refreshSeenVideo(db, 'douyin', item('A', { playUrl: 'https://cdn.test/A-new.mp4', likes: 99 }))
    refreshSeenVideo(db, 'douyin', item('B', { playUrl: 'https://cdn.test/B-new.mp4', likes: 7 }))
    const [a, b] = listVideos(db, taskId)
    expect(a.play_addr).toBe('https://cdn.test/A-new.mp4')
    expect(a.fetched_at > old).toBe(true)
    expect(b.play_addr).toBe('https://cdn.test/B.mp4')
    expect(b.fetched_at).toBe(old)
    // B8：点赞等数据每次再抓到都更新
    expect(JSON.parse(a.stats!).likes).toBe(99)
    expect(JSON.parse(b.stats!).likes).toBe(7)
  })

  it('再抓到时没拿到地址（小红书列表页只有卡片）→ 不把已有地址清空', () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    refreshSeenVideo(db, 'douyin', item('A', { playUrl: '' }))
    expect(listVideos(db, taskId)[0].play_addr).toBe('https://cdn.test/A.mp4')
  })
})

describe('#11 分段下载的残片不留在下载目录里', () => {
  it('启动清理：删掉分段残片和没人登记的半截文件，保留数据库登记的断点和正常视频', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const checkpoint = join(dir, `.video-${v.id}.download.part.mp4`)
    writeFileSync(checkpoint, mp4(1))
    db.prepare("UPDATE videos SET status='pending', local_path=? WHERE id=?").run(checkpoint, v.id)
    const junk = [
      `.video-${v.id}.download.part.mp4.segment-0.part`,
      '.video-999.download.part.mp4',
      '.video-999.download.part.mp4.segment-2.part',
      '某标题.cover.part'
    ]
    for (const f of junk) writeFileSync(join(dir, f), 'x')
    writeFileSync(join(dir, '正常视频.mp4'), 'keep')
    const dl = new Downloader(db, settings(), fetch)
    expect(await dl.sweepOrphanParts()).toBe(junk.length)
    expect(readdirSync(dir).sort()).toEqual([`.video-${v.id}.download.part.mp4`, '正常视频.mp4'].sort())
  })

  it('开始下载一条视频时，先清掉它上次留下的分段残片', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const seg = join(dir, `.video-${v.id}.download.part.mp4.segment-1.part`)
    writeFileSync(seg, 'old')
    const dl = new Downloader(db, settings(), (async () => new Response(new Uint8Array(mp4(1)))) as typeof fetch, { validator: async () => true })
    dl.enqueue(v.id)
    await vi.waitFor(() => expect(dl.isIdle()).toBe(true))
    expect(existsSync(seg)).toBe(false)
  })
})

describe('#12 关软件时停掉视频处理（ffmpeg）', () => {
  it('退出前：视频处理停下、浏览器窗口销毁、本机接口关闭', () => {
    const processor = { stop: vi.fn() }
    const browser = { dispose: vi.fn() }
    const bridge = { close: vi.fn() }
    onBeforeQuit({ processor, browser, bridge })
    expect(processor.stop).toHaveBeenCalled()
    expect(browser.dispose).toHaveBeenCalled()
    expect(bridge.close).toHaveBeenCalled()
  })

  it('有的部件还没建好（null）也不报错', () => {
    expect(() => onBeforeQuit({ processor: null, browser: null, bridge: null })).not.toThrow()
  })
})
