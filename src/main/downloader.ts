import type { DatabaseSync } from 'node:sqlite'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { join } from 'path'
import type { AppSettings, VideoRow } from '../shared/types'
import { ERROR } from '../shared/types'
import { classifyHttpError, AddressPolicy } from './errors'
import { safeFilename, ensureUniqueName } from './filename'

export function buildUserAgent(_platform: string): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
}

type DlSettings = Pick<AppSettings, 'downloadDir' | 'downloadConcurrency' | 'addressTtlMin'>
type DlEvent =
  | { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }

export class Downloader {
  private queue: number[] = []
  private active = 0
  private listeners: Array<(e: DlEvent) => void> = []
  private fetching: Record<number, boolean> = {}

  constructor(
    private db: DatabaseSync,
    private settings: DlSettings,
    private fetchImpl: typeof fetch = fetch
  ) {}

  onEvent(cb: (e: DlEvent) => void): void { this.listeners.push(cb) }

  enqueue(id: number): void {
    if (this.fetching[id]) return
    this.fetching[id] = true
    this.queue.push(id)
    this.drain()
  }

  start(): void { this.drain() }

  isIdle(): boolean { return this.active === 0 && this.queue.length === 0 }

  private emit(e: DlEvent): void { for (const l of this.listeners) l(e) }

  private drain(): void {
    const concurrency = this.settings.downloadConcurrency || 3
    while (this.active < concurrency && this.queue.length > 0) {
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
      const dest = join(this.settings.downloadDir, finalName)

      const res = await this.fetchImpl(row.play_addr!, {
        headers: { 'user-agent': buildUserAgent(row.platform), referer: `https://www.${row.platform}.com/` }
      })
      if (!res.ok || !res.body) throw new Error(`http_${res.status}`)
      // Response.body 是 Web ReadableStream，不是 Node 流，需经 Readable.fromWeb 转成 Node Readable
      await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(dest))

      const size = await import('fs').then(m => m.statSync(dest).size)
      const downloadedAt = new Date().toISOString()
      this.db.prepare("UPDATE videos SET status='done', local_path=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
        .run(dest, size, downloadedAt, id)
      this.emit({ type: 'video:status', id, status: 'done', localPath: dest })
    } catch (err) {
      const retry = row.retry_count + 1
      const code = classifyHttpError((err as { message?: string }).message?.startsWith('http_') ? Number((err as { message: string }).message.slice(5)) : 0) || ERROR.NETWORK
      // 网络类错误自动重试2次（利用 retry_count）；非网络错误直接失败
      if (retry <= 2 && code === ERROR.NETWORK) {
        this.db.prepare("UPDATE videos SET status='pending', retry_count=?, error=NULL WHERE id=?").run(retry, id)
        setTimeout(() => this.enqueue(id), 5000)
      } else {
        this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=? WHERE id=?").run(code, retry, id)
      }
      this.emit({ type: 'video:status', id, status: 'failed', error: code })
    } finally {
      delete this.fetching[id]
    }
  }
}
