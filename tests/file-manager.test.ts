import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, listAuthors } from '../src/main/db'
import { scanFilesTree, scanFilesTreeAsync, deleteFileDir, deleteFileVideo, locateFileDir, locateVideoFile } from '../src/main/fileManager'
import type { FilesDirNode } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput, Filters } from '../src/shared/types'

// 文件管理：通用目录树扫描 + 任意层级删除/定位（路径防护 + DB LIKE 联动）。
//
// 归档层级是四个独立开关（品类/作者/横竖屏/时长各自可关），新装默认全关、视频平铺在下载目录根。
// 旧实现「顶层只认目录、一级=品类、二级=作者」在这些组合下要么看不见根目录的 mp4，
// 要么把「横屏」「一分钟内」当成品类/作者。这里的树不再给任何一层贴语义标签：
// 目录就是目录，视频就是视频，几层就是几层。


// 需求变更（2026-10-06 全面检查 B5）：删除改成软删除——行留着标成 deleted（记号：不再下载），
// 所以「还剩哪些行」只数没删的
const LIVE = "status != 'deleted'"
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

/** 建一条视频并落库，local_path 指向给定文件（可选封面路径） */
function addVideo(awemeId: string, path: string, coverPath?: string): number {
  const id = createTask(db, input)
  insertVideos(db, [item(awemeId, `SEC${awemeId}`, `作者${awemeId}`)], id, 'douyin')
  db.prepare('UPDATE videos SET local_path = ?, cover_path = ?, status = ? WHERE aweme_id = ?').run(path, coverPath ?? null, 'done', awemeId)
  return (db.prepare('SELECT id FROM videos WHERE aweme_id = ?').get(awemeId) as { id: number }).id
}

/** 在 tmp 下按相对段落写一个文件（自动建目录） */
function put(segments: string[], content = 'x'): string {
  const p = join(tmp, ...segments)
  mkdirSync(join(tmp, ...segments.slice(0, -1)), { recursive: true })
  writeFileSync(p, content)
  return p
}

function dir(node: FilesDirNode, name: string): FilesDirNode {
  const found = node.dirs.find(d => d.name === name)
  if (!found) throw new Error(`目录 ${name} 不在 [${node.dirs.map(d => d.name).join(', ')}] 里`)
  return found
}

const names = (node: FilesDirNode): { dirs: string[]; files: string[] } => ({
  dirs: node.dirs.map(d => d.name),
  files: node.files.map(f => f.name)
})

// —— 树扫描：各种归档层级组合 ——

describe('scanFilesTree（通用目录树）', () => {
  it('flat root：全关层级时视频平铺在下载目录根，必须直接可见并计入总量', () => {
    put(['a.mp4'], 'x'.repeat(10))
    put(['b.MP4'], 'x'.repeat(20)) // 大小写不敏感
    put(['c.jpg'], 'x'.repeat(99)) // 封面不算视频

    const tree = scanFilesTree(tmp)
    expect(tree.downloadDir).toBe(tmp)
    expect(names(tree.root)).toEqual({ dirs: [], files: ['a.mp4', 'b.MP4'] })
    expect(tree.root.files).toEqual([{ name: 'a.mp4', size: 10 }, { name: 'b.MP4', size: 20 }])
    expect(tree.root.videoCount).toBe(2)
    expect(tree.root.size).toBe(30)
    expect(tree.totalSize).toBe(30)
  })

  it('四层全开旧结构：品类/作者/横竖屏/时长 逐层可见，每层计数为递归合计', () => {
    put(['美食', '作者A', '竖屏', '一分钟内', 'v1.mp4'], 'x'.repeat(10))
    put(['美食', '作者A', '横屏', '一分钟外', 'v2.mp4'], 'x'.repeat(20))
    put(['美食', '作者B', '竖屏', '一分钟内', 'v3.mp4'], 'x'.repeat(40))
    put(['未分类', '作者C', '竖屏', '一分钟内', 'v4.mp4'], 'x'.repeat(50))

    const { root, totalSize } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['美食', '未分类'], files: [] }) // 目录按拼音排序：美(mei) < 未(wei)
    const food = dir(root, '美食')
    expect(food).toMatchObject({ videoCount: 3, size: 70 })
    const a = dir(food, '作者A')
    expect(a).toMatchObject({ videoCount: 2, size: 30 })
    expect(names(a).dirs).toEqual(['横屏', '竖屏'])
    expect(dir(dir(a, '竖屏'), '一分钟内')).toMatchObject({ videoCount: 1, size: 10, files: [{ name: 'v1.mp4', size: 10 }] })
    expect(dir(food, '作者B')).toMatchObject({ videoCount: 1, size: 40 })
    expect(dir(root, '未分类')).toMatchObject({ videoCount: 1, size: 50 })
    expect(totalSize).toBe(120)
  })

  it('仅作者：一级目录就是作者，里面直接是视频', () => {
    put(['作者A', 'v1.mp4'], 'x'.repeat(10))
    put(['作者A', 'v2.mp4'], 'x'.repeat(20))
    put(['作者B', 'v3.mp4'], 'x'.repeat(40))

    const { root } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['作者A', '作者B'], files: [] })
    expect(dir(root, '作者A')).toMatchObject({ videoCount: 2, size: 30, dirs: [], files: [{ name: 'v1.mp4', size: 10 }, { name: 'v2.mp4', size: 20 }] })
    expect(dir(root, '作者B')).toMatchObject({ videoCount: 1, size: 40 })
  })

  it('仅方向：「横屏 / 竖屏 / 未识别」是普通目录，不被当成品类或作者', () => {
    put(['横屏', 'v1.mp4'], 'x'.repeat(10))
    put(['竖屏', 'v2.mp4'], 'x'.repeat(20))
    put(['未识别', 'v3.mp4'], 'x'.repeat(30))

    const { root } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['横屏', '竖屏', '未识别'], files: [] })
    expect(dir(root, '横屏')).toMatchObject({ videoCount: 1, size: 10, dirs: [] })
    expect(dir(root, '竖屏')).toMatchObject({ videoCount: 1, size: 20, dirs: [] })
    expect(root.videoCount).toBe(3)
  })

  it('仅时长：「一分钟内 / 一分钟外」同样只是目录', () => {
    put(['一分钟内', 'v1.mp4'], 'x'.repeat(10))
    put(['一分钟外', 'v2.mp4'], 'x'.repeat(20))

    const { root } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['一分钟内', '一分钟外'], files: [] })
    expect(dir(root, '一分钟内').files).toEqual([{ name: 'v1.mp4', size: 10 }])
    expect(dir(root, '一分钟外').files).toEqual([{ name: 'v2.mp4', size: 20 }])
  })

  it('混合层级 A：作者/时长（无品类、无方向）', () => {
    put(['作者A', '一分钟内', 'v1.mp4'], 'x'.repeat(10))
    put(['作者A', '一分钟外', 'v2.mp4'], 'x'.repeat(20))

    const { root } = scanFilesTree(tmp)
    const a = dir(root, '作者A')
    expect(names(a)).toEqual({ dirs: ['一分钟内', '一分钟外'], files: [] })
    expect(a.videoCount).toBe(2)
    expect(dir(a, '一分钟外').files).toEqual([{ name: 'v2.mp4', size: 20 }])
  })

  it('混合层级 B：方向/时长（无品类、无作者）', () => {
    put(['竖屏', '一分钟内', 'v1.mp4'], 'x'.repeat(10))
    put(['横屏', '一分钟外', 'v2.mp4'], 'x'.repeat(20))

    const { root } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['横屏', '竖屏'], files: [] })
    expect(dir(dir(root, '竖屏'), '一分钟内').files).toEqual([{ name: 'v1.mp4', size: 10 }])
  })

  it('混合层级 C：品类/方向 + 同一目录里既有子目录又有直属视频，两者并存都可见', () => {
    put(['美食', '横屏', 'v1.mp4'], 'x'.repeat(10))
    put(['美食', 'v2.mp4'], 'x'.repeat(20)) // 旧版归档遗留：品类下直接放视频
    put(['root.mp4'], 'x'.repeat(5)) // 层级改成全关后新下载的平铺视频

    const { root, totalSize } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['美食'], files: ['root.mp4'] })
    const food = dir(root, '美食')
    expect(names(food)).toEqual({ dirs: ['横屏'], files: ['v2.mp4'] })
    expect(food).toMatchObject({ videoCount: 2, size: 30 })
    expect(root.videoCount).toBe(3)
    expect(totalSize).toBe(35)
  })

  it('过滤：.original.mp4 不计入、隐藏/临时 .video-*.part 与 . ~ 开头的目录文件全部忽略', () => {
    put(['v2.mp4'], 'x'.repeat(20))
    put(['v2.original.mp4'], 'x'.repeat(1000))
    put(['.video-99.download.part.mp4'], 'x'.repeat(1000))
    put(['.video-process-1.part.mp4'], 'x'.repeat(1000))
    put(['.hidden', 'x', 'v.mp4'])
    put(['~temp', 'x', 'v.mp4'])
    put(['~备份', 'v.mp4'])
    put(['readme.txt'])
    put(['作者A', 'v1.mp4'], 'x'.repeat(10))
    put(['作者A', 'v1.original.mp4'], 'x'.repeat(1000))
    put(['作者A', '.video-7.download.part.mp4'], 'x'.repeat(1000))
    put(['作者A', 'thumb.jpg'], 'x'.repeat(100))

    const { root, totalSize } = scanFilesTree(tmp)
    expect(names(root)).toEqual({ dirs: ['作者A'], files: ['v2.mp4'] })
    expect(dir(root, '作者A')).toMatchObject({ videoCount: 1, size: 10, files: [{ name: 'v1.mp4', size: 10 }] })
    expect(root.videoCount).toBe(2)
    expect(totalSize).toBe(30)
  })

  it('目录不存在 → 空树；空目录 → 空树（totalSize=0、downloadDir 回传）', () => {
    const empty: FilesDirNode = { name: '', videoCount: 0, size: 0, dirs: [], files: [] }
    expect(scanFilesTree(join(tmp, '不存在'))).toEqual({ root: empty, totalSize: 0, downloadDir: join(tmp, '不存在') })
    const emptyDir = join(tmp, 'empty')
    mkdirSync(emptyDir)
    expect(scanFilesTree(emptyDir)).toEqual({ root: empty, totalSize: 0, downloadDir: emptyDir })
  })

  it('没有视频的子目录仍然列出（用户还要能定位/删除它），计数为 0', () => {
    mkdirSync(join(tmp, '空文件夹'))
    put(['只有封面', 'c.jpg'])
    const { root } = scanFilesTree(tmp)
    expect(names(root).dirs).toEqual(['空文件夹', '只有封面'])
    expect(dir(root, '空文件夹')).toMatchObject({ videoCount: 0, size: 0 })
  })
})

// —— 定位（校验部分，shell 调用留在 ipc 层）——

describe('locateFileDir / locateVideoFile（定位校验）', () => {
  it('任意深度的目录只要在下载目录内且存在 → ok', () => {
    mkdirSync(join(tmp, '美食', '作者A', '竖屏'), { recursive: true })
    expect(locateFileDir(tmp, join(tmp, '美食'))).toEqual({ ok: true })
    expect(locateFileDir(tmp, join(tmp, '美食', '作者A', '竖屏'))).toEqual({ ok: true })
  })

  it('逃逸路径（..）与下载目录自身 → 拒绝', () => {
    mkdirSync(join(tmp, '美食'), { recursive: true })
    expect(locateFileDir(tmp, join(tmp, '..', '越界')).ok).toBe(false)
    expect(locateFileDir(tmp, join(tmp, '美食', '..', '..', '越界')).ok).toBe(false)
    expect(locateFileDir(tmp, tmp).ok).toBe(false) // root 自身不可定位（isPathInside 拒绝）
  })

  it('目录不存在或目标是文件 → 错误提示（不触 shell）', () => {
    expect(locateFileDir(tmp, join(tmp, '不存在'))).toEqual({ ok: false, error: '目录不存在' })
    writeFileSync(join(tmp, 'v.mp4'), 'x')
    expect(locateFileDir(tmp, join(tmp, 'v.mp4'))).toEqual({ ok: false, error: '目录不存在' })
  })

  it('定位视频文件：根目录与深层文件都可以；目录、越界、不存在一律拒绝', () => {
    put(['v.mp4'])
    put(['美食', '作者A', 'v2.mp4'])
    expect(locateVideoFile(tmp, join(tmp, 'v.mp4'))).toEqual({ ok: true })
    expect(locateVideoFile(tmp, join(tmp, '美食', '作者A', 'v2.mp4'))).toEqual({ ok: true })
    expect(locateVideoFile(tmp, join(tmp, '美食'))).toEqual({ ok: false, error: '文件不存在' })
    expect(locateVideoFile(tmp, join(tmp, '没有.mp4'))).toEqual({ ok: false, error: '文件不存在' })
    expect(locateVideoFile(tmp, join(tmp, '..', 'v.mp4')).ok).toBe(false)
    expect(locateVideoFile(tmp, tmp).ok).toBe(false)
  })
})

// —— 删除目录（任意层级）——

describe('deleteFileDir（递归删除任意层级目录 + DB 联动）', () => {
  it('删一级目录：文件夹递归消失 + 该路径前缀 videos 行删光 + 作者 video_count 重算', async () => {
    const dirA = join(tmp, '美食', '作者A')
    const dirB = join(tmp, '美食', '作者B')
    put(['美食', '作者A', '桶', 'v1.mp4'])
    put(['美食', '作者A', 'v2.mp4'])
    put(['美食', '作者B', 'v3.mp4'])
    addVideo('AW1', join(dirA, '桶', 'v1.mp4'))
    addVideo('AW2', join(dirA, 'v2.mp4'))
    addVideo('AW3', join(dirB, 'v3.mp4'))

    const r = await deleteFileDir({ db, downloadDir: tmp }, ['美食'])
    expect(r).toEqual({ ok: true, deleted: 3, filesRemoved: true })
    expect(existsSync(join(tmp, '美食'))).toBe(false)
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 0 })
    expect(listAuthors(db).every(a => a.video_count === 0)).toBe(true)
  })

  it('删二级目录：只删该目录与对应行，同级其它目录与行保留', async () => {
    const dirA = join(tmp, '美食', '作者A')
    const dirB = join(tmp, '美食', '作者B')
    put(['美食', '作者A', 'v1.mp4'])
    put(['美食', '作者A', 'v2.mp4'])
    put(['美食', '作者B', 'v3.mp4'])
    addVideo('AW1', join(dirA, 'v1.mp4'))
    addVideo('AW2', join(dirA, 'v2.mp4'))
    addVideo('AW3', join(dirB, 'v3.mp4'))

    const r = await deleteFileDir({ db, downloadDir: tmp }, ['美食', '作者A'])
    expect(r).toEqual({ ok: true, deleted: 2, filesRemoved: true })
    expect(existsSync(dirA)).toBe(false)
    expect(existsSync(dirB)).toBe(true)
    const rest = listVideos(db, 1).concat(listVideos(db, 2), listVideos(db, 3))
    expect(rest).toHaveLength(1)
    expect(rest[0].aweme_id).toBe('AW3')
    const byName = Object.fromEntries(listAuthors(db).map(a => [a.nickname, a.video_count]))
    expect(byName['作者AW1']).toBe(0)
    expect(byName['作者AW3']).toBe(1)
  })

  it('删四层深处的时长桶目录（旧四层结构）：只影响那一个桶', async () => {
    const inner = join(tmp, '美食', '作者A', '竖屏', '一分钟内')
    const outer = join(tmp, '美食', '作者A', '竖屏', '一分钟外')
    put(['美食', '作者A', '竖屏', '一分钟内', 'v1.mp4'])
    put(['美食', '作者A', '竖屏', '一分钟外', 'v2.mp4'])
    addVideo('AW1', join(inner, 'v1.mp4'))
    addVideo('AW2', join(outer, 'v2.mp4'))

    const r = await deleteFileDir({ db, downloadDir: tmp }, ['美食', '作者A', '竖屏', '一分钟内'])
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(existsSync(inner)).toBe(false)
    expect(existsSync(join(outer, 'v2.mp4'))).toBe(true)
    expect((db.prepare(`SELECT aweme_id FROM videos WHERE ${LIVE}`).all() as Array<{ aweme_id: string }>).map(r => r.aweme_id)).toEqual(['AW2'])
  })

  it('仅方向层级：删「横屏」目录不会把它当品类，也不碰根目录平铺视频', async () => {
    put(['横屏', 'v1.mp4'])
    put(['root.mp4'])
    addVideo('AW1', join(tmp, '横屏', 'v1.mp4'))
    addVideo('AW2', join(tmp, 'root.mp4'))

    const r = await deleteFileDir({ db, downloadDir: tmp }, ['横屏'])
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(existsSync(join(tmp, 'root.mp4'))).toBe(true)
    expect((db.prepare(`SELECT aweme_id FROM videos WHERE ${LIVE}`).all() as Array<{ aweme_id: string }>).map(r => r.aweme_id)).toEqual(['AW2'])
  })

  it('LIKE 转义：目录名含 % 或 _ 时不误删其它目录的行', async () => {
    put(['50%折扣', 'x', 'v.mp4'])
    put(['50打折', 'x', 'v.mp4'])
    put(['美食_A', 'x', 'v.mp4'])
    put(['美食XA', 'x', 'v.mp4'])
    addVideo('AW1', join(tmp, '50%折扣', 'x', 'v.mp4'))
    addVideo('AW2', join(tmp, '50打折', 'x', 'v.mp4'))
    addVideo('AW3', join(tmp, '美食_A', 'x', 'v.mp4'))
    addVideo('AW4', join(tmp, '美食XA', 'x', 'v.mp4'))

    expect(await deleteFileDir({ db, downloadDir: tmp }, ['50%折扣'])).toMatchObject({ ok: true, deleted: 1 })
    expect(await deleteFileDir({ db, downloadDir: tmp }, ['美食_A'])).toMatchObject({ ok: true, deleted: 1 })
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 2 })
    const left = db.prepare(`SELECT aweme_id FROM videos WHERE ${LIVE} ORDER BY aweme_id`).all() as Array<{ aweme_id: string }>
    expect(left.map(r => r.aweme_id).sort()).toEqual(['AW2', 'AW4'])
  })

  it('前缀碰撞：删「美食」不误删「美食家」的行（LIKE 前缀必须目录分隔符收尾）', async () => {
    put(['美食', 'x', 'v.mp4'])
    put(['美食家', 'x', 'v.mp4'])
    addVideo('AW1', join(tmp, '美食', 'x', 'v.mp4'))
    addVideo('AW2', join(tmp, '美食家', 'x', 'v.mp4'))

    const r = await deleteFileDir({ db, downloadDir: tmp }, ['美食'])
    expect(r).toMatchObject({ ok: true, deleted: 1 })
    expect(existsSync(join(tmp, '美食家'))).toBe(true)
    const left = db.prepare(`SELECT aweme_id FROM videos WHERE ${LIVE}`).all() as Array<{ aweme_id: string }>
    expect(left.map(x => x.aweme_id)).toEqual(['AW2'])
    const byName = Object.fromEntries(listAuthors(db).map(a => [a.nickname, a.video_count]))
    expect(byName['作者AW1']).toBe(0)
    expect(byName['作者AW2']).toBe(1)
  })

  it('路径防护：空段、.、..、含分隔符的段、空数组一律拒绝，目录不动、库不动', async () => {
    put(['正常', 'v.mp4'])
    addVideo('AW1', join(tmp, '正常', 'v.mp4'))

    const bad: string[][] = [[], ['..'], ['.'], [''], ['正常', '../越界'], ['正常', '..'], ['a/b'], ['a\\b'], ['正常', '']]
    for (const segments of bad) {
      const r = await deleteFileDir({ db, downloadDir: tmp }, segments)
      expect(r.ok, JSON.stringify(segments)).toBe(false)
    }
    expect(existsSync(join(tmp, '正常', 'v.mp4'))).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 1 })
  })

  it('目标目录不存在：rm force 忽略，仍联动清库', async () => {
    addVideo('AW1', join(tmp, '已删', 'v.mp4'))
    const r = await deleteFileDir({ db, downloadDir: tmp }, ['已删'])
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 0 })
  })
})

// —— 删除单个视频文件 ——

describe('deleteFileVideo（删除单个视频 + DB 联动）', () => {
  it('根目录平铺视频有库记录：视频与封面一起删，行删掉，作者计数重算', async () => {
    const video = put(['v1.mp4'])
    const cover = put(['v1.jpg'])
    put(['v2.mp4'])
    const id = addVideo('AW1', video, cover)
    addVideo('AW2', join(tmp, 'v2.mp4'))
    const cancelled: number[][] = []

    const r = await deleteFileVideo({ db, downloadDir: tmp, downloader: { cancel: ids => cancelled.push(ids) } }, ['v1.mp4'])
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(cancelled).toEqual([[id]]) // 沿用 video:delete 语义：先掐断可能的在途/排队项
    expect(existsSync(video)).toBe(false)
    expect(existsSync(cover)).toBe(false)
    expect(existsSync(join(tmp, 'v2.mp4'))).toBe(true)
    const left = db.prepare(`SELECT aweme_id FROM videos WHERE ${LIVE}`).all() as Array<{ aweme_id: string }>
    expect(left.map(x => x.aweme_id)).toEqual(['AW2'])
    const byName = Object.fromEntries(listAuthors(db).map(a => [a.nickname, a.video_count]))
    expect(byName['作者AW1']).toBe(0)
    expect(byName['作者AW2']).toBe(1)
  })

  it('深层目录里的视频文件同样按段落定位删除', async () => {
    const video = put(['作者A', '一分钟内', 'v1.mp4'])
    const sibling = put(['作者A', '一分钟内', 'v2.mp4'])
    addVideo('AW1', video)
    addVideo('AW2', sibling)

    const r = await deleteFileVideo({ db, downloadDir: tmp }, ['作者A', '一分钟内', 'v1.mp4'])
    expect(r).toEqual({ ok: true, deleted: 1, filesRemoved: true })
    expect(existsSync(video)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 1 })
  })

  it('磁盘上有文件但库里没有记录（手动拷进来的）：只删文件，deleted=0', async () => {
    const video = put(['orphan.mp4'])
    const r = await deleteFileVideo({ db, downloadDir: tmp }, ['orphan.mp4'])
    expect(r).toEqual({ ok: true, deleted: 0, filesRemoved: true })
    expect(existsSync(video)).toBe(false)
  })

  it('路径防护：越界、非 mp4、.original.mp4、目录、不存在 → 拒绝且不动库', async () => {
    put(['v.mp4'])
    put(['v.original.mp4'])
    put(['c.jpg'])
    mkdirSync(join(tmp, '文件夹.mp4'))
    addVideo('AW1', join(tmp, 'v.mp4'))

    const bad: string[][] = [[], ['..', 'v.mp4'], ['../v.mp4'], ['c.jpg'], ['v.original.mp4'], ['文件夹.mp4'], ['没有.mp4'], ['']]
    for (const segments of bad) {
      const r = await deleteFileVideo({ db, downloadDir: tmp }, segments)
      expect(r.ok, JSON.stringify(segments)).toBe(false)
    }
    expect(existsSync(join(tmp, 'v.mp4'))).toBe(true)
    expect(existsSync(join(tmp, 'v.original.mp4'))).toBe(true)
    expect(existsSync(join(tmp, 'c.jpg'))).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) c FROM videos WHERE ${LIVE}`).get()).toEqual({ c: 1 })
  })
})

// 2026-10-06 全面检查「性能」C2：以前在主进程同步扫整个下载目录，2 万个文件时整个软件卡 2 秒
describe('scanFilesTreeAsync（不卡主进程的扫描）', () => {
  function bigTree(): string {
    const d = mkdtempSync(join(tmpdir(), 'fm-async-'))
    for (const cat of ['美食', '搞笑']) {
      for (let a = 0; a < 5; a++) {
        const sub = join(d, cat, `作者${a}`)
        mkdirSync(sub, { recursive: true })
        for (let i = 0; i < 40; i++) writeFileSync(join(sub, `v${i}.mp4`), Buffer.alloc(i + 1))
        writeFileSync(join(sub, 'v0.jpg'), 'cover')
      }
    }
    writeFileSync(join(d, '根目录.mp4'), 'abc')
    mkdirSync(join(d, '.隐藏'))
    writeFileSync(join(d, '.video-1.download.part.mp4'), 'x')
    return d
  }

  it('结果和同步版完全一样', async () => {
    const d = bigTree()
    try {
      expect(await scanFilesTreeAsync(d)).toEqual(scanFilesTree(d))
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('扫描期间别的事情照样能跑（不会一口气占住主进程）', async () => {
    const d = bigTree()
    try {
      let done = false
      const p = scanFilesTreeAsync(d).then(t => { done = true; return t })
      await new Promise(r => setImmediate(r))
      expect(done).toBe(false)
      expect((await p).root.videoCount).toBe(401)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('下载目录不存在 → 空树，不报错', async () => {
    const t = await scanFilesTreeAsync(join(tmpdir(), '不存在的目录-' + Date.now()))
    expect(t.root).toMatchObject({ videoCount: 0, size: 0, dirs: [], files: [] })
  })
})
