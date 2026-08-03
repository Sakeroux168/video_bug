import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus } from '../src/main/db'
import { Organizer, sanitizeCategory, sanitizeDirName, authorDirName } from '../src/main/organizer'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'org-'))
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}
const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId: 'AW001', title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', durationSec: 10, publishTime: 1710000000, likes: 0,
  ...over
})

/** 造一个作者及 count 条已 done（含 local_path 假文件）的视频，返回作者 id 与视频 id/源文件路径；durationSec 可指定统一时长 */
function authorWithDoneVideos(secUid: string, nickname: string, count = 2, durationSec?: number): { authorId: number; vids: Array<{ id: number; src: string }> } {
  const taskId = createTask(db, input)
  insertVideos(db, Array.from({ length: count }, (_, i) => item({
    awemeId: `${secUid}_${i}`, authorSecUid: secUid, authorNickname: nickname,
    ...(durationSec !== undefined ? { durationSec } : {})
  })), taskId, 'douyin')
  const vs = listVideos(db, taskId)
  const authorId = vs[0].author_id!
  const vids = vs.map((v, i) => {
    const src = join(dir, `${secUid}_${i}.mp4`)
    writeFileSync(src, Buffer.from([1, 2, 3]))
    setVideoStatus(db, v.id, 'done', { local_path: src })
    return { id: v.id, src }
  })
  return { authorId, vids }
}

function organizer(category: string | null = '美食'): Organizer {
  return new Organizer({
    db, downloadDir: dir,
    resolveCategory: async () => category,
  })
}

describe('sanitizeCategory / sanitizeDirName', () => {
  it('sanitizeCategory：非法字符→_、trim、限长 32、空回落未分类', () => {
    expect(sanitizeCategory('美食/探店:1*2')).toBe('美食_探店_1_2')
    expect(sanitizeCategory('  ')).toBe('未分类')
    expect(sanitizeCategory('a'.repeat(50))).toHaveLength(32)
    expect(sanitizeCategory(' 美 食 ')).toBe('美 食')
  })
  it('sanitizeDirName：非法字符→_、trim、限长 64、空回落作者', () => {
    expect(sanitizeDirName('作者/名:*')).toBe('作者_名__')
    expect(sanitizeDirName('   ')).toBe('作者')
    expect(sanitizeDirName('a'.repeat(100))).toHaveLength(64)
  })
})

describe('authorDirName', () => {
  it('DB 已有同名作者（不同 sec_uid）→ 加 _后6位；本人 → 原名', () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AW1', authorSecUid: 'SEC111111', authorNickname: '昵称' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const me = db.prepare('SELECT nickname, sec_uid FROM authors WHERE id=?').get(v.author_id!) as { nickname: string; sec_uid: string }
    expect(authorDirName(me, db)).toBe('昵称')
    expect(authorDirName({ nickname: '昵称', sec_uid: 'SEC222222' }, db)).toBe('昵称_222222')
  })
})

describe('Organizer.organizeAuthor', () => {
  it('2 条 done 视频归档到 {品类}/{昵称}/一分钟内，DB local_path 更新，organize_state=done，返回 moved:2', async () => {
    const { authorId, vids } = authorWithDoneVideos('SEC111111', '作者')
    const res = await organizer().organizeAuthor(authorId)
    expect(res).toEqual({ moved: 2, category: '美食', state: 'done' })

    const destDir = join(dir, '美食', '作者', '一分钟内')
    expect(existsSync(destDir)).toBe(true)
    for (const v of vids) expect(existsSync(v.src)).toBe(false) // 源文件已移走
    const rows = db.prepare('SELECT local_path FROM videos WHERE author_id=?').all(authorId) as Array<{ local_path: string }>
    for (const r of rows) {
      expect(r.local_path).toContain(destDir)
      expect(existsSync(r.local_path)).toBe(true)
    }
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(authorId)).toEqual({ organize_state: 'done' })
  })

  it('60s 整 → 归档到 {品类}/{昵称}/一分钟内/；61s → 一分钟外/（60s 为界）', async () => {
    const a60 = authorWithDoneVideos('SEC600001', '整界', 1, 60)
    const a61 = authorWithDoneVideos('SEC600002', '超界', 1, 61)
    await organizer().organizeAuthor(a60.authorId)
    await organizer().organizeAuthor(a61.authorId)
    expect(existsSync(join(dir, '美食', '整界', '一分钟内', 'SEC600001_0.mp4'))).toBe(true)
    expect(existsSync(join(dir, '美食', '整界', '一分钟外'))).toBe(false)
    expect(existsSync(join(dir, '美食', '超界', '一分钟外', 'SEC600002_0.mp4'))).toBe(true)
    expect(existsSync(join(dir, '美食', '超界', '一分钟内'))).toBe(false)
  })

  it('同作者 60s/61s 两条混合 → 各自进对应分桶，DB local_path 更新', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [
      item({ awemeId: 'SECMIX_A', authorSecUid: 'SECMIX', authorNickname: '混合', durationSec: 60 }),
      item({ awemeId: 'SECMIX_B', authorSecUid: 'SECMIX', authorNickname: '混合', durationSec: 61 })
    ], taskId, 'douyin')
    const vs = listVideos(db, taskId)
    vs.forEach((v, i) => {
      const src = join(dir, `mix${i}.mp4`)
      writeFileSync(src, Buffer.from([1, 2, 3]))
      setVideoStatus(db, v.id, 'done', { local_path: src })
    })
    const res = await organizer().organizeAuthor(vs[0].author_id!)
    expect(res).toEqual({ moved: 2, category: '美食', state: 'done' })
    expect(readdirSync(join(dir, '美食', '混合', '一分钟内'))).toEqual(['mix0.mp4'])
    expect(readdirSync(join(dir, '美食', '混合', '一分钟外'))).toEqual(['mix1.mp4'])
    const rows = db.prepare('SELECT local_path FROM videos WHERE author_id=?').all(vs[0].author_id!) as Array<{ local_path: string }>
    expect(rows.map(r => r.local_path.replaceAll('\\', '/'))).toEqual([
      join(dir, '美食', '混合', '一分钟内', 'mix0.mp4').replaceAll('\\', '/'),
      join(dir, '美食', '混合', '一分钟外', 'mix1.mp4').replaceAll('\\', '/')
    ])
  })

  it('作者昵称含非法字符 → 目录名被清洗，落盘不含非法字符', async () => {
    const { authorId } = authorWithDoneVideos('SEC222222', '作者/名:*')
    await organizer('搞笑').organizeAuthor(authorId)
    const entries = readdirSync(join(dir, '搞笑'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toBe('作者_名__')
    expect(entries[0]).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('同名不同 sec_uid：先入库的作者用原名，后入库的带 _后6位 后缀', async () => {
    const a1 = authorWithDoneVideos('SEC111111', '昵称')
    const org = organizer('美食')
    await org.organizeAuthor(a1.authorId)
    expect(existsSync(join(dir, '美食', '昵称', '一分钟内'))).toBe(true)

    const a2 = authorWithDoneVideos('SEC222222', '昵称')
    await org.organizeAuthor(a2.authorId)
    const entries = readdirSync(join(dir, '美食')).sort()
    expect(entries).toEqual(['昵称', '昵称_222222'])
  })

  it('无 done 视频 → 归未分类、state 仍 done、moved 0', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AWX', authorSecUid: 'SEC333333', authorNickname: '空作者' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const authorId = v.author_id!
    const res = await organizer().organizeAuthor(authorId)
    expect(res).toEqual({ moved: 0, category: '未分类', state: 'done' })
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(authorId)).toEqual({ organize_state: 'done' })
  })

  it('resolveCategory 返回 null → 归未分类，但文件照常移动，state 仍 done', async () => {
    const { authorId, vids } = authorWithDoneVideos('SEC444444', '无分类')
    const res = await organizer(null).organizeAuthor(authorId)
    expect(res).toEqual({ moved: 2, category: '未分类', state: 'done' })
    const destDir = join(dir, '未分类', '无分类', '一分钟内')
    expect(existsSync(destDir)).toBe(true)
    for (const v of vids) expect(existsSync(v.src)).toBe(false)
  })

  it('resolveCategory 抛错 → 归未分类，state 仍 done（归档本身成功）', async () => {
    const { authorId, vids } = authorWithDoneVideos('SEC555555', '抛错')
    const org = new Organizer({ db, downloadDir: dir, resolveCategory: async () => { throw new Error('ai_down') } })
    const res = await org.organizeAuthor(authorId)
    expect(res).toEqual({ moved: 2, category: '未分类', state: 'done' })
    for (const v of vids) expect(existsSync(v.src)).toBe(false)
  })

  it('移动失败（源文件缺失）→ state failed，organize_state=failed', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AWF', authorSecUid: 'SEC666666', authorNickname: '缺文件' })], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const authorId = v.author_id!
    setVideoStatus(db, v.id, 'done', { local_path: join(dir, 'missing.mp4') }) // local_path 指向不存在的文件
    const res = await organizer().organizeAuthor(authorId)
    expect(res.state).toBe('failed')
    expect(res.moved).toBe(0)
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(authorId)).toEqual({ organize_state: 'failed' })
  })

  it('目标文件已存在 → ensureUniqueName 加后缀，不覆盖', async () => {
    const { authorId, vids } = authorWithDoneVideos('SEC777777', '去重')
    const destDir = join(dir, '美食', '去重', '一分钟内')
    mkdirSync(destDir, { recursive: true })
    const name0 = basename(vids[0].src)
    writeFileSync(join(destDir, name0), Buffer.from([9, 9, 9])) // 预置同名文件模拟残留
    const res = await organizer().organizeAuthor(authorId)
    expect(res.moved).toBe(2)
    expect(existsSync(join(destDir, `${basename(vids[0].src, '.mp4')}_1.mp4`))).toBe(true)
    expect(existsSync(join(destDir, name0))).toBe(true)
  })
})

describe('Organizer.organizePending / organizeAll / markAuthorPending', () => {
  it('organizePending 只处理 organize_state=pending 的作者', async () => {
    const a1 = authorWithDoneVideos('SEC800001', '甲')
    const a2 = authorWithDoneVideos('SEC800002', '乙')
    db.prepare("UPDATE authors SET organize_state='pending' WHERE id=?").run(a1.authorId)
    const n = await organizer().organizePending()
    expect(n).toBe(1)
    expect(existsSync(join(dir, '美食', '甲', '一分钟内'))).toBe(true)
    expect(existsSync(join(dir, '美食', '乙'))).toBe(false)
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(a1.authorId)).toEqual({ organize_state: 'done' })
  })

  it('organizeAll 处理所有有 done 视频未归档的作者（含 pending/failed/null）', async () => {
    const a1 = authorWithDoneVideos('SEC900001', '甲')
    const a2 = authorWithDoneVideos('SEC900002', '乙')
    const a3 = authorWithDoneVideos('SEC900003', '丙')
    db.prepare("UPDATE authors SET organize_state='pending' WHERE id=?").run(a2.authorId)
    db.prepare("UPDATE authors SET organize_state='failed' WHERE id=?").run(a3.authorId)
    const n = await organizer().organizeAll()
    expect(n).toBe(3)
    expect(existsSync(join(dir, '美食', '甲', '一分钟内'))).toBe(true)
    expect(existsSync(join(dir, '美食', '乙', '一分钟内'))).toBe(true)
    expect(existsSync(join(dir, '美食', '丙', '一分钟内'))).toBe(true)
  })

  it('organizeAll 跳过已 done 归档的作者', async () => {
    const a1 = authorWithDoneVideos('SEC910001', '甲')
    db.prepare("UPDATE authors SET organize_state='done' WHERE id=?").run(a1.authorId)
    const n = await organizer().organizeAll()
    expect(n).toBe(0)
    expect(existsSync(join(dir, '美食', '甲', '一分钟内'))).toBe(false)
  })

  it('markAuthorPending：有平铺 done 视频即置 pending（done 不再挡死）；无平铺 done 不动', async () => {
    const a1 = authorWithDoneVideos('SEC920001', '甲') // 2 条平铺 done
    const a2 = authorWithDoneVideos('SEC920002', '乙') // 2 条平铺 done
    const a3 = authorWithDoneVideos('SEC920003', '丙') // 2 条平铺 done，但先归档进子目录
    db.prepare("UPDATE authors SET organize_state='done' WHERE id=?").run(a1.authorId) // 模拟上一批已归档置 done
    db.prepare("UPDATE authors SET organize_state='failed' WHERE id=?").run(a2.authorId)
    await organizer().organizeAuthor(a3.authorId) // a3 全部归档，不再有平铺视频
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(a3.authorId)).toEqual({ organize_state: 'done' })

    const org = organizer()
    org.markAuthorPending(a1.authorId) // done 但仍有平铺 done → pending
    org.markAuthorPending(a2.authorId) // failed 且有平铺 done → pending
    org.markAuthorPending(a3.authorId) // done 且已无平铺 done → 不动
    const st = db.prepare('SELECT id, organize_state FROM authors').all() as Array<{ id: number; organize_state: string | null }>
    expect(st.find(x => x.id === a1.authorId)!.organize_state).toBe('pending')
    expect(st.find(x => x.id === a2.authorId)!.organize_state).toBe('pending')
    expect(st.find(x => x.id === a3.authorId)!.organize_state).toBe('done')
  })

  it('分批下载：先归档一批置 done，新批 done 后 markAuthorPending 再次置 pending，只归档新增（幂等）', async () => {
    const { authorId, vids } = authorWithDoneVideos('SEC940001', '分批', 2)
    const org = organizer('美食')

    // 第一批：markPending + organizeAuthor 归档 2 条
    org.markAuthorPending(authorId)
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(authorId)).toEqual({ organize_state: 'pending' })
    const r1 = await org.organizeAuthor(authorId)
    expect(r1).toEqual({ moved: 2, category: '美食', state: 'done' })
    for (const v of vids) expect(existsSync(v.src)).toBe(false)

    // 第二批：同一作者再下载 1 条平铺 done
    const taskId = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'SEC940001_new', authorSecUid: 'SEC940001', authorNickname: '分批' })], taskId, 'douyin')
    const [nv] = listVideos(db, taskId)
    const src2 = join(dir, 'new.mp4')
    writeFileSync(src2, Buffer.from([4, 5, 6]))
    setVideoStatus(db, nv.id, 'done', { local_path: src2 })

    // done 状态也能再次置 pending，organizeAuthor 只移动新增这条
    org.markAuthorPending(authorId)
    expect(db.prepare('SELECT organize_state FROM authors WHERE id=?').get(authorId)).toEqual({ organize_state: 'pending' })
    const r2 = await org.organizeAuthor(authorId)
    expect(r2).toEqual({ moved: 1, category: '美食', state: 'done' })

    // 已归档的不重名不再移动，新视频进子目录
    const destDir = join(dir, '美食', '分批', '一分钟内')
    expect(existsSync(src2)).toBe(false)
    expect(readdirSync(destDir).sort()).toEqual(['SEC940001_0.mp4', 'SEC940001_1.mp4', 'new.mp4'])
  })

  it('onProgress 每作者回调一次归档结果', async () => {
    const { authorId } = authorWithDoneVideos('SEC930001', '进度')
    const calls: unknown[] = []
    const org = new Organizer({ db, downloadDir: dir, resolveCategory: async () => '美食', onProgress: info => calls.push(info) })
    await org.organizeAuthor(authorId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ authorId, authorName: '进度', moved: 2, category: '美食', state: 'done' })
  })
})
