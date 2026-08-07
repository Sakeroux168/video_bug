import type { DatabaseSync } from 'node:sqlite'
import { createWriteStream, mkdirSync, readdirSync, existsSync, rmSync } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { join } from 'path'
import { execFile } from 'child_process'
import { findBin } from './ffbin'
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
      // 只对"可取消"态生效：pending(排队/等待/重试回退)/downloading(在途)/collected(手动模式未下载)
      if (row.status !== 'pending' && row.status !== 'downloading' && row.status !== 'collected') continue
      // 5s 网络重试回退窗口内取消：清定时器，防止 5s 后被重新入队下载
      const timer = this.retryTimers.get(id)
      if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
      const aborter = this.aborters.get(id)
      if (aborter) { this.abortReasons.set(id, 'cancelled'); aborter.abort() } // 在途：先快照原因再掐断 fetch/写盘
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

  /** AbortError 收尾：删半成品 + 标状态（error 清空）+ 发事件 */
  private finishAbort(id: number, status: VideoStatus, dest: string | null): void {
    if (dest) try { rmSync(dest, { force: true }) } catch { /* ignore */ }
    this.db.prepare("UPDATE videos SET status=?, error=NULL WHERE id=?").run(status, id)
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
      // 校验阶段（statSync/isMp4/ffprobe/validator）不感知 abort：若删除/取消发生在该窗口，
      // 文件已完整落盘但 runOne 会继续提交 done → 行已删时留孤儿 mp4。提交 done 前再查一次信号，
      // 已 abort 则抛错走既有 aborted 收尾（rmSync 半成品 + 标 cancelled + 清 fetching）。
      if (aborter.signal.aborted) throw new Error('AbortError')
      const downloadedAt = new Date().toISOString()
      this.db.prepare("UPDATE videos SET status='done', local_path=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
        .run(target, size, downloadedAt, id)
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
        if (reason === 'paused') {
          if (this.pausedIds.has(id)) {
            // 单条暂停（全局继续未发生过）：标 paused，继续后手动恢复
            this.finishAbort(id, 'paused', dest)
          } else if (cur?.status !== 'cancelled') {
            // 全局暂停（回调时无论是否已 resume）：标回 pending 重新入队，drain 自然续下；
            // 已取消项不再覆盖为 pending 重排
            this.finishAbort(id, 'pending', dest)
            this.queue.push(id)
          } else {
            this.finishAbort(id, 'cancelled', dest)
          }
        } else if (reason === 'cancelled') {
          this.finishAbort(id, 'cancelled', dest)
        } else {
          // 无快照（兜底）：按当下状态判断——单条暂停 / 全局暂停 / 用户取消
          if (this.pausedIds.has(id)) {
            this.finishAbort(id, 'paused', dest)
          } else if (this.paused && cur?.status !== 'cancelled') {
            this.finishAbort(id, 'pending', dest)
            this.queue.push(id)
          } else {
            this.finishAbort(id, 'cancelled', dest)
          }
        }
        return
      }
      const retry = row.retry_count + 1
      const code = classifyDownloadError(err)
      // 网络类错误自动重试2次（利用 retry_count）；磁盘(ENOENT/EPERM/ENOSPC)/风控等非网络错误直接失败
      if (retry <= 2 && code === ERROR.NETWORK) {
        this.db.prepare("UPDATE videos SET status='pending', retry_count=?, error=NULL WHERE id=?").run(retry, id)
        // 回退定时器入 map，cancel(ids) 可 clearTimeout 防止已取消项被重新下载
        const t = setTimeout(() => { this.retryTimers.delete(id); this.enqueue(id) }, 5000)
        this.retryTimers.set(id, t)
      } else {
        this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=? WHERE id=?").run(code, retry, id)
      }
      this.emit({ type: 'video:status', id, status: 'failed', error: code })
    } finally {
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
    execFile(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], (err, stdout) => {
      resolve(!err && /video/i.test(stdout))
    })
  })
}
