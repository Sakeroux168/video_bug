import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { rename } from 'fs/promises'
import { join, basename, dirname, resolve, extname } from 'path'
import type { AuthorRow, VideoRow } from '../shared/types'
import { listAuthorVideos, setAuthorOrganizeState } from './db'
import { ensureUniqueStem } from './filename'
import { probeVideoDimensions, screenBucket, type VideoDimensions } from './videoMeta'

/** 分类名清洗为合法目录名（Windows 非法字符替换，限长 32，空回落"未分类"）——与 scheduler 现有逻辑一致 */
export function sanitizeCategory(category: string): string {
  const cleaned = category.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 32)
  return cleaned || '未分类'
}

/** 时长分桶目录名：≤60s 归「一分钟内」，>60s 归「一分钟外」（videos.duration 单位秒，60s 整为界） */
export function durBucket(duration: number): string {
  return duration <= 60 ? '一分钟内' : '一分钟外'
}

/** 作者昵称清洗为合法目录名（限长 64，空回落"作者"） */
export function sanitizeDirName(nickname: string): string {
  const cleaned = nickname.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 64)
  return cleaned || '作者'
}

/** 作者目录名：清洗昵称；若 authors 表存在**另一个**作者（不同 sec_uid）清洗后同名，则追加 `_${sec_uid.slice(-6)}` 区分 */
export function authorDirName(author: { nickname: string; sec_uid: string }, db: DatabaseSync): string {
  const cleaned = sanitizeDirName(author.nickname)
  const others = db.prepare('SELECT nickname FROM authors WHERE sec_uid != ?').all(author.sec_uid) as unknown as Array<{ nickname: string }>
  const clash = others.some(r => sanitizeDirName(r.nickname) === cleaned)
  return clash ? `${cleaned}_${author.sec_uid.slice(-6)}` : cleaned
}

/** 品类解析函数：入参为作者行与已下载视频样本，返回品类名；null/抛错由调用方回退「未分类」 */
export type ResolveCategoryFn = (author: AuthorRow, samples: VideoRow[]) => Promise<string | null>

export interface OrganizeResult {
  moved: number
  category: string
  state: 'done' | 'failed'
}

export interface OrganizerDeps {
  db: DatabaseSync
  downloadDir: string
  resolveCategory: ResolveCategoryFn
  /** 元数据缺失时探测本地文件；注入点用于不依赖本机工具的测试。 */
  probeDimensions?: (file: string) => Promise<VideoDimensions | null>
  /** 每归档完一个作者回调一次，供上层汇报进度 */
  onProgress?: (info: { authorId: number; authorName: string; moved: number; category: string; state: 'done' | 'failed' }) => void
}

/** 按作者归档：平铺视频与封面 → 品类/作者/方向/时长，同主体名称成对移动。 */
export class Organizer {
  constructor(private deps: OrganizerDeps) {}

  /** 是否仍平铺在下载目录根（尚未归档进 {品类}/{作者} 子目录） */
  private isFlat(v: VideoRow): boolean {
    return !!v.local_path && dirname(resolve(v.local_path)) === resolve(this.deps.downloadDir)
  }

  /** 下载完成事件调用：该作者存在 ≥1 条 done 且仍平铺在下载目录根的视频时才置 'pending'。
   *  用视频状态佐证，不因 organize_state='done' 永久挡死 —— 分批下载时上一批归档后作者为 done，
   *  新下载完成的视频仍会把它再次置 pending 供归档。 */
  markAuthorPending(authorId: number): void {
    const hasFlatDone = listAuthorVideos(this.deps.db, authorId, 'done').some(v => this.isFlat(v))
    if (hasFlatDone) setAuthorOrganizeState(this.deps.db, authorId, 'pending')
  }

  /** 归档单个作者的 done 视频：品类解析失败归「未分类」但不算归档失败；仅"移动文件失败"记 failed */
  async organizeAuthor(authorId: number): Promise<OrganizeResult> {
    const db = this.deps.db
    const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(authorId) as AuthorRow | undefined
    if (!author) return { moved: 0, category: '未分类', state: 'failed' }

    // 只归档仍平铺在下载目录根（未归档）的 done 视频；已在 {品类}/{作者}/{时长分桶} 子目录里的跳过，保证重复整理幂等、分批安全
    const videos = listAuthorVideos(db, authorId, 'done').filter(v => this.isFlat(v))
    if (!videos.length) {
      // 没有待归档的平铺视频：作者已全部归档或本就无 done → 标记完成，不算失败
      setAuthorOrganizeState(db, authorId, 'done')
      this.deps.onProgress?.({ authorId, authorName: author.nickname, moved: 0, category: '未分类', state: 'done' })
      return { moved: 0, category: '未分类', state: 'done' }
    }

    // 解析品类：AI 失败（返回 null 或抛错）→ 回退「未分类」，但不视为归档失败（文件照常移动）
    let category: string
    try {
      const c = await this.deps.resolveCategory(author, videos)
      category = c ? sanitizeCategory(c) : '未分类'
    } catch {
      category = '未分类'
    }

    // 作者目录名（重名后缀在昵称层）+ 时长分桶（每条视频各自进桶，目标目录逐条 mkdir）
    const authorDir = authorDirName(author, db)
    let moved = 0
    let failedMoves = 0
    for (const v of videos) {
      if (!v.local_path) continue
      try {
        let width = v.video_width
        let height = v.video_height
        if (screenBucket(width, height) === '未识别') {
          try {
            const dimensions = await (this.deps.probeDimensions ?? probeVideoDimensions)(v.local_path)
            if (dimensions && screenBucket(dimensions.width, dimensions.height) !== '未识别') {
              width = dimensions.width
              height = dimensions.height
            }
          } catch { /* 探测失败不影响归档，进入未识别目录 */ }
        }
        const destDir = join(this.deps.downloadDir, category, authorDir, screenBucket(width, height), durBucket(v.duration))
        mkdirSync(destDir, { recursive: true })
        const videoExt = extname(v.local_path)
        const coverExt = v.cover_path ? extname(v.cover_path) : '.jpg'
        const stem = ensureUniqueStem(destDir, basename(v.local_path, videoExt), [videoExt, '.jpg', '.jpeg', '.png', '.webp', coverExt])
        const destVideo = join(destDir, `${stem}${videoExt}`)
        const destCover = v.cover_path ? join(destDir, `${stem}${coverExt}`) : null
        await rename(v.local_path, destVideo)
        let coverMoved = false
        try {
          if (v.cover_path && destCover) {
            await rename(v.cover_path, destCover)
            coverMoved = true
          }
          db.exec('BEGIN')
          try {
            db.prepare('UPDATE videos SET local_path=?, cover_path=?, video_width=?, video_height=? WHERE id=?')
              .run(destVideo, destCover, width, height, v.id)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        } catch (error) {
          if (coverMoved && destCover && v.cover_path) await rename(destCover, v.cover_path).catch(() => undefined)
          await rename(destVideo, v.local_path).catch(() => undefined)
          throw error
        }
        moved++
      } catch {
        failedMoves++ // 源文件缺失/权限等 → 单条失败，整作者记 failed
      }
    }

    const state = failedMoves > 0 ? 'failed' : 'done'
    setAuthorOrganizeState(db, authorId, state)
    this.deps.onProgress?.({ authorId, authorName: author.nickname, moved, category, state })
    return { moved, category, state }
  }

  /** 处理所有 organize_state='pending' 的作者，返回处理的作者数 */
  async organizePending(): Promise<number> {
    const rows = this.deps.db.prepare("SELECT id FROM authors WHERE organize_state = 'pending'").all() as unknown as Array<{ id: number }>
    for (const r of rows) await this.organizeAuthor(r.id)
    return rows.length
  }

  /** 处理所有有 done 视频且未归档（organize_state 非 'done'）的作者，返回处理的作者数 */
  async organizeAll(): Promise<number> {
    const rows = this.deps.db.prepare(
      `SELECT DISTINCT a.id FROM authors a
       JOIN videos v ON v.author_id = a.id AND v.status = 'done'
       WHERE a.organize_state IS NULL OR a.organize_state != 'done'`
    ).all() as unknown as Array<{ id: number }>
    for (const r of rows) await this.organizeAuthor(r.id)
    return rows.length
  }
}
