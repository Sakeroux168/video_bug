import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { sep } from 'path'
import type { CreateTaskInput, TaskRow, TaskStatus, VideoRow, AuthorRow, VideoStatus } from '../shared/types'
import type { VideoItem } from './adapters/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  type TEXT NOT NULL,
  query TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  target_count INTEGER NOT NULL DEFAULT 200,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  auto_download INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  sec_uid TEXT NOT NULL,
  nickname TEXT NOT NULL,
  home_url TEXT,
  video_count INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT,
  note TEXT,
  category TEXT,
  organize_state TEXT,
  ai_classified_at TEXT,
  UNIQUE(platform, sec_uid)
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  task_id INTEGER NOT NULL,
  aweme_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author_id INTEGER,
  play_addr TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  publish_time TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  ai_verdict TEXT,
  ai_tags TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  local_path TEXT,
  file_size INTEGER,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  downloaded_at TEXT,
  UNIQUE(platform, aweme_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_task ON videos(task_id);
CREATE TABLE IF NOT EXISTS transcripts (
  content_hash TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  speech_sec REAL NOT NULL DEFAULT 0,
  total_sec REAL NOT NULL DEFAULT 0,
  engine TEXT,
  created_at TEXT
);
`

export function initDb(db: DatabaseSync): void {
  db.exec(SCHEMA)
  // 迁移：老库缺列则 PRAGMA table_info 判缺后 ALTER TABLE 补列（#6 category、Task1 auto_download/organize_state/ai_classified_at）
  addColumnIfMissing(db, 'authors', 'category', 'TEXT')
  addColumnIfMissing(db, 'tasks', 'auto_download', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(db, 'authors', 'organize_state', 'TEXT')
  addColumnIfMissing(db, 'authors', 'ai_classified_at', 'TEXT')
}

/** 老库迁移：表缺列时补列（ALTER TABLE ADD COLUMN 不能带 NOT NULL 无默认值的约束，故用 DEFAULT） */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function createTask(db: DatabaseSync, input: CreateTaskInput): number {
  const info = db.prepare(
    `INSERT INTO tasks (platform, type, query, filters, target_count, auto_download, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.platform, input.type, input.query,
    JSON.stringify({ ...input.filters, aiFilterEnabled: input.aiFilterEnabled, aiOrganizeEnabled: input.aiOrganizeEnabled }),
    input.filters.targetCount, Number(input.autoDownload ?? true), new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function updateTask(db: DatabaseSync, id: number, patch: Partial<TaskRow>): void {
  const allowed = ['status', 'filters', 'fetched_count', 'error', 'finished_at'] as const
  const sets: string[] = []
  const vals: unknown[] = []
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]) }
  }
  if (!sets.length) return
  vals.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as SQLInputValue[]))
}

export function setTaskStatus(db: DatabaseSync, id: number, status: TaskStatus, error?: string): void {
  updateTask(db, id, { status, error: error ?? null })
}

export function incrementFetched(db: DatabaseSync, id: number, n: number): void {
  db.prepare('UPDATE tasks SET fetched_count = fetched_count + ? WHERE id = ?').run(n, id)
}

export function finishTask(db: DatabaseSync, id: number): void {
  updateTask(db, id, { status: 'done', finished_at: new Date().toISOString() })
}

export function listTasks(db: DatabaseSync): TaskRow[] {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as unknown as TaskRow[]
}

export function getRunningTasks(db: DatabaseSync): TaskRow[] {
  return db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as unknown as TaskRow[]
}

export function upsertAuthor(db: DatabaseSync, item: VideoItem, platform: string, category?: string | null): { id: number; created: boolean } {
  const now = new Date().toISOString()
  const info = db.prepare(
    `INSERT OR IGNORE INTO authors (platform, sec_uid, nickname, home_url, video_count, last_fetched_at, category)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(platform, item.authorSecUid, item.authorNickname, item.authorHomeUrl, now, category ?? null)
  const created = info.changes > 0
  if (!created) {
    // 已存在作者：刷新昵称/链接，品类只在为空时补（首次抓到的话题标签为准，不覆盖人工修改）
    db.prepare(
      `UPDATE authors SET nickname = ?, home_url = ?, last_fetched_at = ?, category = COALESCE(category, ?) WHERE platform = ? AND sec_uid = ?`
    ).run(item.authorNickname, item.authorHomeUrl, now, category ?? null, platform, item.authorSecUid)
  }
  const row = db.prepare('SELECT id FROM authors WHERE platform = ? AND sec_uid = ?').get(platform, item.authorSecUid) as { id: number }
  return { id: row.id, created }
}

export function updateAuthorCategory(db: DatabaseSync, id: number, category: string): void {
  db.prepare('UPDATE authors SET category = ? WHERE id = ?').run(category, id)
}

/** 删除作者及其关联视频（#3：不要的作者整组清理） */
export function deleteAuthors(db: DatabaseSync, ids: number[]): void {
  if (!ids.length) return
  const ph = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM videos WHERE author_id IN (${ph})`).run(...(ids as unknown as SQLInputValue[]))
  db.prepare(`DELETE FROM authors WHERE id IN (${ph})`).run(...(ids as unknown as SQLInputValue[]))
}

export function listAuthors(db: DatabaseSync, platform?: string): AuthorRow[] {
  if (platform) return db.prepare('SELECT * FROM authors WHERE platform = ? ORDER BY video_count DESC').all(platform) as unknown as AuthorRow[]
  return db.prepare('SELECT * FROM authors ORDER BY video_count DESC').all() as unknown as AuthorRow[]
}

export function insertVideos(db: DatabaseSync, items: VideoItem[], taskId: number, platform: string): number {
  let inserted = 0
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO videos
       (platform, task_id, aweme_id, title, author_id, play_addr, duration, publish_time, stats, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const bumpAuthorStmt = db.prepare('UPDATE authors SET video_count = video_count + 1 WHERE id = ?')
  for (const it of items) {
    const { id: authorId, created } = upsertAuthor(db, it, platform)
    const info = stmt.run(
      platform, taskId, it.awemeId, it.title, authorId, it.playUrl,
      it.durationSec, new Date(it.publishTime * 1000).toISOString(), JSON.stringify({ likes: it.likes }), now
    )
    if (info.changes > 0) {
      inserted++
      if (!created) bumpAuthorStmt.run(authorId)
    }
  }
  return inserted
}

/** 按 id 删除视频行（Task 3 程序内删除），返回删除条数 */
export function deleteVideos(db: DatabaseSync, ids: number[]): { deleted: number } {
  if (!ids.length) return { deleted: 0 }
  const ph = ids.map(() => '?').join(',')
  const info = db.prepare(`DELETE FROM videos WHERE id IN (${ph})`).run(...(ids as unknown as SQLInputValue[]))
  return { deleted: Number(info.changes) }
}

/** LIKE 通配符转义：\ % _ 一律字面匹配（配合 ESCAPE '\'），防止前缀里带通配符的路径误删其它行 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * 按本地路径前缀删除视频行（文件管理删品类/作者联动），返回删除条数与受影响作者 id。
 * 前缀必须以目录分隔符收尾：删「美食」只匹配 `.../美食/` 下的行，不会命中「美食家」等
 * 名称互为前缀的兄弟品类/作者目录（品类名来自 AI 分类、作者名来自昵称，碰撞完全现实）。
 */
export function deleteVideosByPathPrefix(db: DatabaseSync, prefix: string): { deleted: number; authorIds: number[] } {
  const like = `${escapeLike(prefix + sep)}%`
  const rows = db.prepare(`SELECT author_id FROM videos WHERE local_path LIKE ? ESCAPE '\\'`)
    .all(like) as unknown as Array<{ author_id: number | null }>
  const info = db.prepare(`DELETE FROM videos WHERE local_path LIKE ? ESCAPE '\\'`).run(like)
  return { deleted: Number(info.changes), authorIds: rows.map(r => r.author_id).filter((x): x is number => x != null) }
}

/** 按作者 id 重算 video_count（= 剩余视频数；Task 3 删除视频后计数联动） */
export function recomputeAuthorCounts(db: DatabaseSync, authorIds: number[]): void {
  const unique = [...new Set(authorIds)].filter((x): x is number => typeof x === 'number')
  if (!unique.length) return
  const ph = unique.map(() => '?').join(',')
  db.prepare(
    `UPDATE authors SET video_count = (SELECT COUNT(*) FROM videos WHERE author_id = authors.id) WHERE id IN (${ph})`
  ).run(...(unique as unknown as SQLInputValue[]))
}

export function listVideos(db: DatabaseSync, taskId: number): VideoRow[] {
  return db.prepare(
    `SELECT v.*, a.nickname AS author_nickname
     FROM videos v LEFT JOIN authors a ON a.id = v.author_id
     WHERE v.task_id = ? ORDER BY v.id`
  ).all(taskId) as unknown as VideoRow[]
}

export interface TaskStats {
  total: number; done: number; failed: number; downloading: number; pending: number; filtered: number
  collected: number; cancelled: number; paused: number
}

/** 一个任务的视频按状态计数（供"下载 X/Y"进度展示） */
export function taskStats(db: DatabaseSync, taskId: number): TaskStats {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM videos WHERE task_id=? GROUP BY status').all(taskId) as unknown as Array<{ status: string; c: number }>
  const s: TaskStats = { total: 0, done: 0, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 }
  for (const r of rows) {
    s.total += r.c
    if (r.status === 'done') s.done = r.c
    else if (r.status === 'failed') s.failed = r.c
    else if (r.status === 'downloading') s.downloading = r.c
    else if (r.status === 'pending') s.pending = r.c
    else if (r.status === 'filtered') s.filtered = r.c
    else if (r.status === 'collected') s.collected = r.c
    else if (r.status === 'cancelled') s.cancelled = r.c
    else if (r.status === 'paused') s.paused = r.c
  }
  return s
}

export function listPendingVideos(db: DatabaseSync): VideoRow[] {
  return db.prepare("SELECT * FROM videos WHERE status = 'pending' ORDER BY id").all() as unknown as VideoRow[]
}

/** 按作者查视频，status 可过滤（默认全部） */
export function listAuthorVideos(db: DatabaseSync, authorId: number, status?: VideoStatus): VideoRow[] {
  if (status) return db.prepare('SELECT * FROM videos WHERE author_id = ? AND status = ? ORDER BY id').all(authorId, status) as unknown as VideoRow[]
  return db.prepare('SELECT * FROM videos WHERE author_id = ? ORDER BY id').all(authorId) as unknown as VideoRow[]
}

/** 设置作者归档状态；state 传 null 表示清空 */
export function setAuthorOrganizeState(db: DatabaseSync, id: number, state: 'pending' | 'done' | 'failed' | null): void {
  db.prepare('UPDATE authors SET organize_state = ? WHERE id = ?').run(state, id)
}

export function setVideoStatus(db: DatabaseSync, id: number, status: VideoStatus, patch: Partial<VideoRow> = {}): void {
  const sets = ['status = ?']
  const vals: unknown[] = [status]
  for (const k of ['error', 'local_path', 'file_size', 'retry_count', 'downloaded_at', 'ai_verdict', 'ai_tags'] as const) {
    if (k in patch && patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]) }
  }
  vals.push(id)
  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as SQLInputValue[]))
}
