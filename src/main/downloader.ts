import type { DatabaseSync } from 'node:sqlite'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { basename, extname, join } from 'path'
import { execFile } from 'child_process'
import { findBin } from './ffbin'
import type { AppSettings, VideoRow, VideoStatus } from '../shared/types'
import { clampDownloadSegments, ERROR } from '../shared/types'
import { classifyDownloadError, AddressPolicy } from './errors'
import { safeFilename, ensureUniqueStem } from './filename'
import { downloadCover } from './cover'
import { setVideoStatus } from './db'
import { getAdapter } from './adapters'

export function buildUserAgent(_platform: string): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
}

/** 下载媒体的请求头。Referer 取自适配器，不再用 `www.{platform}.com` 拼——
 *  未注册平台宁可不带 Referer，也不发一个编出来的来源。 */
export function buildRequestHeaders(platform: string): Record<string, string> {
  const referer = getAdapter(platform)?.downloadReferer
  return referer
    ? { 'user-agent': buildUserAgent(platform), referer }
    : { 'user-agent': buildUserAgent(platform) }
}

/** 下载链只认这四项。历史 settings.json 里残留的 normalizeVideo/keepOriginalVideo 即使随整份设置传进来也不会被读取——
 *  下载任务保存平台解析到的原视频，统一分辨率是「视频处理」页的手动批处理，不再是下载的必经步骤。 */
type DlSettings = Pick<AppSettings, 'downloadDir' | 'downloadConcurrency' | 'addressTtlMin'>
  & Partial<Pick<AppSettings, 'downloadSegments'>>

/** R20：下载「多久没收到一个字节」就判断卡住（掐断后走原有的网络错误自动重试） */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60000
/** R20：ffprobe 校验视频轨最多跑多久（卡住当作校验不过，不让一条下载永远占着并发名额） */
export const FFPROBE_TIMEOUT_MS = 30000
/** R20：封面整体最多下多久（封面是附属品，超时就不要封面，视频照常完成） */
const COVER_TIMEOUT_MS = 60000
/** D8：下载进度最多多久发一次（毫秒） */
const PROGRESS_INTERVAL_MS = 1000
/** 视频与封面共用一个主体名；.original.mp4 仍占位：旧版转码流程留下的原片可能与新下载同名主体，不能撞上 */
const STEM_EXTENSIONS = ['.mp4', '.original.mp4', '.jpg', '.jpeg', '.png', '.webp']
/** Windows 文件名不分大小写，占位键统一小写 */
function stemKey(dir: string, stem: string): string { return join(dir, stem).toLowerCase() }
/** 每段最多尝试 3 次（首次 + 2 次重试）；不做无限重试。 */
export const SEGMENT_MAX_ATTEMPTS = 3

interface ByteRange {
  start: number
  end: number
  path: string
}

interface SegmentSession {
  url: string
  sourcePart: string
  total: number
  configuredSegments: number
  ranges: ByteRange[]
}

function blockedMediaType(response: Response): boolean {
  const type = (response.headers.get('content-type') || '').toLowerCase()
  return type.includes('text/html') || type.includes('application/json')
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? '')
  if (!match) return null
  const [, start, end, total] = match.map(Number)
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null
  return { start, end, total }
}

function splitRanges(total: number, count: number, sourcePart: string): ByteRange[] {
  const actual = Math.max(1, Math.min(count, total))
  const base = Math.floor(total / actual)
  const extra = total % actual
  let start = 0
  return Array.from({ length: actual }, (_, index) => {
    const length = base + (index < extra ? 1 : 0)
    const range = { start, end: start + length - 1, path: `${sourcePart}.segment-${index}.part` }
    start += length
    return range
  })
}
type DlEvent =
  | { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }
  /** D8：下载进度（字节 + 每秒速度），最多每秒一条；total 未知时为 null */
  | { type: 'video:progress'; id: number; received: number; total: number | null; speed: number }

/** 一条视频的下载进度表 */
interface ProgressMeter { received: number; total: number | null; lastAt: number; lastReceived: number; speed: number }
/** 下载函数里只管报「又收到多少字节 / 总共多大」，算速度、节流、发事件都在 Downloader 里 */
interface ProgressSink { total(n: number | null, alreadyReceived?: number): void; bytes(n: number): void }

export class Downloader {
  private queue: number[] = []
  private active = 0
  private paused = false
  /** 单条暂停的视频 id 集合（会话级；全局继续会清空，重启后不恢复） */
  private pausedIds = new Set<number>()
  /** abort 原因快照：abort 回调可能经 stream/fs macrotask 延迟落定（可跨过下一 IPC 消息），
   *  期间 paused/pausedIds 可能已被 resume 清掉，路由以 abort 时刻的快照为准而非"当下"状态 */
  private abortReasons = new Map<number, 'paused' | 'cancelled'>()
  private aborters = new Map<number, AbortController>()
  private retryTimers = new Map<number, NodeJS.Timeout>()
  private listeners: Array<(e: DlEvent) => void> = []
  private fetching: Record<number, boolean> = {}
  private validator: ((file: string) => Promise<boolean>) | null
  /** R20：无数据超时毫秒（测试可调小） */
  private idleTimeoutMs: number
  /** 会话级分段断点；只承诺同一次程序运行内暂停后继续，不跨重启。 */
  private segmentSessions = new Map<number, SegmentSession>()
  private progressIntervalMs: number
  private meters = new Map<number, ProgressMeter>()
  /** 正在下载、还没落盘的文件名（目录+主体名，小写）。同名视频同时下载时靠它避开彼此，否则后存的覆盖先存的 */
  private reservedStems = new Set<string>()

  constructor(
    private db: DatabaseSync,
    private settings: DlSettings,
    private fetchImpl: typeof fetch = fetch,
    opts?: { validator?: (file: string) => Promise<boolean>; idleTimeoutMs?: number; progressIntervalMs?: number }
  ) {
    // C1: 确保下载目录存在（recursive 幂等）；目录不可写时由下载错误分类兜底为 ERROR.DISK
    try { mkdirSync(this.settings.downloadDir, { recursive: true }) } catch { /* ignore */ }
    this.validator = opts?.validator ?? null
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS
    this.progressIntervalMs = opts?.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  }

  /** 设置保存后热更新下载参数（目录/并发/地址TTL），无需重建 Downloader */
  updateSettings(s: DlSettings): void { this.settings = s }

  onEvent(cb: (e: DlEvent) => void): void { this.listeners.push(cb) }

  enqueue(id: number): void {
    if (this.fetching[id]) return
    this.fetching[id] = true
    this.queue.push(id)
    this.drain()
  }

  start(): void { this.drain() }

  isIdle(): boolean { return this.active === 0 && this.queue.length === 0 }

  /** 暂停：drain 不再拉取新任务，且立即中断所有在途下载（AbortError 分支标回 pending 重新入队） */
  pause(): void {
    this.paused = true
    for (const [id, aborter] of this.aborters) {
      this.abortReasons.set(id, 'paused') // 先快照原因：abort 回调可能延迟到 resume 之后才落定
      aborter.abort()
    }
  }

  /** 恢复：清暂停标记，被中断的在途已回队；单条暂停的项一并恢复（全局继续=所有单条暂停的也恢复） */
  resume(): void {
    this.paused = false
    const ids = [...this.pausedIds]
    this.pausedIds.clear()
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (row && row.status === 'paused') {
        this.db.prepare("UPDATE videos SET status='pending', error=NULL WHERE id=?").run(id)
        this.emit({ type: 'video:status', id, status: 'pending' })
        this.enqueue(id)
      }
    }
    this.drain()
  }

  isPaused(): boolean { return this.paused }

  /** 单条暂停：在途 abort（AbortError 分支标 paused）、排队项移出队列、清重试回退定时器，状态标 paused；对已结束的 id 幂等无副作用 */
  pauseVideo(ids: number[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (!row) continue
      if (row.status !== 'pending' && row.status !== 'downloading') continue
      this.pausedIds.add(id)
      // 5s 网络重试回退窗口内暂停：清定时器，防止 5s 后被重新入队下载
      const timer = this.retryTimers.get(id)
      if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
      const aborter = this.aborters.get(id)
      if (aborter) { this.abortReasons.set(id, 'paused'); aborter.abort() } // 在途：先快照原因再掐断 fetch/写盘
      const qi = this.queue.indexOf(id)
      if (qi !== -1) {
        this.queue.splice(qi, 1) // 排队中：移出队列
        delete this.fetching[id] // 未开始的清 fetching，之后可重新 download
      }
      setVideoStatus(this.db, id, 'paused')
      this.emit({ type: 'video:status', id, status: 'paused' })
    }
  }

  /** 单条继续：paused → pending 并入队重新下载 */
  resumeVideo(ids: number[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (!row) continue
      if (row.status !== 'paused') continue
      this.pausedIds.delete(id)
      this.db.prepare("UPDATE videos SET status='pending', error=NULL WHERE id=?").run(id)
      this.emit({ type: 'video:status', id, status: 'pending' })
      this.enqueue(id)
    }
  }

  /** 取消：在途 abort、排队项移出队列、状态标 cancelled；对已结束(done/failed)的 id 幂等无副作用 */
  cancel(ids: number[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (!row) continue
      // 只对"可取消"态生效：paused 也允许取消，以便清掉会话级分段断点。
      if (row.status !== 'pending' && row.status !== 'downloading' && row.status !== 'collected' && row.status !== 'paused') continue
      // 5s 网络重试回退窗口内取消：清定时器，防止 5s 后被重新入队下载
      const timer = this.retryTimers.get(id)
      if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
      const aborter = this.aborters.get(id)
      if (aborter) { this.abortReasons.set(id, 'cancelled'); aborter.abort() } // 在途：先快照原因再掐断 fetch/写盘
      else this.clearSegmentSession(id) // 已暂停且 runOne 已收尾：此时直接清理保留的完成段
      const qi = this.queue.indexOf(id)
      if (qi !== -1) {
        this.queue.splice(qi, 1) // 排队中：移出队列
        delete this.fetching[id] // 未开始的清 fetching，之后可重新 download
      }
      setVideoStatus(this.db, id, 'cancelled')
      this.emit({ type: 'video:status', id, status: 'cancelled' })
    }
  }

  /** 手动下载：collected/cancelled/failed → pending 并入队（暂停态也允许入队，resume 后统一拉取） */
  download(ids: number[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (!row) continue
      if (row.status !== 'collected' && row.status !== 'cancelled' && row.status !== 'failed') continue
      setVideoStatus(this.db, id, 'pending', { error: null, retry_count: 0 })
      this.enqueue(id)
    }
  }

  private emit(e: DlEvent): void { for (const l of this.listeners) l(e) }

  /** D8：给一条视频建进度表，返回下载函数用的 sink（字节到了就报，节流到 progressIntervalMs 发一次） */
  private progressSink(id: number): ProgressSink {
    const flush = (m: ProgressMeter, force: boolean): void => {
      const now = Date.now()
      const dt = now - m.lastAt
      if (!force && dt < this.progressIntervalMs) return
      if (dt > 0) m.speed = Math.max(0, Math.round((m.received - m.lastReceived) * 1000 / dt))
      m.lastAt = now
      m.lastReceived = m.received
      this.emit({ type: 'video:progress', id, received: m.received, total: m.total, speed: m.speed })
    }
    return {
      total: (n, already = 0) => {
        this.meters.set(id, { received: already, total: n, lastAt: Date.now(), lastReceived: already, speed: 0 })
      },
      bytes: n => {
        const m = this.meters.get(id)
        if (!m) return
        m.received = Math.max(0, m.received + n)
        if (m.total !== null) m.received = Math.min(m.received, m.total)
        flush(m, m.total !== null && m.received === m.total && n > 0) // 下完那一下一定发，界面能看到 100%
      }
    }
  }

  /**
   * 清掉下载目录里没人要的半截文件（启动时调一次）：
   *  - 分段残片 `.video-N.download.part.mp4.segment-K.part`：分段断点只在内存里，重启后一定没用
   *  - `.video-N.download.part.mp4`：数据库没登记成断点的
   *  - `xxx.cover.part`：没在下载的
   * 正在下载的那几条一律不碰。返回删掉的个数。
   */
  async sweepOrphanParts(): Promise<number> {
    const dir = this.settings.downloadDir
    let names: string[]
    try { names = await readdir(dir) } catch { return 0 }
    const busy = (id: number): boolean => Boolean(this.fetching[id]) || this.aborters.has(id) || this.segmentSessions.has(id)
    const checkpoints = new Set((this.db.prepare("SELECT local_path FROM videos WHERE local_path LIKE '%.download.part.mp4'")
      .all() as Array<{ local_path: string }>).map(r => r.local_path.toLowerCase()))
    let removed = 0
    for (const name of names) {
      const full = join(dir, name)
      const seg = /^\.video-(\d+)\.download\.part\.mp4\.segment-\d+\.part$/.exec(name)
      const part = /^\.video-(\d+)\.download\.part\.mp4$/.exec(name)
      const cover = /^(.+)\.cover\.part$/.exec(name)
      let junk = false
      if (seg) junk = !busy(Number(seg[1]))
      else if (part) junk = !busy(Number(part[1])) && !checkpoints.has(full.toLowerCase())
      else if (cover) junk = !this.reservedStems.has(stemKey(dir, cover[1]))
      if (!junk) continue
      try { await rm(full, { force: true }); removed++ } catch { /* 被占用就下次再说 */ }
    }
    return removed
  }

  /** 这条视频上次（重启前）留下的分段残片；内存里还有它的分段断点时不能删 */
  private removeStaleSegments(id: number, dir: string, sourcePart: string): void {
    if (this.segmentSessions.has(id)) return
    const prefix = `${basename(sourcePart)}.segment-`
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name.startsWith(prefix)) try { rmSync(join(dir, name), { force: true }) } catch { /* ignore */ }
    }
  }

  /** 选一个盘上没有、也没被其他在途下载占着的主体名，并立即占住 */
  private reserveStem(dir: string, name: string): { stem: string; key: string } {
    const stem = ensureUniqueStem(dir, name, STEM_EXTENSIONS, c => this.reservedStems.has(stemKey(dir, c)))
    const key = stemKey(dir, stem)
    this.reservedStems.add(key)
    return { stem, key }
  }

  /** 老测试/旧调用没有这个新键时维持原单连接；真实 settings.json 会由 settings.ts 补默认 3。 */
  private segmentCount(): number {
    return this.settings.downloadSegments === undefined ? 1 : clampDownloadSegments(this.settings.downloadSegments)
  }

  private clearSegmentSession(id: number, removeFiles = true): void {
    const session = this.segmentSessions.get(id)
    if (!session) return
    if (removeFiles) {
      for (const range of session.ranges) {
        try { rmSync(range.path, { force: true }) } catch { /* ignore */ }
      }
      try { rmSync(session.sourcePart, { force: true }) } catch { /* ignore */ }
    }
    this.segmentSessions.delete(id)
  }

  /** 只把长度完全吻合的段当作断点；中断到一半的段会被清掉，继续时重下该段。 */
  private completedSegmentPaths(id: number): string[] {
    const session = this.segmentSessions.get(id)
    if (!session) return []
    const completed: string[] = []
    for (const range of session.ranges) {
      const expected = range.end - range.start + 1
      try {
        if (statSync(range.path).size === expected) completed.push(range.path)
        else rmSync(range.path, { force: true })
      } catch { /* missing/incomplete */ }
    }
    return completed
  }

  private async probeRange(url: string, headers: Record<string, string>, aborter: AbortController): Promise<number | null> {
    const idle = new AbortController()
    const signal = AbortSignal.any([aborter.signal, idle.signal])
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idle.abort(), this.idleTimeoutMs)
    }
    armIdle()
    try {
      const response = await this.fetchImpl(url, { signal, headers: { ...headers, Range: 'bytes=0-0' } })
      if (blockedMediaType(response)) {
        await response.body?.cancel().catch(() => {})
        throw new Error('bad_mp4')
      }
      const parsed = parseContentRange(response.headers.get('content-range'))
      const declaredLength = contentLength(response)
      if (response.status !== 206 || !response.body || !parsed
        || parsed.start !== 0 || parsed.end !== 0 || parsed.total < 1
        || (declaredLength !== null && declaredLength !== 1)) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      const reader = response.body.getReader()
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        bytes += value.byteLength
        if (bytes > 1) {
          await reader.cancel().catch(() => {})
          return null
        }
      }
      return bytes === 1 ? parsed.total : null
    } catch (err) {
      if (idle.signal.aborted && !aborter.signal.aborted) {
        throw new Error(`download_idle_timeout：${Math.round(this.idleTimeoutMs / 1000)} 秒没收到数据`)
      }
      throw err
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer)
    }
  }

  private async downloadSingle(
    url: string,
    target: string,
    headers: Record<string, string>,
    aborter: AbortController,
    progress?: ProgressSink
  ): Promise<void> {
    const idle = new AbortController()
    const signal = AbortSignal.any([aborter.signal, idle.signal])
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idle.abort(), this.idleTimeoutMs)
    }
    armIdle()
    try {
      const response = await this.fetchImpl(url, { signal, headers })
      if (!response.ok || !response.body) throw new Error(`http_${response.status}`)
      if (blockedMediaType(response)) {
        await response.body.cancel().catch(() => {})
        throw new Error('bad_mp4')
      }
      const expected = contentLength(response)
      progress?.total(expected)
      armIdle()
      const watchdog = new Transform({
        transform(chunk, _enc, cb) { armIdle(); progress?.bytes(chunk.length); cb(null, chunk) }
      })
      await pipeline(
        Readable.fromWeb(response.body as import('stream/web').ReadableStream, { signal }),
        watchdog,
        createWriteStream(target)
      )
      if (expected !== null && statSync(target).size !== expected) throw new Error('download_length_mismatch')
    } catch (err) {
      if (idle.signal.aborted && !aborter.signal.aborted) {
        throw new Error(`download_idle_timeout：${Math.round(this.idleTimeoutMs / 1000)} 秒没收到数据`)
      }
      throw err
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer)
    }
  }

  private async downloadSegment(
    url: string,
    range: ByteRange,
    total: number,
    headers: Record<string, string>,
    aborter: AbortController,
    group: AbortController,
    progress?: ProgressSink
  ): Promise<void> {
    const expected = range.end - range.start + 1
    const requestRange = `bytes=${range.start}-${range.end}`
    for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt++) {
      if (aborter.signal.aborted || group.signal.aborted) throw new Error('AbortError')
      rmSync(range.path, { force: true })
      let attemptBytes = 0
      const idle = new AbortController()
      const signal = AbortSignal.any([aborter.signal, group.signal, idle.signal])
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdle = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => idle.abort(), this.idleTimeoutMs)
      }
      armIdle()
      try {
        const response = await this.fetchImpl(url, { signal, headers: { ...headers, Range: requestRange } })
        if (blockedMediaType(response)) {
          await response.body?.cancel().catch(() => {})
          throw new Error('bad_mp4')
        }
        const parsed = parseContentRange(response.headers.get('content-range'))
        const declaredLength = contentLength(response)
        if (response.status !== 206 || !response.body || !parsed
          || parsed.start !== range.start || parsed.end !== range.end || parsed.total !== total
          || (declaredLength !== null && declaredLength !== expected)) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`segment_range_mismatch:${requestRange}`)
        }
        armIdle()
        const watchdog = new Transform({
          transform(chunk, _enc, cb) { armIdle(); attemptBytes += chunk.length; progress?.bytes(chunk.length); cb(null, chunk) }
        })
        await pipeline(
          Readable.fromWeb(response.body as import('stream/web').ReadableStream, { signal }),
          watchdog,
          createWriteStream(range.path)
        )
        if (statSync(range.path).size !== expected) throw new Error(`segment_length_mismatch:${requestRange}`)
        return
      } catch (err) {
        rmSync(range.path, { force: true })
        progress?.bytes(-attemptBytes) // 这一段作废重下，已经算进进度的字节退回去
        if (aborter.signal.aborted || group.signal.aborted) throw err
        const failure = idle.signal.aborted
          ? new Error(`download_idle_timeout：${Math.round(this.idleTimeoutMs / 1000)} 秒没收到数据`)
          : err
        if (attempt === SEGMENT_MAX_ATTEMPTS) throw failure
      } finally {
        if (idleTimer !== null) clearTimeout(idleTimer)
      }
    }
  }

  /** 返回 false 表示服务器不支持严格 Range，调用方应降级单连接。 */
  private async downloadSegmented(
    id: number,
    url: string,
    sourcePart: string,
    headers: Record<string, string>,
    aborter: AbortController,
    cleanupPaths: string[]
  ): Promise<boolean> {
    const configuredSegments = this.segmentCount()
    let session = this.segmentSessions.get(id)
    if (session && (session.url !== url || session.sourcePart !== sourcePart
      || session.configuredSegments !== configuredSegments)) {
      this.clearSegmentSession(id)
      session = undefined
    }
    if (!session) {
      const total = await this.probeRange(url, headers, aborter)
      if (total === null) return false
      session = {
        url, sourcePart, total, configuredSegments,
        ranges: splitRanges(total, configuredSegments, sourcePart)
      }
      this.segmentSessions.set(id, session)
    }
    for (const range of session.ranges) if (!cleanupPaths.includes(range.path)) cleanupPaths.push(range.path)

    const completed = new Set(this.completedSegmentPaths(id))
    const missing = session.ranges.filter(range => !completed.has(range.path))
    // 暂停前已经下完的段算进已收到的字节，继续后百分比从那里接着走
    const already = session.ranges.filter(range => completed.has(range.path)).reduce((n, r) => n + r.end - r.start + 1, 0)
    const progress = this.progressSink(id)
    progress.total(session.total, already)
    const group = new AbortController()
    const tasks = missing.map(range => this.downloadSegment(url, range, session!.total, headers, aborter, group, progress))
    try {
      await Promise.all(tasks)
    } catch (err) {
      group.abort()
      await Promise.allSettled(tasks)
      if (!aborter.signal.aborted) this.clearSegmentSession(id)
      throw err
    }
    if (aborter.signal.aborted) throw new Error('AbortError')

    try {
      const parts = session.ranges.map(range => range.path)
      const chunks = async function* (): AsyncGenerator<Buffer> {
        for (const path of parts) {
          for await (const chunk of createReadStream(path)) {
            if (aborter.signal.aborted) throw new Error('AbortError')
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          }
        }
      }
      await pipeline(Readable.from(chunks()), createWriteStream(sourcePart), { signal: aborter.signal })
      if (statSync(sourcePart).size !== session.total) throw new Error('download_length_mismatch')
      this.clearSegmentSession(id, false)
      for (const range of session.ranges) rmSync(range.path, { force: true })
      return true
    } catch (err) {
      rmSync(sourcePart, { force: true })
      if (!aborter.signal.aborted) this.clearSegmentSession(id)
      throw err
    }
  }

  /** AbortError 收尾：删除半成品；暂停发生在封面阶段时可保留已验证原片断点，继续后不重复请求视频。 */
  private finishAbort(id: number, status: VideoStatus, paths: string[], keepPath?: string, preservePaths: string[] = []): void {
    const preserved = new Set(preservePaths)
    for (const path of paths) {
      if (path === keepPath || preserved.has(path)) continue
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    }
    this.db.prepare("UPDATE videos SET status=?, error=NULL, local_path=?, original_path=NULL, normalization_error=NULL WHERE id=?")
      .run(status, keepPath ?? null, id)
    this.emit({ type: 'video:status', id, status })
  }

  private drain(): void {
    const concurrency = this.settings.downloadConcurrency || 3
    while (this.active < concurrency && this.queue.length > 0 && !this.paused) {
      const id = this.queue.shift()!
      void this.runOne(id).finally(() => {
        this.active--
        this.drain()
      })
      this.active++
    }
  }

  private async runOne(id: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined
    if (!row) return
    // 防御：已被取消的任务不再下载（回退窗口内 cancel 后定时器万一仍触发 enqueue 时兜底）
    if (row.status === 'cancelled') return
    // 防御：已单条暂停的任务不再下载（pauseVideo 后定时器/入队竞态兜底）
    if (row.status === 'paused') return
    // 每个在途任务一个 AbortController，cancel(ids) 用它掐断 fetch / pipeline 写盘
    const aborter = new AbortController()
    this.aborters.set(id, aborter)
    const cleanupPaths: string[] = []
    const reservedKeys: string[] = []
    let sourceValidated = false
    let sourcePart: string | null = null
    // 当前下载固定一个目录，设置热更新只影响下一条，避免封面与视频分离或覆盖旧封面。
    // R19：任务自己指定了下载文件夹（发布助手传的达人「暂存」）就下到那；临时文件也放那（跨盘 rename 会失败）
    const jobDir = ((this.db.prepare('SELECT output_dir FROM tasks WHERE id = ?').get(row.task_id) as
      { output_dir?: string | null } | undefined)?.output_dir || '').trim()
    const downloadDir = jobDir || this.settings.downloadDir
    try {
      const author = row.author_id
        ? (this.db.prepare('SELECT nickname FROM authors WHERE id = ?').get(row.author_id) as { nickname: string } | undefined)
        : undefined
      if (jobDir) mkdirSync(jobDir, { recursive: true })
      // 文件名只用标题（剥掉 #话题）；下到达人暂存的也一样，文件名就是发到百家号的标题
      const name = safeFilename(row.title, author?.nickname ?? 'unknown', row.aweme_id)
      // B1：选名后立即占住，另一条同名视频同时下载时会选 _1，不会两条写同一个文件
      const reserved = this.reserveStem(downloadDir, name)
      reservedKeys.push(reserved.key)
      let stem = reserved.stem
      let target = join(downloadDir, `${stem}.mp4`)
      sourcePart = join(downloadDir, `.video-${id}.download.part.mp4`)
      // 成品 target 不进清理列表：它在最后一步才由本条改名生成，失败/取消时盘上若有同名文件一定是别人的
      cleanupPaths.push(sourcePart)
      if (row.local_path !== sourcePart) rmSync(sourcePart, { force: true })
      this.removeStaleSegments(id, downloadDir, sourcePart)

      // 封面阶段暂停/重启后，数据库会指向已验证的源文件断点。恢复时先复验，合格则跳过网络请求。
      if (row.local_path === sourcePart && existsSync(sourcePart)) {
        const size = statSync(sourcePart).size
        const validContent = this.validator
          ? await this.validator(sourcePart)
          : (await isMp4(sourcePart)) && (await hasVideoStream(sourcePart))
        sourceValidated = size >= 1024 && validContent
        if (!sourceValidated) {
          rmSync(sourcePart, { force: true })
          this.db.prepare('UPDATE videos SET local_path=NULL WHERE id=?').run(id)
        }
      }

      // B2：地址旧了不再直接判过期（排队 / 暂停 / 重启都会超过 30 分钟，小红书地址实际能用好几天），
      // 先试着下；平台拒绝时再结合抓取时间判断是不是过期（见下方 catch）。

      this.db.prepare("UPDATE videos SET status = 'downloading' WHERE id = ?").run(id)
      this.emit({ type: 'video:status', id, status: 'downloading' })
      const headers = buildRequestHeaders(row.platform)

      if (!sourceValidated) {
        // 候选下载地址：原始地址优先；失败/坏文件则回退 playwm→play 无水印变体。
        const candidates = [row.play_addr]
        if (row.play_addr && row.play_addr.includes('playwm')) candidates.push(row.play_addr.replace('playwm', 'play'))
        let lastErr: unknown = new Error('bad_mp4')
        for (const url of candidates) {
          if (!url) continue
          rmSync(sourcePart, { force: true })
          try {
            const segmented = this.segmentCount() > 1
              ? await this.downloadSegmented(id, url, sourcePart, headers, aborter, cleanupPaths)
              : false
            if (!segmented) await this.downloadSingle(url, sourcePart, headers, aborter, this.progressSink(id))
          } catch (err) {
            if (aborter.signal.aborted) throw err
            lastErr = err
            rmSync(sourcePart, { force: true })
            this.clearSegmentSession(id)
            continue
          }
          const size = statSync(sourcePart).size
          const validContent = this.validator
            ? await this.validator(sourcePart)
            : (await isMp4(sourcePart)) && (await hasVideoStream(sourcePart))
          if (size >= 1024 && validContent) {
            sourceValidated = true
            lastErr = null
            break
          }
          rmSync(sourcePart, { force: true })
          this.clearSegmentSession(id)
          lastErr = new Error('bad_mp4')
        }
        if (lastErr) throw lastErr
        // 断点只在源文件完整且校验通过后写入，绝不记录半截下载。
        this.db.prepare('UPDATE videos SET local_path=?, original_path=NULL, normalization_error=NULL WHERE id=?')
          .run(sourcePart, id)
      }

      if (aborter.signal.aborted) throw new Error('AbortError')

      const coverPart = join(downloadDir, `${stem}.cover.part`)
      cleanupPaths.push(coverPart)
      // R19：下到达人暂存的不要封面（暂存里只放视频）
      const coverResult = row.cover_url && !jobDir
        ? await downloadCover({
            url: row.cover_url,
            dir: downloadDir,
            stem,
            fetchImpl: this.fetchImpl,
            // R20：封面最多下 60 秒；超时只是不要封面（下面 catch），取消/暂停照旧抛给外层处理
            signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(COVER_TIMEOUT_MS)]),
            headers
          }).catch((err: unknown) => {
            if (aborter.signal.aborted) throw err
            return null
          })
        : null
      let coverPath = coverResult
      if (coverPath) cleanupPaths.push(coverPath)
      else if (row.cover_url && !jobDir) console.warn(`[downloader] 封面下载失败，视频继续完成: id=${id}`)
      if (aborter.signal.aborted) throw new Error('AbortError')

      // 原视频直下：已验证的源文件原子改名为成品，尺寸/编码沿用平台元数据，下载器不主动改动。
      // original_path / normalization_error 留空——这两列只服务旧版转码流程的历史数据与「视频处理」页。
      // B1：改名前再看一眼——下载期间别的程序可能放了同名文件，Windows 上 rename 会静默覆盖它
      if (existsSync(target)) {
        const fresh = this.reserveStem(downloadDir, name)
        reservedKeys.push(fresh.key)
        stem = fresh.stem
        target = join(downloadDir, `${stem}.mp4`)
        if (coverPath) {
          const movedCover = join(downloadDir, `${stem}${extname(coverPath)}`)
          renameSync(coverPath, movedCover)
          coverPath = movedCover
          cleanupPaths.push(coverPath)
        }
      }
      renameSync(sourcePart, target)

      const size = statSync(target).size
      const downloadedAt = new Date().toISOString()
      this.db.prepare("UPDATE videos SET status='done', local_path=?, original_path=NULL, normalization_error=NULL, cover_path=?, video_width=?, video_height=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
        .run(target, coverPath, row.video_width, row.video_height, size, downloadedAt, id)
      this.emit({ type: 'video:status', id, status: 'done', localPath: target })
    } catch (err) {
      // 取消分支（signal 已 abort，真实 AbortError 是 DOMException、非 Error，用 signal.aborted 判）：
      // 删半成品、跳过网络重试；状态路由三分支——单条暂停 → paused、全局暂停 → pending 重新入队、
      // 用户取消（或中断后被 cancel 抢先）→ cancelled。在途的 db 状态 cancel() 已写过 cancelled，这里只兜底、绝不覆盖成 failed
      if (aborter.signal.aborted) {
        // 原因快照优先（读后删）：abort 回调可能延迟到 paused/pausedIds 被 resume 清掉之后才落定，
        // 以 abort 时刻写入的原因路由，避免把"已恢复"的项误标成 cancelled
        const reason = this.abortReasons.get(id)
        this.abortReasons.delete(id)
        const cur = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
        const checkpoint = sourceValidated && sourcePart && existsSync(sourcePart) ? sourcePart : undefined
        const segmentCheckpoints = checkpoint ? [] : this.completedSegmentPaths(id)
        if (reason === 'paused') {
          if (this.pausedIds.has(id)) {
            // 单条暂停（全局继续未发生过）：标 paused，继续后手动恢复
            this.finishAbort(id, 'paused', cleanupPaths, checkpoint, segmentCheckpoints)
          } else if (cur?.status !== 'cancelled') {
            // 全局暂停（回调时无论是否已 resume）：标回 pending 重新入队，drain 自然续下；
            // 已取消项不再覆盖为 pending 重排
            this.finishAbort(id, 'pending', cleanupPaths, checkpoint, segmentCheckpoints)
            this.queue.push(id)
          } else {
            this.finishAbort(id, 'cancelled', cleanupPaths)
            this.clearSegmentSession(id)
          }
        } else if (reason === 'cancelled') {
          this.finishAbort(id, 'cancelled', cleanupPaths)
          this.clearSegmentSession(id)
        } else {
          // 无快照（兜底）：按当下状态判断——单条暂停 / 全局暂停 / 用户取消
          if (this.pausedIds.has(id)) {
            this.finishAbort(id, 'paused', cleanupPaths, checkpoint, segmentCheckpoints)
          } else if (this.paused && cur?.status !== 'cancelled') {
            this.finishAbort(id, 'pending', cleanupPaths, checkpoint, segmentCheckpoints)
            this.queue.push(id)
          } else {
            this.finishAbort(id, 'cancelled', cleanupPaths)
            this.clearSegmentSession(id)
          }
        }
        return
      }
      const retry = row.retry_count + 1
      let code = classifyDownloadError(err)
      // B2：平台拒绝（403/404/410）且地址已超过设置的时效 → 多半是链接过期，重新爬一次就能拿到新地址
      if (/^http_(403|404|410)$/.test(err instanceof Error ? err.message : '')
        && new AddressPolicy(this.settings.addressTtlMin).isExpired(row.fetched_at)) code = ERROR.ADDRESS_EXPIRED
      this.clearSegmentSession(id)
      for (const path of cleanupPaths) try { rmSync(path, { force: true }) } catch { /* ignore */ }
      // 网络类错误自动重试2次（利用 retry_count）；磁盘(ENOENT/EPERM/ENOSPC)/风控等非网络错误直接失败
      if (retry <= 2 && code === ERROR.NETWORK) {
        this.db.prepare("UPDATE videos SET status='pending', retry_count=?, error=NULL, local_path=NULL, original_path=NULL, normalization_error=NULL WHERE id=?").run(retry, id)
        // 回退定时器入 map，cancel(ids) 可 clearTimeout 防止已取消项被重新下载
        const t = setTimeout(() => { this.retryTimers.delete(id); this.enqueue(id) }, 5000)
        this.retryTimers.set(id, t)
      } else {
        this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=?, local_path=NULL, original_path=NULL, normalization_error=NULL WHERE id=?").run(code, retry, id)
      }
      this.emit({ type: 'video:status', id, status: 'failed', error: code })
    } finally {
      this.meters.delete(id)
      for (const key of reservedKeys) this.reservedStems.delete(key)
      this.aborters.delete(id)
      this.abortReasons.delete(id) // 兜底清理：若下载在 abort 前已完成（catch 未走），不留陈旧快照
      delete this.fetching[id]
    }
  }
}

/** 校验文件头含 MP4 的 ftyp box（前 16 字节） */
async function isMp4(file: string): Promise<boolean> {
  const fs = await import('fs')
  try {
    const fh = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(16)
      fs.readSync(fh, buf, 0, 16, 0)
      return buf.includes(Buffer.from('ftyp'))
    } finally {
      fs.closeSync(fh)
    }
  } catch { return false }
}

/** 在常见路径/PATH 里找 ffprobe（各盘符 /123 下的 ffmpeg 目录的 bin 里） */
function findFfprobe(): string | null {
  return findBin('ffprobe')
}

/** 用 ffprobe 确认文件含视频轨（纯音频/损坏文件→黑屏）。找不到 ffprobe 时跳过校验（兜底放行）。 */
function hasVideoStream(file: string): Promise<boolean> {
  const fp = findFfprobe()
  if (!fp) return Promise.resolve(true)
  return new Promise(resolve => {
    // R20：最多跑 30 秒（execFile 超时会杀掉进程并回调 err），不让这条下载永远挂着
    execFile(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { timeout: FFPROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        // 超时被杀（killed）不说明文件坏了——和「找不到 ffprobe」一样放行（前面已校验过 MP4 文件头）
        if (err && (err as { killed?: boolean }).killed) {
          console.warn(`[downloader] ffprobe ${FFPROBE_TIMEOUT_MS / 1000} 秒没跑完，跳过视频轨校验: ${file}`)
          resolve(true)
          return
        }
        resolve(!err && /video/i.test(String(stdout)))
      })
  })
}
