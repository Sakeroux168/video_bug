import type { DatabaseSync } from 'node:sqlite'
import { createWriteStream, mkdirSync, readdirSync, existsSync, rmSync } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { join } from 'path'
import { execFile, spawnSync } from 'child_process'
import type { AppSettings, VideoRow, VideoStatus } from '../shared/types'
import { ERROR } from '../shared/types'
import { classifyDownloadError, AddressPolicy } from './errors'
import { safeFilename, ensureUniqueName } from './filename'
import { setVideoStatus } from './db'

export function buildUserAgent(_platform: string): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
}

type DlSettings = Pick<AppSettings, 'downloadDir' | 'downloadConcurrency' | 'addressTtlMin'>
type DlEvent =
  | { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }

export class Downloader {
  private queue: number[] = []
  private active = 0
  private paused = false
  private aborters = new Map<number, AbortController>()
  private listeners: Array<(e: DlEvent) => void> = []
  private fetching: Record<number, boolean> = {}
  private validator: ((file: string) => Promise<boolean>) | null

  constructor(
    private db: DatabaseSync,
    private settings: DlSettings,
    private fetchImpl: typeof fetch = fetch,
    opts?: { validator?: (file: string) => Promise<boolean> }
  ) {
    // C1: 确保下载目录存在（recursive 幂等）；目录不可写时由下载错误分类兜底为 ERROR.DISK
    try { mkdirSync(this.settings.downloadDir, { recursive: true }) } catch { /* ignore */ }
    this.validator = opts?.validator ?? null
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

  /** 暂停：drain 不再拉取新任务，在途任务继续跑完 */
  pause(): void { this.paused = true }

  /** 恢复：清暂停标记并立刻补拉排队任务 */
  resume(): void { this.paused = false; this.drain() }

  isPaused(): boolean { return this.paused }

  /** 取消：在途 abort、排队项移出队列、状态标 cancelled；对已结束(done/failed)的 id 幂等无副作用 */
  cancel(ids: number[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT status FROM videos WHERE id = ?').get(id) as { status: VideoStatus } | undefined
      if (!row) continue
      // 只对"可取消"态生效：pending(排队/等待)/downloading(在途)/collected(手动模式未下载)
      if (row.status !== 'pending' && row.status !== 'downloading' && row.status !== 'collected') continue
      const aborter = this.aborters.get(id)
      if (aborter) aborter.abort() // 在途：掐断 fetch/写盘
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
    // 每个在途任务一个 AbortController，cancel(ids) 用它掐断 fetch / pipeline 写盘
    const aborter = new AbortController()
    this.aborters.set(id, aborter)
    let dest: string | null = null
    try {
      // 下载前判地址过期：源地址超过 TTL 视为失效，直接标失败，不浪费请求
      const policy = new AddressPolicy(this.settings.addressTtlMin)
      if (policy.isExpired(row.fetched_at)) {
        this.db.prepare("UPDATE videos SET status='failed', error=? WHERE id=?").run(ERROR.ADDRESS_EXPIRED, id)
        this.emit({ type: 'video:status', id, status: 'failed', error: ERROR.ADDRESS_EXPIRED })
        return
      }
      this.db.prepare("UPDATE videos SET status = 'downloading' WHERE id = ?").run(id)
      this.emit({ type: 'video:status', id, status: 'downloading' })

      const author = row.author_id
        ? (this.db.prepare('SELECT nickname FROM authors WHERE id = ?').get(row.author_id) as { nickname: string } | undefined)
        : undefined
      const name = safeFilename(row.title, author?.nickname ?? 'unknown', row.aweme_id)
      const finalName = ensureUniqueName(this.settings.downloadDir, `${name}.mp4`)
      const target = join(this.settings.downloadDir, finalName)
      dest = target // 供取消分支删半成品

      // 候选下载地址：原始地址优先（网页播放器即用，通常无水印）；失败/坏文件则回退 playwm→play 无水印变体
      const candidates = [row.play_addr]
      if (row.play_addr && row.play_addr.includes('playwm')) candidates.push(row.play_addr.replace('playwm', 'play'))
      let size = 0
      let lastErr: unknown = new Error('bad_mp4')
      for (const url of candidates) {
        const res = await this.fetchImpl(url!, {
          signal: aborter.signal,
          headers: { 'user-agent': buildUserAgent(row.platform), referer: `https://www.${row.platform}.com/` }
        })
        if (!res.ok || !res.body) { lastErr = new Error(`http_${res.status}`); continue }
        // Response.body 是 Web ReadableStream，不是 Node 流，需经 Readable.fromWeb 转成 Node Readable；
        // 挂上 signal：cancel 时可掐断写盘（pipeline 抛 AbortError）
        await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream, { signal: aborter.signal }), createWriteStream(target))
        size = await import('fs').then(m => m.statSync(target).size)
        // 校验是否真是带视频轨的 MP4：避免把 CDN 错误页/空文件/纯音频当视频（黑屏源头）
        const validContent = this.validator
          ? await this.validator(target)
          : (await isMp4(target)) && (await hasVideoStream(target))
        if (size >= 1024 && validContent) { lastErr = null; break }
        await import('fs').then(m => m.rmSync(target, { force: true }))
        lastErr = new Error('bad_mp4')
      }
      if (lastErr) throw lastErr
      const downloadedAt = new Date().toISOString()
      this.db.prepare("UPDATE videos SET status='done', local_path=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
        .run(target, size, downloadedAt, id)
      this.emit({ type: 'video:status', id, status: 'done', localPath: target })
    } catch (err) {
      // 取消分支（AbortError / signal 已 abort）：删半成品、标 cancelled、跳过网络重试；
      // 在途的 db 状态 cancel() 已写过 cancelled，这里只兜底、绝不覆盖成 failed
      if ((err instanceof Error && err.name === 'AbortError') || aborter.signal.aborted) {
        if (dest) try { rmSync(dest, { force: true }) } catch { /* ignore */ }
        this.db.prepare("UPDATE videos SET status='cancelled', error=NULL WHERE id=?").run(id)
        return
      }
      const retry = row.retry_count + 1
      const code = classifyDownloadError(err)
      // 网络类错误自动重试2次（利用 retry_count）；磁盘(ENOENT/EPERM/ENOSPC)/风控等非网络错误直接失败
      if (retry <= 2 && code === ERROR.NETWORK) {
        this.db.prepare("UPDATE videos SET status='pending', retry_count=?, error=NULL WHERE id=?").run(retry, id)
        setTimeout(() => this.enqueue(id), 5000)
      } else {
        this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=? WHERE id=?").run(code, retry, id)
      }
      this.emit({ type: 'video:status', id, status: 'failed', error: code })
    } finally {
      this.aborters.delete(id)
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

let ffprobePath: string | null | undefined
/** 在常见路径/PATH 里找 ffprobe（本机装在 F:/123 下的 ffmpeg 目录的 bin 里） */
function findFfprobe(): string | null {
  if (ffprobePath !== undefined) return ffprobePath
  try {
    for (const d of readdirSync('F:/123', { withFileTypes: true })) {
      if (!d.isDirectory() || !/^ffmpeg/i.test(d.name)) continue
      const p = `F:/123/${d.name}/bin/ffprobe.exe`
      if (existsSync(p)) { ffprobePath = p; return p }
    }
  } catch { /* F 盘不存在等 */ }
  try {
    const r = spawnSync('where', ['ffprobe'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout) { ffprobePath = r.stdout.trim().split('\n')[0]; return ffprobePath }
  } catch { /* ignore */ }
  ffprobePath = null
  return null
}

/** 用 ffprobe 确认文件含视频轨（纯音频/损坏文件→黑屏）。找不到 ffprobe 时跳过校验（兜底放行）。 */
function hasVideoStream(file: string): Promise<boolean> {
  const fp = findFfprobe()
  if (!fp) return Promise.resolve(true)
  return new Promise(resolve => {
    execFile(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], (err, stdout) => {
      resolve(!err && /video/i.test(stdout))
    })
  })
}
