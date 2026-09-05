import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, listAuthors } from '../src/main/db'
import { scanFilesTree, deleteFileCategory, deleteFileAuthor, locateFileDir } from '../src/main/fileManager'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput, Filters } from '../src/shared/types'

// Task 4 文件管理：目录树扫描（品类/作者/视频，跳过隐藏与临时项）+ 递归删除（路径防护 + DB LIKE 联动）

let db: DatabaseSync
let tmp: string

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}

const item = (awemeId: string, secUid: string, nickname: string): VideoItem => ({
  awemeId, title: `标题${awemeId}`, authorSecUid: secUid, authorNickname: nickname,
  authorHomeUrl: `https://www.douyin.com/user/${secUid}`, playUrl: 'https://v/play/1',
  durationSec: 60, publishTime: 1710000000, likes: 10
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  tmp = mkdtempSync(join(tmpdir(), 'fm-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 建一条视频并落库，local_path 指向给定文件 */
function addVideo(awemeId: string, path: string): void {
  const id = createTask(db, input)
  insertVideos(db, [item(awemeId, `SEC${awemeId}`, `作者${awemeId}`)], id, 'douyin')
  db.prepare('UPDATE videos SET local_path = ? WHERE aweme_id = ?').run(path, awemeId)
}

// —— 树扫描 ——

describe('scanFilesTree（目录树扫描）', () => {
  it('品类→作者→视频三级结构：数量与大小按文件 stat 累加', () => {
    // organizer 实际归档为 {品类}/{作者}/{时长分桶}/xxx.mp4 → 作者目录内必须递归统计
    mkdirSync(join(tmp, '美食', '作者A', '5-10分钟'), { recursive: true })
    mkdirSync(join(tmp, '美食', '作者B'), { recursive: true })
    mkdirSync(join(tmp, '未分类', '作者C'), { recursive: true })
    writeFileSync(join(tmp, '美食', '作者A', '5-10分钟', 'v1.mp4'), 'x'.repeat(10))
    writeFileSync(join(tmp, '美食', '作者A', 'v2.mp4'), 'x'.repeat(20))
    writeFileSync(join(tmp, '美食', '作者A', 'v2.original.mp4'), 'x'.repeat(1000))
    writeFileSync(join(tmp, '美食', '作者A', '.video-99.download.part.mp4'), 'x'.repeat(1000))
    writeFileSync(join(tmp, '美食', '作者A', 'thumb.jpg'), 'x'.repeat(100)) // 非 mp4 不计
    writeFileSync(join(tmp, '美食', '作者B', 'v3.mp4'), 'x'.repeat(40))
    writeFileSync(join(tmp, '未分类', '作者C', 'v4.MP4'), 'x'.repeat(50)) // 大小写不敏感

    const { categories } = scanFilesTree(tmp)
    expect(categories.map(c => c.name).sort()).toEqual(['未分类', '美食'])
    const food = categories.find(c => c.name === '美食')!
    expect(food.videoCount).toBe(3) // A:2 + B:1（递归计入时长分桶，jpg 不计）
    expect(food.size).toBe(10 + 20 + 40)
    expect(food.authors.map(a => a.name).sort()).toEqual(['作者A', '作者B'])
    expect(food.authors.find(a => a.name === '作者A')).toEqual({ name: '作者A', videoCount: 2, size: 30 })
    expect(food.authors.find(a => a.name === '作者B')).toEqual({ name: '作者B', videoCount: 1, size: 40 })
    const uncat = categories.find(c => c.name === '未分类')!
    expect(uncat.videoCount).toBe(1)
    expect(uncat.size).toBe(50)
  })

  it('跳过隐藏目录（. 开头）、临时目录（~ 开头）与顶层非目录文件', () => {
    mkdirSync(join(tmp, '.hidden', 'x'), { recursive: true })
    mkdirSync(join(tmp, '~temp', 'x'), { recursive: true })
    mkdirSync(join(tmp, '~备份'), { recursive: true })
    mkdirSync(join(tmp, '正常品类'), { recursive: true })
    writeFileSync(join(tmp, '.hidden', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, '~temp', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, 'normal.mp4'), 'x') // 顶层文件不算品类
    writeFileSync(join(tmp, 'readme.txt'), 'x')

    const { categories } = scanFilesTree(tmp)
    expect(categories.map(c => c.name)).toEqual(['正常品类'])
    expect(categories[0].videoCount).toBe(0)
  })

  it('目录不存在 → 空树；空目录 → 空树（totalSize=0、downloadDir 回传）', () => {
    expect(scanFilesTree(join(tmp, '不存在'))).toEqual({ categories: [], totalSize: 0, downloadDir: join(tmp, '不存在') })
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    expect(scanFilesTree(empty)).toEqual({ categories: [], totalSize: 0, downloadDir: empty })
  })
})

// —— totalSize 汇总 ——

describe('scanFilesTree（总大小汇总）', () => {
  it('totalSize = 所有品类 size 合计（多品类多作者递归，含品类直属 mp4）', () => {
    mkdirSync(join(tmp, '美食', '作者A', '5-10分钟'), { recursive: true })
    mkdirSync(join(tmp, '美食', '作者B'), { recursive: true })
    mkdirSync(join(tmp, '未分类', '作者C'), { recursive: true })
    writeFileSync(join(tmp, '美食', '作者A', '5-10分钟', 'v1.mp4'), 'x'.repeat(10))
    writeFileSync(join(tmp, '美食', '作者A', 'v2.mp4'), 'x'.repeat(20))
    writeFileSync(join(tmp, '美食', '作者B', 'v3.mp4'), 'x'.repeat(40))
    writeFileSync(join(tmp, '未分类', '作者C', 'v4.mp4'), 'x'.repeat(50))
    writeFileSync(join(tmp, '未分类', 'v5.mp4'), 'x'.repeat(5)) // 品类直属 mp4 计入品类总量

    const tree = scanFilesTree(tmp)
    expect(tree.categories.reduce((s, c) => s + c.size, 0)).toBe(125) // 美食 70 + 未分类 55
    expect(tree.totalSize).toBe(125)
    expect(tree.downloadDir).toBe(tmp)
  })
})

// —— 定位目录（locateFileDir：校验部分，shell 调用留在 ipc 层）——

describe('locateFileDir（定位校验）', () => {
  it('目录存在且在下载目录内 → ok', () => {
    mkdirSync(join(tmp, '美食', '作者A'), { recursive: true })
    expect(locateFileDir(tmp, join(tmp, '美食'))).toEqual({ ok: true })
    expect(locateFileDir(tmp, join(tmp, '美食', '作者A'))).toEqual({ ok: true })
  })

  it('逃逸路径（..）与下载目录自身 → 拒绝', () => {
    mkdirSync(join(tmp, '美食'), { recursive: true })
    const r1 = locateFileDir(tmp, join(tmp, '..', '越界'))
    const r2 = locateFileDir(tmp, join(tmp, '美食', '..', '..', '越界'))
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(locateFileDir(tmp, tmp).ok).toBe(false) // root 自身不可定位（isPathInside 拒绝）
  })

  it('目录不存在 → 错误提示（不触 shell）', () => {
    expect(locateFileDir(tmp, join(tmp, '不存在'))).toEqual({ ok: false, error: '目录不存在' })
  })

  it('目标是文件而非目录 → 错误提示', () => {
    writeFileSync(join(tmp, 'v.mp4'), 'x')
    expect(locateFileDir(tmp, join(tmp, 'v.mp4'))).toEqual({ ok: false, error: '目录不存在' })
  })
})

// —— 删除 ——

describe('deleteFileCategory / deleteFileAuthor（递归删除 + DB 联动）', () => {
  it('删品类：文件夹递归消失 + 该路径前缀 videos 行删光 + 作者 video_count 重算', async () => {
    const dirA = join(tmp, '美食', '作者A')
    const dirB = join(tmp, '美食', '作者B')
    mkdirSync(join(dirA, '桶'), { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirA, '桶', 'v1.mp4'), 'x')
    writeFileSync(join(dirA, 'v2.mp4'), 'x')
    writeFileSync(join(dirB, 'v3.mp4'), 'x')
    addVideo('AW1', join(dirA, '桶', 'v1.mp4'))
    addVideo('AW2', join(dirA, 'v2.mp4'))
    addVideo('AW3', join(dirB, 'v3.mp4'))

    const r = await deleteFileCategory({ db, downloadDir: tmp }, '美食')
    expect(r).toEqual({ ok: true, deleted: 3, filesRemoved: true })
    expect(existsSync(join(tmp, '美食'))).toBe(false)
    // 库联动：前缀下 3 行全删，作者计数归 0
    expect(db.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 0 })
    expect(listAuthors(db).every(a => a.video_count === 0)).toBe(true)
  })

  it('删作者：只删该作者目录与对应行，同品类其它作者与行保留', async () => {
    const dirA = join(tmp, '美食', '作者A')
    const dirB = join(tmp, '美食', '作者B')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirA, 'v1.mp4'), 'x')
    writeFileSync(join(dirA, 'v2.mp4'), 'x')
    writeFileSync(join(dirB, 'v3.mp4'), 'x')
    addVideo('AW1', join(dirA, 'v1.mp4'))
    addVideo('AW2', join(dirA, 'v2.mp4'))
    addVideo('AW3', join(dirB, 'v3.mp4'))

    const r = await deleteFileAuthor({ db, downloadDir: tmp }, '美食', '作者A')
    expect(r).toEqual({ ok: true, deleted: 2, filesRemoved: true })
    expect(existsSync(dirA)).toBe(false)
    expect(existsSync(dirB)).toBe(true)
    const rest = listVideos(db, 1).concat(listVideos(db, 2), listVideos(db, 3))
    expect(rest).toHaveLength(1)
    expect(rest[0].aweme_id).toBe('AW3')
    // 作者 A 计数 0、作者 B 计数 1
    const byName = Object.fromEntries(listAuthors(db).map(a => [a.nickname, a.video_count]))
    expect(byName['作者AW1']).toBe(0)
    expect(byName['作者AW3']).toBe(1)
  })

  it('LIKE 转义：品类名含 % 或 _ 时不误删其它品类行', async () => {
    mkdirSync(join(tmp, '50%折扣', 'x'), { recursive: true })
    mkdirSync(join(tmp, '50打折', 'x'), { recursive: true })
    mkdirSync(join(tmp, '美食_A', 'x'), { recursive: true })
    mkdirSync(join(tmp, '美食XA', 'x'), { recursive: true })
    writeFileSync(join(tmp, '50%折扣', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, '50打折', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, '美食_A', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, '美食XA', 'x', 'v.mp4'), 'x')
    addVideo('AW1', join(tmp, '50%折扣', 'x', 'v.mp4'))
    addVideo('AW2', join(tmp, '50打折', 'x', 'v.mp4'))
    addVideo('AW3', join(tmp, '美食_A', 'x', 'v.mp4'))
    addVideo('AW4', join(tmp, '美食XA', 'x', 'v.mp4'))

    const r1 = await deleteFileCategory({ db, downloadDir: tmp }, '50%折扣')
    expect(r1.ok).toBe(true)
    expect(r1.deleted).toBe(1)
    const r2 = await deleteFileCategory({ db, downloadDir: tmp }, '美食_A')
    expect(r2.ok).toBe(true)
    expect(r2.deleted).toBe(1)
    // 未转义时 '50%折扣' 会匹配 50打折、'美食_A' 的 _ 会匹配任意单字符——这里必须只删 2 行
    expect(db.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 2 })
    const left = db.prepare('SELECT aweme_id FROM videos ORDER BY aweme_id').all() as Array<{ aweme_id: string }>
    expect(left.map(r => r.aweme_id).sort()).toEqual(['AW2', 'AW4'])
  })

  it('前缀碰撞：删「美食」不误删「美食家」的行（LIKE 前缀必须目录分隔符收尾）', async () => {
    mkdirSync(join(tmp, '美食', 'x'), { recursive: true })
    mkdirSync(join(tmp, '美食家', 'x'), { recursive: true })
    writeFileSync(join(tmp, '美食', 'x', 'v.mp4'), 'x')
    writeFileSync(join(tmp, '美食家', 'x', 'v.mp4'), 'x')
    addVideo('AW1', join(tmp, '美食', 'x', 'v.mp4'))
    addVideo('AW2', join(tmp, '美食家', 'x', 'v.mp4'))

    const r = await deleteFileCategory({ db, downloadDir: tmp }, '美食')
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe(1)
    // 兄弟品类目录与行都保留
    expect(existsSync(join(tmp, '美食家'))).toBe(true)
    const left = db.prepare('SELECT aweme_id FROM videos').all() as Array<{ aweme_id: string }>
    expect(left.map(x => x.aweme_id)).toEqual(['AW2'])
    // 计数联动只影响被删品类的作者
    const byName = Object.fromEntries(listAuthors(db).map(a => [a.nickname, a.video_count]))
    expect(byName['作者AW1']).toBe(0)
    expect(byName['作者AW2']).toBe(1)
  })

  it('路径防护：../ 与 . 拒绝，目录不动、库不动', async () => {
    mkdirSync(join(tmp, '正常'), { recursive: true })
    writeFileSync(join(tmp, '正常', 'v.mp4'), 'x')
    addVideo('AW1', join(tmp, '正常', 'v.mp4'))

    const r1 = await deleteFileCategory({ db, downloadDir: tmp }, '..')
    const r2 = await deleteFileCategory({ db, downloadDir: tmp }, '.')
    const r3 = await deleteFileAuthor({ db, downloadDir: tmp }, '..', 'x')
    const r4 = await deleteFileAuthor({ db, downloadDir: tmp }, '正常', '../越界')
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(r3.ok).toBe(false)
    expect(r4.ok).toBe(false)
    expect(existsSync(join(tmp, '正常'))).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 1 })
  })

  it('目标目录不存在：rm force 忽略，仍联动清库', async () => {
    addVideo('AW1', join(tmp, '已删', 'v.mp4'))
    const r = await deleteFileCategory({ db, downloadDir: tmp }, '已删')
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(db.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 0 })
  })
})
