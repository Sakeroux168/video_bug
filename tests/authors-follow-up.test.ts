import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listAuthors } from '../src/main/db'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

// C 组：作者追更。作者列表要带出「这个博主库里最新一条视频是哪天发的」和「上次爬主页是什么时候」，
// 界面靠它们决定「只抓新视频」的起点、显示两列；顺序不能随视频数变化（体验测试里老陈因此点错过行）。

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db) })

const keyword: CreateTaskInput = {
  platform: 'xiaohongshu', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 10 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
function item(over: Partial<VideoItem> = {}): VideoItem {
  return {
    awemeId: 'N1', title: '标题', authorSecUid: 'U1', authorNickname: '博主一', authorHomeUrl: '',
    playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 1080, height: 1920,
    durationSec: 30, publishTime: 1758000000, likes: 1, comments: 0, sourceUrl: '',
    ...over
  }
}
function authorTask(secUid: string, status: string, finishedAt: string | null, filters = '{"timeRange":"all","duration":"all","targetCount":3}'): void {
  db.prepare("INSERT INTO tasks (platform, type, query, filters, status, target_count, fetched_count, auto_download, created_at, finished_at) VALUES ('xiaohongshu','author',?,?,?,3,0,1,?,?)")
    .run(secUid, filters, status, '2026-09-01T00:00:00.000Z', finishedAt)
}

describe('listAuthors：追更需要的两列', () => {
  it('latest_video_at = 该作者库里最新一条视频的发布时间（ISO）', () => {
    const t = createTask(db, keyword)
    insertVideos(db, [
      item({ awemeId: 'A', publishTime: 1758000000 }),
      item({ awemeId: 'B', publishTime: 1759000000 }),
      item({ awemeId: 'C', publishTime: 1757000000 })
    ], t, 'xiaohongshu')
    const [a] = listAuthors(db, 'xiaohongshu')
    expect(a.latest_video_at).toBe(new Date(1759000000 * 1000).toISOString())
  })

  it('没有视频的作者 latest_video_at 为 null', () => {
    db.prepare("INSERT INTO authors (platform, sec_uid, nickname) VALUES ('xiaohongshu','U9','空博主')").run()
    expect(listAuthors(db, 'xiaohongshu')[0].latest_video_at).toBeNull()
  })

  it('last_crawled_at = 该作者「爬主页」任务里最近一次完成的时间；没完成的、别人的任务不算', () => {
    const t = createTask(db, keyword)
    insertVideos(db, [item()], t, 'xiaohongshu')
    authorTask('U1', 'done', '2026-09-20T03:00:00.000Z')
    authorTask('U1', 'done', '2026-09-25T03:00:00.000Z')
    authorTask('U1', 'paused', null)
    authorTask('U2', 'done', '2026-09-28T03:00:00.000Z')
    expect(listAuthors(db, 'xiaohongshu')[0].last_crawled_at).toBe('2026-09-25T03:00:00.000Z')
  })

  it('从没爬过主页（只是关键词搜索时顺带收录）→ last_crawled_at 为 null', () => {
    const t = createTask(db, keyword)
    insertVideos(db, [item()], t, 'xiaohongshu')
    expect(listAuthors(db, 'xiaohongshu')[0].last_crawled_at).toBeNull()
  })

  it('按加入顺序稳定排列：视频数变多也不换位置', () => {
    const t = createTask(db, keyword)
    insertVideos(db, [item({ awemeId: 'A', authorSecUid: 'U1', authorNickname: '先加入' })], t, 'xiaohongshu')
    insertVideos(db, [item({ awemeId: 'B', authorSecUid: 'U2', authorNickname: '后加入' })], t, 'xiaohongshu')
    insertVideos(db, [item({ awemeId: 'C', authorSecUid: 'U2', authorNickname: '后加入' }),
      item({ awemeId: 'D', authorSecUid: 'U2', authorNickname: '后加入' })], t, 'xiaohongshu')
    expect(listAuthors(db, 'xiaohongshu').map(a => a.nickname)).toEqual(['先加入', '后加入'])
    expect(listAuthors(db).map(a => a.nickname)).toEqual(['先加入', '后加入'])
  })
})
