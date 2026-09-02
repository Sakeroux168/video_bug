import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, listTasks, insertVideos, listVideos, upsertAuthor, listAuthors, setVideoStatus, listPendingVideos, setTaskStatus, taskStats, deleteVideos, recomputeAuthorCounts, insertAuthorIfAbsent, updateAuthorCategory, setAuthorVerify } from '../src/main/db'
import type { CreateTaskInput, Filters } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
})

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}

const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId: 'AW1', title: '标题1', authorSecUid: 'SEC1', authorNickname: '作者1',
  authorHomeUrl: 'https://www.douyin.com/user/SEC1', playUrl: 'https://v/play/1',
  coverUrl: 'https://img.test/cover.jpg', width: 1080, height: 1920,
  durationSec: 60, publishTime: 1710000000, likes: 10, ...over
})

describe('db', () => {
  it('创建任务并回读', () => {
    const id = createTask(db, input)
    const rows = listTasks(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('pending')
  })

  it('insertVideos 去重：同 (platform,aweme_id) 只入一次', () => {
    const id = createTask(db, input)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(1)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(0)
    expect(listVideos(db, id)).toHaveLength(1)
  })

  it('insertVideos 保存封面地址与视频宽高', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    const [video] = listVideos(db, id)
    expect(video.cover_url).toBe('https://img.test/cover.jpg')
    expect(video.cover_path).toBeNull()
    expect(video.video_width).toBe(1080)
    expect(video.video_height).toBe(1920)
  })

  it('老库迁移：videos 表自动补封面与宽高列，已有行保留', () => {
    const old = new DatabaseSync(':memory:')
    old.exec(`CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin', task_id INTEGER NOT NULL,
      aweme_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', author_id INTEGER,
      play_addr TEXT, duration INTEGER NOT NULL DEFAULT 0, publish_time TEXT,
      stats TEXT NOT NULL DEFAULT '{}', ai_verdict TEXT, ai_tags TEXT,
      status TEXT NOT NULL DEFAULT 'pending', local_path TEXT, file_size INTEGER,
      error TEXT, retry_count INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL,
      downloaded_at TEXT, UNIQUE(platform, aweme_id)
    );
    INSERT INTO videos (task_id, aweme_id, fetched_at) VALUES (1, 'OLD1', '2026-01-01');`)
    initDb(old)
    const columns = old.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>
    expect(columns.map(c => c.name)).toEqual(expect.arrayContaining([
      'cover_url', 'cover_path', 'video_width', 'video_height'
    ]))
    expect(old.prepare('SELECT aweme_id, video_width, video_height FROM videos').get())
      .toEqual({ aweme_id: 'OLD1', video_width: 0, video_height: 0 })
  })

  it('upsertAuthor 幂等，video_count 累加', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const authors = listAuthors(db)
    expect(authors).toHaveLength(1)
    expect(authors[0].video_count).toBe(2)
  })

  it('重复视频不虚增 author.video_count', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    insertVideos(db, [item()], id, 'douyin')
    expect(listAuthors(db)[0].video_count).toBe(1)
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    expect(listAuthors(db)[0].video_count).toBe(2)
  })

  it('setVideoStatus 更新状态', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'downloading')
    expect(listVideos(db, id)[0].status).toBe('downloading')
  })

  it('listPendingVideos 只返回 pending', () => {
    const id = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AW1' })], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'done')
    expect(listPendingVideos(db).map(x => x.aweme_id).sort()).toEqual(['AW2'])
  })

  it('listPendingVideos 不含 paused（重启后 paused 项不自动下载）', () => {
    const id = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AW1' })], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const [v1] = listVideos(db, id)
    setVideoStatus(db, v1.id, 'paused')
    expect(listPendingVideos(db).map(x => x.aweme_id)).toEqual(['AW2'])
  })

  it('setTaskStatus 更新任务', () => {
    const id = createTask(db, input)
    setTaskStatus(db, id, 'running')
    setTaskStatus(db, id, 'done')
    expect(listTasks(db)[0].status).toBe('done')
  })
})

describe('taskStats', () => {
  it('按状态统计一个任务的视频数量', () => {
    const id = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'S1' }), item({ awemeId: 'S2' })], id, 'douyin')
    const vs = listVideos(db, id)
    setVideoStatus(db, vs[0].id, 'done')
    const s = taskStats(db, id)
    expect(s.total).toBe(2)
    expect(s.done).toBe(1)
    expect(s.pending).toBe(1)
  })
})

describe('db 扩展（Task 1）', () => {
  it('createTask 带 autoDownload:false → auto_download 落 0', () => {
    createTask(db, { ...input, autoDownload: false })
    expect(listTasks(db)[0].auto_download).toBe(0)
  })

  it('老库迁移：tasks 表无 auto_download 列时 initDb 补列且已有行默认 1', () => {
    const old = new DatabaseSync(':memory:')
    old.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin',
      type TEXT NOT NULL,
      query TEXT NOT NULL,
      filters TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      target_count INTEGER NOT NULL DEFAULT 200,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )`)
    old.prepare("INSERT INTO tasks (type, query, created_at) VALUES ('keyword', 'q', ?)").run(new Date().toISOString())
    initDb(old)
    const rows = old.prepare('SELECT * FROM tasks').all() as Array<{ auto_download: number }>
    expect(rows[0].auto_download).toBe(1)
  })

  it('taskStats 统计 collected/cancelled', () => {
    const id = createTask(db, { ...input, autoDownload: false })
    insertVideos(db, [item({ awemeId: 'S1' }), item({ awemeId: 'S2' }), item({ awemeId: 'S3' })], id, 'douyin')
    const vs = listVideos(db, id)
    setVideoStatus(db, vs[0].id, 'collected')
    setVideoStatus(db, vs[1].id, 'cancelled')
    const s = taskStats(db, id)
    expect(s.total).toBe(3)
    expect(s.collected).toBe(1)
    expect(s.cancelled).toBe(1)
    expect(s.pending).toBe(1)
  })

  it('taskStats 统计 paused 计数', () => {
    const id = createTask(db, { ...input, autoDownload: false })
    insertVideos(db, [item({ awemeId: 'S1' }), item({ awemeId: 'S2' }), item({ awemeId: 'S3' })], id, 'douyin')
    const vs = listVideos(db, id)
    setVideoStatus(db, vs[0].id, 'paused')
    setVideoStatus(db, vs[1].id, 'cancelled')
    const s = taskStats(db, id)
    expect(s.total).toBe(3)
    expect(s.paused).toBe(1)
    expect(s.cancelled).toBe(1)
    expect(s.pending).toBe(1)
  })

  it('listVideos 联查返回 author_nickname', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    const [v] = listVideos(db, id)
    expect(v.author_nickname).toBe('作者1')
  })
})

describe('deleteVideos / recomputeAuthorCounts（Task 3 程序内删除）', () => {
  it('deleteVideos 按 id 删行并返回删除数', () => {
    const id = createTask(db, input)
    insertVideos(db, [item(), item({ awemeId: 'AW2' }), item({ awemeId: 'AW3' })], id, 'douyin')
    const vs = listVideos(db, id)
    expect(deleteVideos(db, [vs[0].id, vs[2].id]).deleted).toBe(2)
    expect(listVideos(db, id).map(v => v.aweme_id)).toEqual(['AW2'])
  })

  it('deleteVideos 空数组/不存在的 id 返回 0 且不报错', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    expect(deleteVideos(db, []).deleted).toBe(0)
    expect(deleteVideos(db, [99999]).deleted).toBe(0)
    expect(listVideos(db, id)).toHaveLength(1)
  })

  it('删 1 条后 recomputeAuthorCounts 让 video_count 从 2 → 1', () => {
    const id = createTask(db, input)
    insertVideos(db, [item(), item({ awemeId: 'AW2' })], id, 'douyin')
    expect(listAuthors(db)[0].video_count).toBe(2)
    const [v1] = listVideos(db, id)
    deleteVideos(db, [v1.id])
    recomputeAuthorCounts(db, [v1.author_id!])
    expect(listAuthors(db)[0].video_count).toBe(1)
  })

  it('多作者：删光一个作者的视频后该作者 video_count 归 0，其它作者不受影响', () => {
    const id = createTask(db, input)
    insertVideos(db, [item(), item({ awemeId: 'AW2' })], id, 'douyin') // 作者 SEC1 两条
    insertVideos(db, [item({ awemeId: 'AW3', authorSecUid: 'SEC2', authorNickname: '作者2' })], id, 'douyin') // 作者 SEC2 一条
    const authors = listAuthors(db)
    const sec1 = authors.find(a => a.sec_uid === 'SEC1')!
    const sec2 = authors.find(a => a.sec_uid === 'SEC2')!
    const vs = listVideos(db, id)
    deleteVideos(db, vs.filter(v => v.author_id === sec1.id).map(v => v.id))
    recomputeAuthorCounts(db, [sec1.id, sec2.id])
    const after = listAuthors(db)
    expect(after.find(a => a.id === sec1.id)!.video_count).toBe(0)
    expect(after.find(a => a.id === sec2.id)!.video_count).toBe(1)
  })
})

describe('insertAuthorIfAbsent（导入作者：只登记不刷新）', () => {
  const a = (over: Partial<{ platform: string; secUid: string; nickname: string; homeUrl: string }> = {}) => ({
    platform: 'douyin', secUid: 'SEC_IMPORT_1', nickname: '导入作者', homeUrl: 'https://www.douyin.com/user/SEC_IMPORT_1',
    ...over
  })

  it('新建作者：created=true 且 video_count=0（不写该列，DDL 默认值天然为 0）', () => {
    const r = insertAuthorIfAbsent(db, a())
    expect(r.created).toBe(true)
    expect(r.id).toBeTypeOf('number')
    const rows = listAuthors(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].video_count).toBe(0)
    expect(rows[0].nickname).toBe('导入作者')
    expect(rows[0].home_url).toBe('https://www.douyin.com/user/SEC_IMPORT_1')
  })

  it('重复调用：created=false，且 nickname/category 不被覆盖', () => {
    const r1 = insertAuthorIfAbsent(db, a())
    updateAuthorCategory(db, r1.id, '人工品类')
    const r2 = insertAuthorIfAbsent(db, a({ nickname: '改了个名', homeUrl: 'https://www.douyin.com/user/other' }))
    expect(r2.created).toBe(false)
    expect(r2.id).toBe(r1.id)
    const rows = listAuthors(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].nickname).toBe('导入作者') // 未被第二次调用的新 nickname 覆盖
    expect(rows[0].category).toBe('人工品类') // 未被清空/覆盖
    expect(rows[0].home_url).toBe('https://www.douyin.com/user/SEC_IMPORT_1') // 未被第二次调用的新 URL 覆盖
    expect(rows[0].last_fetched_at).toBeNull() // 不动 last_fetched_at
  })

  it('不同 platform 同 sec_uid 各自成行（UNIQUE(platform, sec_uid) 联合约束）', () => {
    const r1 = insertAuthorIfAbsent(db, a({ platform: 'douyin' }))
    const r2 = insertAuthorIfAbsent(db, a({ platform: 'other' }))
    expect(r1.created).toBe(true)
    expect(r2.created).toBe(true)
    expect(r1.id).not.toBe(r2.id)
    expect(listAuthors(db)).toHaveLength(2)
  })
})

describe('作者校验状态（导入的作者需要校验名称与链接是否对得上）', () => {
  it('导入的作者初始为 pending；抓取自动收录的不带校验状态', () => {
    const r = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'S1', nickname: '张三', homeUrl: 'https://www.douyin.com/user/S1' })
    const row = db.prepare('SELECT verify_state, verify_error FROM authors WHERE id = ?').get(r.id) as { verify_state: string | null; verify_error: string | null }
    expect(row.verify_state).toBe('pending')
    expect(row.verify_error).toBe(null)

    // upsertAuthor 是抓取时登记作者的路径，数据来自真实接口，无需校验
    const u = upsertAuthor(db, item({ authorSecUid: 'S2', authorNickname: '李四' }), 'douyin')
    const row2 = db.prepare('SELECT verify_state FROM authors WHERE id = ?').get(u.id) as { verify_state: string | null }
    expect(row2.verify_state).toBe(null)
  })

  it('setAuthorVerify 写入结果；ok 时清掉旧的失败原因', () => {
    const r = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'S1', nickname: '张三', homeUrl: 'u' })
    setAuthorVerify(db, r.id, 'failed', '主页作者是「王五」，与你填的「张三」对不上')
    let row = db.prepare('SELECT verify_state, verify_error FROM authors WHERE id = ?').get(r.id) as { verify_state: string; verify_error: string | null }
    expect(row.verify_state).toBe('failed')
    expect(row.verify_error).toContain('对不上')

    setAuthorVerify(db, r.id, 'ok')
    row = db.prepare('SELECT verify_state, verify_error FROM authors WHERE id = ?').get(r.id) as { verify_state: string; verify_error: string | null }
    expect(row.verify_state).toBe('ok')
    expect(row.verify_error).toBe(null)
  })

  it('listAuthors 带出校验状态与原因', () => {
    const r = insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'S1', nickname: '张三', homeUrl: 'u' })
    setAuthorVerify(db, r.id, 'failed', '页面打不开')
    const a = listAuthors(db).find(x => x.id === r.id)!
    expect(a.verify_state).toBe('failed')
    expect(a.verify_error).toBe('页面打不开')
  })

  it('老库迁移：建旧表（无 verify_* 列）后 initDb 能补列且不丢数据', () => {
    const old = new DatabaseSync(':memory:')
    old.exec(`CREATE TABLE authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'douyin',
      sec_uid TEXT NOT NULL, nickname TEXT NOT NULL, home_url TEXT,
      video_count INTEGER NOT NULL DEFAULT 0, last_fetched_at TEXT, note TEXT,
      UNIQUE(platform, sec_uid))`)
    old.prepare('INSERT INTO authors (platform, sec_uid, nickname) VALUES (?,?,?)').run('douyin', 'OLD', '老作者')
    initDb(old)
    const row = old.prepare("SELECT nickname, verify_state FROM authors WHERE sec_uid = 'OLD'").get() as { nickname: string; verify_state: string | null }
    expect(row.nickname).toBe('老作者')
    expect(row.verify_state).toBe(null)
  })
})

describe('listTasks 带出作者昵称（任务列表不能只显示一串 sec_uid）', () => {
  it('type=author 且库里有该作者 → 带出 nickname', () => {
    insertAuthorIfAbsent(db, { platform: 'douyin', secUid: 'MS4wABC', nickname: '张三', homeUrl: 'u' })
    createTask(db, { ...input, type: 'author', query: 'MS4wABC' })
    const t = listTasks(db)[0]
    expect(t.author_nickname).toBe('张三')
  })

  it('库里还没这个作者 → nickname 为 null（渲染层回落显示 query）', () => {
    createTask(db, { ...input, type: 'author', query: 'MS4wNOBODY' })
    expect(listTasks(db)[0].author_nickname).toBe(null)
  })

  it('关键词任务不误匹配作者（即使关键词恰巧等于某个 sec_uid）', () => {
    insertAuthorIfAbsent(db, { platform: 'douyin', secUid: '美食', nickname: '不该出现', homeUrl: 'u' })
    createTask(db, { ...input, type: 'keyword', query: '美食' })
    expect(listTasks(db)[0].author_nickname).toBe(null)
  })
})
