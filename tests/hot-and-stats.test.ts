import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, refreshSeenVideo } from '../src/main/db'
import { filterVideos } from '../src/main/extractor'
import { Scheduler as RealScheduler } from '../src/main/scheduler'
import { buildVideosCsv, toVideoExportRows } from '../src/shared/videosCsv'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput, Filters, VideoRow } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-hot-and-stats' } }))

// 2026-10-07 功能 N02 / N05：只抓热门（点赞 / 收藏门槛）+ 互动数补全（收藏、分享、播放）

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 20 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (awemeId: string, over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId, title: 't', authorSecUid: 'S', authorNickname: 'a', authorHomeUrl: 'h', playUrl: 'p', coverUrl: '',
  width: 0, height: 0, durationSec: 10, publishTime: Math.floor(Date.now() / 1000) - 3600, likes: 0, ...over
})
const all: Filters = { timeRange: 'all', duration: 'all', targetCount: 20 }

describe('N05 互动数存下来', () => {
  it('入库时收藏、分享、播放写进 stats；拿不到的不写', () => {
    const db = new DatabaseSync(':memory:'); initDb(db)
    const t = createTask(db, input)
    insertVideos(db, [item('A', { likes: 10, comments: 2, collects: 3, shares: 4, plays: 500 }), item('B', { likes: 1 })], t, 'douyin')
    const [a, b] = listVideos(db, t)
    expect(JSON.parse(a.stats)).toEqual({ likes: 10, comments: 2, collects: 3, shares: 4, plays: 500 })
    expect(JSON.parse(b.stats)).toEqual({ likes: 1 })
  })

  it('再抓到时更新这些数，并记下更新时间；这次拿不到的不清掉', () => {
    const db = new DatabaseSync(':memory:'); initDb(db)
    const t = createTask(db, input)
    insertVideos(db, [item('A', { likes: 10, collects: 3, shares: 4 })], t, 'douyin')
    refreshSeenVideo(db, 'douyin', item('A', { likes: 99, collects: 30 }))
    const s = JSON.parse(listVideos(db, t)[0].stats)
    expect(s).toMatchObject({ likes: 99, collects: 30, shares: 4 })
    expect(typeof s.updatedAt).toBe('string')
  })
})

describe('N02 点赞 / 收藏门槛', () => {
  it('最少点赞：不够的筛掉', () => {
    const out = filterVideos([item('A', { likes: 50 }), item('B', { likes: 100 }), item('C', { likes: 1000 })], { ...all, minLikes: 100 })
    expect(out.map(i => i.awemeId)).toEqual(['B', 'C'])
  })
  it('最少收藏：不够的、不知道收藏数的都筛掉', () => {
    const out = filterVideos([item('A', { collects: 5 }), item('B', { collects: 20 }), item('C')], { ...all, minCollects: 10 })
    expect(out.map(i => i.awemeId)).toEqual(['B'])
  })
  it('没设门槛（或设 0）不影响', () => {
    expect(filterVideos([item('A'), item('B', { likes: 3 })], { ...all, minLikes: 0 })).toHaveLength(2)
  })

  it('小红书在列表阶段就按门槛筛：不够的不进候选（少开详情页）；不知道点赞数的留给详情阶段再判', () => {
    const db = new DatabaseSync(':memory:'); initDb(db)
    const S = RealScheduler as unknown as new (deps: Record<string, unknown>) => RealScheduler
    const s = new S({
      db, browser: {}, downloader: { onEvent: () => {} }, analyzer: null, emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'fast', scrollPageWaitMs: 1, scrollIntervalMs: 1 }), getStallThresholdSec: () => 1
    }) as unknown as { filters: Filters; listStubs: Map<string, unknown>; mergeListStubs: (r: unknown) => number; thresholdSkipped: number }
    s.filters = { ...all, minLikes: 100, minCollects: 10 }
    const stub = (noteId: string, likes: number | null, collects?: number | null) =>
      ({ noteId, detailToken: 't', title: '', authorId: 'u', authorNickname: 'n', coverUrl: '', likes, comments: null, collects })
    s.mergeListStubs({ stubs: [stub('LOW', 5, 50), stub('NOCOLLECT', 500, 2), stub('OK', 500, 50), stub('UNKNOWN', null)], skipped: { image: 0, other: 0 } })
    expect([...s.listStubs.keys()]).toEqual(['OK', 'UNKNOWN'])
    expect(s.thresholdSkipped).toBe(2)
  })
})

describe('N05 导出表格加列', () => {
  it('表头多了收藏、分享、播放、发布时间；不知道的留空', () => {
    const row = (stats: string): VideoRow => ({
      id: 1, platform: 'douyin', task_id: 1, aweme_id: 'a', title: '标题', author_id: 1, play_addr: null, source_url: 'u',
      cover_url: null, cover_path: null, original_path: null, normalization_error: null, video_width: 0, video_height: 0,
      duration: 10, publish_time: '2026-10-01T08:00:00.000Z', stats, ai_verdict: null, ai_tags: null, status: 'done',
      local_path: null, file_size: null, error: null, retry_count: 0, fetched_at: '', downloaded_at: null, author_nickname: '作者'
    } as VideoRow)
    const csv = buildVideosCsv(toVideoExportRows([row('{"likes":10,"comments":2,"collects":3,"shares":4,"plays":5}'), row('{"likes":1}')], p => p))
    const [header, a, b] = csv.split('\r\n')
    expect(header).toBe('平台,作者,标题,作品链接,点赞,评论,收藏,分享,播放,发布时间,时长(秒),本地文件名')
    expect(a).toBe('douyin,作者,标题,u,10,2,3,4,5,2026-10-01,10,')
    expect(b).toBe('douyin,作者,标题,u,1,,,,,2026-10-01,10,')
  })
})
