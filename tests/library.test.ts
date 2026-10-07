import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus, listDownloadedVideos } from '../src/main/db'
import { listLibrary, listLibraryTasks, setVideoMark, setVideoNote, coverFileFor, videoFileFor, exportLibraryVideos } from '../src/main/library'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 2026-10-07 功能 E（素材库，N07 / N08）：按数据库浏览下载过的视频，筛选、排序、标记

let db: DatabaseSync
let dir: string
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db); dir = mkdtempSync(join(tmpdir(), 'lib-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const input = (platform: string, query: string): CreateTaskInput => ({
  platform, type: 'keyword', query, filters: { timeRange: 'all', duration: 'all', targetCount: 20 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
})
const item = (awemeId: string, over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId, title: '标题' + awemeId, authorSecUid: 'S' + awemeId, authorNickname: '作者' + awemeId, authorHomeUrl: 'h',
  playUrl: 'p', coverUrl: '', width: 1080, height: 1920, durationSec: 30, publishTime: 1700000000, likes: 0, ...over
})

/** 造一批视频：done 的带真文件和封面，另有一条没下载完的 */
function seed() {
  const t1 = createTask(db, input('douyin', '猫咪'))
  const t2 = createTask(db, input('xiaohongshu', '减脂餐'))
  insertVideos(db, [item('A', { title: '橘猫日常', likes: 100, collects: 5, publishTime: 1700000000 }), item('B', { title: '黑猫', likes: 9000, collects: 50, publishTime: 1710000000 })], t1, 'douyin')
  insertVideos(db, [item('C', { title: '低卡便当', likes: 500, collects: 900, publishTime: 1705000000 }), item('D', { title: '没下完', likes: 99999 })], t2, 'xiaohongshu')
  const rows = [...listVideos(db, t1), ...listVideos(db, t2)]
  rows.forEach((v, i) => {
    if (v.aweme_id === 'D') { setVideoStatus(db, v.id, 'failed'); return }
    const p = join(dir, `${v.aweme_id}.mp4`); writeFileSync(p, 'mp4')
    const c = join(dir, `${v.aweme_id}.jpg`); writeFileSync(c, 'jpg')
    setVideoStatus(db, v.id, 'done', { local_path: p, cover_path: c, downloaded_at: `2026-10-0${i + 1}T00:00:00.000Z` })
  })
  const id = (aw: string) => rows.find(r => r.aweme_id === aw)!.id
  return { t1, t2, id }
}

describe('素材库列表', () => {
  it('只列下载完成的视频；默认最近下载的在前；带作者名、所属任务关键词和平台', () => {
    seed()
    const r = listLibrary(db, {})
    expect(r.total).toBe(3)
    expect(r.rows.map(v => v.aweme_id)).toEqual(['C', 'B', 'A'])
    expect(r.rows[0]).toMatchObject({ author_nickname: '作者C', task_query: '减脂餐', platform: 'xiaohongshu' })
  })

  it('按点赞 / 收藏 / 发布时间排序', () => {
    seed()
    expect(listLibrary(db, { sort: 'likes' }).rows.map(v => v.aweme_id)).toEqual(['B', 'C', 'A'])
    expect(listLibrary(db, { sort: 'collects' }).rows.map(v => v.aweme_id)).toEqual(['C', 'B', 'A'])
    expect(listLibrary(db, { sort: 'published' }).rows.map(v => v.aweme_id)).toEqual(['B', 'C', 'A'])
  })

  it('按平台、任务、标题 / 作者关键字筛选（% 和 _ 按字面匹配）', () => {
    const { t1 } = seed()
    expect(listLibrary(db, { platform: 'douyin' }).rows.map(v => v.aweme_id).sort()).toEqual(['A', 'B'])
    expect(listLibrary(db, { taskId: t1 }).total).toBe(2)
    expect(listLibrary(db, { search: '猫' }).rows.map(v => v.aweme_id).sort()).toEqual(['A', 'B'])
    expect(listLibrary(db, { search: '作者C' }).rows.map(v => v.aweme_id)).toEqual(['C'])
    expect(listLibrary(db, { search: '%' }).total).toBe(0)
  })

  it('分页：每页条数 + 第几页', () => {
    seed()
    const p1 = listLibrary(db, { pageSize: 2, page: 1 })
    const p2 = listLibrary(db, { pageSize: 2, page: 2 })
    expect(p1.total).toBe(3)
    expect(p1.rows).toHaveLength(2)
    expect(p2.rows).toHaveLength(1)
  })

  it('任务下拉：只列有下载完成视频的任务', () => {
    seed()
    expect(listLibraryTasks(db).map(t => t.query).sort()).toEqual(['减脂餐', '猫咪'])
  })
})

describe('素材标记', () => {
  it('星标 / 待用 / 已用 可以批量打、可以清掉；按标记筛选；「没标记」也能筛', () => {
    const { id } = seed()
    setVideoMark(db, [id('A'), id('B')], 'used')
    setVideoMark(db, [id('C')], 'star')
    expect(listLibrary(db, { mark: 'used' }).rows.map(v => v.aweme_id).sort()).toEqual(['A', 'B'])
    expect(listLibrary(db, { mark: 'star' }).rows[0]).toMatchObject({ aweme_id: 'C', mark: 'star' })
    setVideoMark(db, [id('A')], null)
    expect(listLibrary(db, { mark: 'none' }).rows.map(v => v.aweme_id)).toEqual(['A'])
  })

  it('不认识的标记值不写', () => {
    const { id } = seed()
    expect(() => setVideoMark(db, [id('A')], 'hack' as never)).toThrow()
  })

  it('备注：写、改、清空（只留空白算清空）；能按备注内容搜', () => {
    const { id } = seed()
    setVideoNote(db, id('A'), '  开头 3 秒能用  ')
    expect(listLibrary(db, { search: '开头' }).rows[0]).toMatchObject({ aweme_id: 'A', note: '开头 3 秒能用' })
    setVideoNote(db, id('A'), '   ')
    expect(listLibrary(db, { search: '开头' }).total).toBe(0)
  })
})

describe('封面 / 视频文件只按视频 id 从库里找（界面不能传路径进来）', () => {
  it('封面存在且是图片 → 返回路径；不存在、不是图片、id 不对 → null', () => {
    const { id } = seed()
    expect(coverFileFor(db, id('A'))).toMatch(/A\.jpg$/)
    expect(coverFileFor(db, 99999)).toBeNull()
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(join(dir, 'A.mp4'), id('A'))
    expect(coverFileFor(db, id('A'))).toBeNull()
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(join(dir, 'gone.jpg'), id('B'))
    expect(coverFileFor(db, id('B'))).toBeNull()
  })

  it('视频文件：下载完成、文件在、是 mp4 → 返回路径', () => {
    const { id } = seed()
    expect(videoFileFor(db, id('A'))).toMatch(/A\.mp4$/)
    rmSync(join(dir, 'A.mp4'))
    expect(videoFileFor(db, id('A'))).toBeNull()
  })
})

// 2026-10-07 素材库第二部分：多选 →「打包交付」——复制到选的文件夹 + 来源清单.csv；原文件不动
describe('打包交付', () => {
  it('复制选中的视频到目标文件夹，附「来源清单.csv」（带 BOM，有标题、作者、关键词、交付后的文件名）；原文件还在', async () => {
    const { id } = seed()
    const out = join(dir, '交付'); mkdirSync(out)
    const r = await exportLibraryVideos(db, [id('B'), id('A')], out, { markUsed: false })
    expect(r).toMatchObject({ copied: 2, missing: 0, failed: 0 })
    expect(readdirSync(out).sort()).toEqual(['A.mp4', 'B.mp4', '来源清单.csv'])
    expect(readFileSync(join(dir, 'A.mp4'), 'utf8')).toBe('mp4')
    const csv = readFileSync(r.csvPath!, 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('本地文件名')
    expect(lines[1]).toContain('黑猫')
    expect(lines[1]).toContain('作者B')
    expect(lines[1]).toContain('猫咪')
    expect(lines[1]).toContain('B.mp4')
  })

  it('目标文件夹里已有同名文件 → 新的改名，不覆盖；清单也不覆盖', async () => {
    const { id } = seed()
    const out = join(dir, '交付'); mkdirSync(out)
    writeFileSync(join(out, 'A.mp4'), 'old')
    writeFileSync(join(out, '来源清单.csv'), 'old')
    const r = await exportLibraryVideos(db, [id('A')], out, { markUsed: false })
    expect(readFileSync(join(out, 'A.mp4'), 'utf8')).toBe('old')
    expect(readFileSync(join(out, 'A_1.mp4'), 'utf8')).toBe('mp4')
    expect(readFileSync(join(out, '来源清单.csv'), 'utf8')).toBe('old')
    expect(r.csvPath).toMatch(/来源清单 \(1\)\.csv$/)
    expect(readFileSync(r.csvPath!, 'utf8')).toContain('A_1.mp4')
  })

  it('勾了「交付后标为已用」→ 复制成功的标成已用；文件找不到的算缺失、不标', async () => {
    const { id } = seed()
    rmSync(join(dir, 'B.mp4'))
    const out = join(dir, '交付'); mkdirSync(out)
    const r = await exportLibraryVideos(db, [id('A'), id('B')], out, { markUsed: true })
    expect(r).toMatchObject({ copied: 1, missing: 1 })
    expect(listLibrary(db, { mark: 'used' }).rows.map(v => v.aweme_id)).toEqual(['A'])
  })

  it('一条都没复制成 → 不生成清单', async () => {
    const { id } = seed()
    rmSync(join(dir, 'A.mp4'))
    const out = join(dir, '交付'); mkdirSync(out)
    const r = await exportLibraryVideos(db, [id('A')], out, { markUsed: false })
    expect(r).toMatchObject({ copied: 0, missing: 1, csvPath: null })
    expect(readdirSync(out)).toEqual([])
  })

  it('目标文件夹不存在 → 报错', async () => {
    const { id } = seed()
    await expect(exportLibraryVideos(db, [id('A')], join(dir, '没有'), { markUsed: false })).rejects.toThrow('文件夹不存在')
  })
})

// 2026-10-07 性能 F9：「导出全部」以前把每条视频的所有列（包括很长的下载地址、封面地址）整包传给界面，
// 10 万条要 95MB。现在只查表格要用的几列。
describe('导出用的已下载视频列表只带要用的列', () => {
  it('有标题、作者、链接、点赞、本地路径；没有下载地址、封面地址', () => {
    seed()
    const rows = listDownloadedVideos(db)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ title: '橘猫日常', author_nickname: '作者A', platform: 'douyin' })
    expect(rows[0].local_path).toMatch(/A\.mp4$/)
    expect('play_addr' in rows[0]).toBe(false)
    expect('cover_url' in rows[0]).toBe(false)
  })
})
