import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { sep } from 'path'
import type { CreateTaskInput, TaskRow, TaskStatus, VideoRow, AuthorRow, VideoStatus, GlobalStats, RecentDownload } from '../shared/types'
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
  -- 导入的作者需校验「名称与链接是否对得上」：
  --   null   = 无需校验（抓取时自动收录的，数据来自真实接口）
  --   pending= 导入后尚未校验； ok = 已核实； failed = 对不上（verify_error 说明原因）
  verify_state TEXT,
  verify_error TEXT,
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
  source_url TEXT,
  cover_url TEXT,
  cover_path TEXT,
  video_width INTEGER NOT NULL DEFAULT 0,
  video_height INTEGER NOT NULL DEFAULT 0,
  organize_retry INTEGER NOT NULL DEFAULT 0,
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
  addColumnIfMissing(db, 'authors', 'verify_state', 'TEXT')
  addColumnIfMissing(db, 'authors', 'verify_error', 'TEXT')
  addColumnIfMissing(db, 'videos', 'cover_url', 'TEXT')
  addColumnIfMissing(db, 'videos', 'cover_path', 'TEXT')
  addColumnIfMissing(db, 'videos', 'video_width', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'videos', 'video_height', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'videos', 'organize_retry', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'videos', 'source_url', 'TEXT')
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
  // 带出作者昵称：P1.5 把 author 任务的 query 归一化成了 sec_uid，
  // 任务列表直接显示 query 就是一串无意义的英文，用户认不出是谁。
  // 限定 type='author' 才关联，否则关键词恰巧等于某个 sec_uid 时会误匹配。
  return db.prepare(`
    SELECT t.*, a.nickname AS author_nickname
    FROM tasks t
    LEFT JOIN authors a
      ON t.type = 'author' AND a.platform = t.platform AND a.sec_uid = t.query
    ORDER BY t.id DESC
  `).all() as unknown as TaskRow[]
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

/**
 * 导入作者专用：仅在不存在时登记一行，已存在则什么都不改（created:false）。
 * 与 upsertAuthor 语义完全不同——upsertAuthor 服务于「抓到视频时登记/刷新作者」这条热路径
 * （会刷新 nickname/home_url、video_count+1、品类在空时补），复用会污染库里已有真实抓取数据
 * 和人工改过的品类，故不复用、不改它。不写 video_count 列，DDL 默认值天然为 0。
 */
export function insertAuthorIfAbsent(
  db: DatabaseSync,
  a: { platform: string; secUid: string; nickname: string; homeUrl: string }
): { id: number; created: boolean } {
  const info = db.prepare(
    `INSERT OR IGNORE INTO authors (platform, sec_uid, nickname, home_url, verify_state) VALUES (?, ?, ?, ?, 'pending')`
  ).run(a.platform, a.secUid, a.nickname, a.homeUrl)
  const created = info.changes > 0
  const row = db.prepare('SELECT id FROM authors WHERE platform = ? AND sec_uid = ?').get(a.platform, a.secUid) as { id: number }
  return { id: row.id, created }
}

/**
 * 写入作者校验结果。ok 时一并清掉旧的 verify_error——
 * 否则界面会同时显示「已核实」和一条陈旧的失败原因。
 */
export function setAuthorVerify(db: DatabaseSync, id: number, state: 'pending' | 'ok' | 'failed', error?: string): void {
  db.prepare('UPDATE authors SET verify_state = ?, verify_error = ? WHERE id = ?')
    .run(state, state === 'ok' ? null : (error ?? null), id)
}

/**
 * 全站聚合计数（概览页用）。
 *
 * 两条 GROUP BY 代替原来的 1 + N 次调用（listTasks 再对每个任务 getTaskStats）。
 * 任务一多就是几十次 IPC，而且会在每次事件风暴里重复。
 * 缺失的状态补 0——概览页不能显示 undefined/NaN。
 */
export function globalStats(db: DatabaseSync): GlobalStats {
  const zero = (): Record<string, number> => ({})
  const roll = (rows: Array<{ status: string; c: number }>): Record<string, number> & { total: number } => {
    const out = zero()
    let total = 0
    for (const r of rows) { out[r.status] = r.c; total += r.c }
    return { ...out, total } as Record<string, number> & { total: number }
  }
  const videos = db.prepare('SELECT status, COUNT(*) c FROM videos GROUP BY status').all() as unknown as Array<{ status: string; c: number }>
  const tasks = db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all() as unknown as Array<{ status: string; c: number }>
  const fill = (o: Record<string, number> & { total: number }, keys: string[]): never => {
    for (const k of keys) if (o[k] === undefined) o[k] = 0
    return undefined as never
  }
  const v = roll(videos); fill(v, ['pending', 'downloading', 'done', 'failed', 'filtered', 'collected', 'cancelled', 'paused'])
  const t = roll(tasks); fill(t, ['pending', 'running', 'done', 'paused', 'failed'])
  return { videos: v as GlobalStats['videos'], tasks: t as GlobalStats['tasks'] }
}

/**
 * 最近完成的下载（概览页的「活」的那一块）。
 *
 * 刻意用 DB 查询而不是监听 video:status 事件流：
 * 事件载荷里**没有标题**（只有 id），渲染出来是「#412 下载完成」用户不认识；
 * 并发 3 时每秒好几条滚过去人眼也读不了。查库有标题有作者有时间，
 * 而且重启程序后仍在——事件流一重挂就空白。
 */
export function recentDownloads(db: DatabaseSync, limit = 8): RecentDownload[] {
  return db.prepare(`
    SELECT v.id, v.title, v.downloaded_at, a.nickname AS author_nickname
    FROM videos v
    LEFT JOIN authors a ON a.id = v.author_id
    WHERE v.status = 'done' AND v.downloaded_at IS NOT NULL
    ORDER BY v.downloaded_at DESC
    LIMIT ?
  `).all(limit) as unknown as RecentDownload[]
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
       (platform, task_id, aweme_id, title, author_id, play_addr, source_url, cover_url, video_width, video_height, duration, publish_time, stats, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const bumpAuthorStmt = db.prepare('UPDATE authors SET video_count = video_count + 1 WHERE id = ?')
  for (const it of items) {
    const { id: authorId, created } = upsertAuthor(db, it, platform)
    const info = stmt.run(
      platform, taskId, it.awemeId, it.title, authorId, it.playUrl,
      it.sourceUrl || null, it.coverUrl || null, it.width || 0, it.height || 0, it.durationSec,
      new Date(it.publishTime * 1000).toISOString(), JSON.stringify({ likes: it.likes, comments: it.comments }), now
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
  for (const k of ['error', 'local_path', 'cover_path', 'video_width', 'video_height', 'file_size', 'retry_count', 'downloaded_at', 'ai_verdict', 'ai_tags'] as const) {
    if (k in patch && patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]) }
  }
  vals.push(id)
  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as SQLInputValue[]))
}
