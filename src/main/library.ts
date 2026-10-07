import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { LibraryQuery, LibraryRow, VideoMark } from '../shared/types'

/**
 * 素材库（2026-10-07 功能 E / N07 / N08）：按数据库列出下载完成的视频，筛选、排序、标记。
 * 和「文件管理」的区别：文件管理看磁盘目录树，拿不到点赞、作者、关键词；素材库直接查库，这些都有。
 */

const MARKS: readonly VideoMark[] = ['star', 'todo', 'used']
const DEFAULT_PAGE_SIZE = 60
const MAX_PAGE_SIZE = 200

/** LIKE 通配符按字面匹配 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, m => `\\${m}`)
}

export function listLibrary(db: DatabaseSync, q: LibraryQuery): { rows: LibraryRow[]; total: number } {
  const where = ["v.status = 'done'", 'v.local_path IS NOT NULL']
  const args: SQLInputValue[] = []
  if (q.platform) { where.push('v.platform = ?'); args.push(q.platform) }
  if (typeof q.taskId === 'number' && Number.isInteger(q.taskId)) { where.push('v.task_id = ?'); args.push(q.taskId) }
  if (q.mark === 'none') where.push('v.mark IS NULL')
  else if (q.mark && MARKS.includes(q.mark)) { where.push('v.mark = ?'); args.push(q.mark) }
  const search = (q.search ?? '').trim()
  if (search) {
    const like = `%${likeEscape(search)}%`
    where.push("(v.title LIKE ? ESCAPE '\\' OR a.nickname LIKE ? ESCAPE '\\' OR v.note LIKE ? ESCAPE '\\')")
    args.push(like, like, like)
  }
  // 不知道点赞 / 收藏的排在最后
  const order = {
    downloaded: 'v.downloaded_at DESC, v.id DESC',
    likes: "json_extract(v.stats, '$.likes') IS NULL, json_extract(v.stats, '$.likes') DESC, v.id DESC",
    collects: "json_extract(v.stats, '$.collects') IS NULL, json_extract(v.stats, '$.collects') DESC, v.id DESC",
    published: 'v.publish_time DESC, v.id DESC'
  }[q.sort ?? 'downloaded'] ?? 'v.downloaded_at DESC, v.id DESC'
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? DEFAULT_PAGE_SIZE)))
  const page = Math.max(1, Math.floor(q.page ?? 1))
  const from = `FROM videos v LEFT JOIN authors a ON a.id = v.author_id LEFT JOIN tasks t ON t.id = v.task_id WHERE ${where.join(' AND ')}`
  const total = (db.prepare(`SELECT COUNT(*) c ${from}`).get(...args) as { c: number }).c
  const rows = db.prepare(`SELECT v.*, a.nickname AS author_nickname, t.query AS task_query ${from} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as unknown as LibraryRow[]
  return { rows, total }
}

/** 「关键词 / 任务」下拉：只列有下载完成视频的任务 */
export function listLibraryTasks(db: DatabaseSync): Array<{ id: number; platform: string; type: string; query: string; count: number }> {
  return db.prepare(`SELECT t.id, t.platform, t.type, t.query, COUNT(v.id) count
    FROM tasks t JOIN videos v ON v.task_id = t.id AND v.status = 'done'
    GROUP BY t.id ORDER BY t.id DESC`).all() as unknown as Array<{ id: number; platform: string; type: string; query: string; count: number }>
}

/** 批量打标记；null = 清掉。只认三种标记，别的值直接报错（不写进库） */
export function setVideoMark(db: DatabaseSync, ids: number[], mark: VideoMark | null): void {
  if (mark !== null && !MARKS.includes(mark)) throw new Error(`bad mark: ${String(mark)}`)
  const clean = ids.filter(id => Number.isInteger(id))
  if (clean.length === 0) return
  db.prepare(`UPDATE videos SET mark = ? WHERE id IN (${clean.map(() => '?').join(',')})`).run(mark, ...clean)
}

/** 备注：去掉首尾空白，空了就清掉；最多 500 字 */
export function setVideoNote(db: DatabaseSync, id: number, note: string): void {
  const text = String(note ?? '').trim().slice(0, 500)
  db.prepare('UPDATE videos SET note = ? WHERE id = ?').run(text || null, id)
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/**
 * 素材库封面（vs-cover:// 协议用）：只按视频 id 从库里取路径，界面不能传任意路径进来；
 * 文件要在、要是图片，否则 null。
 */
export function coverFileFor(db: DatabaseSync, id: number): string | null {
  const row = db.prepare('SELECT cover_path FROM videos WHERE id = ?').get(id) as { cover_path: string | null } | undefined
  const p = row?.cover_path
  if (!p || !IMAGE_EXT.has(extname(p).toLowerCase())) return null
  try { return statSync(p).isFile() ? p : null } catch { return null }
}

/** 素材库「播放」：同样只按 id 取下载完成的 mp4 */
export function videoFileFor(db: DatabaseSync, id: number): string | null {
  const row = db.prepare("SELECT local_path FROM videos WHERE id = ? AND status = 'done'").get(id) as { local_path: string | null } | undefined
  const p = row?.local_path
  if (!p || extname(p).toLowerCase() !== '.mp4' || !existsSync(p)) return null
  return p
}
