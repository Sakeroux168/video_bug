import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, listVideos } from '../src/main/db'
import { Scheduler as RealScheduler } from '../src/main/scheduler'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { xiaohongshuAdapter } from '../src/main/adapters/xiaohongshu'
import type { Filters } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-native-sort' } }))

// 2026-10-07 N01：按最多点赞 / 最新排序抓（真机：抖音选「最多点赞」后搜索接口带 sort_type=1，「最新发布」带 sort_type=2；
// 小红书筛选面板「排序依据」有 综合 / 最新 / 最多点赞 / 最多评论 / 最多收藏）

const base: Filters = { timeRange: 'all', duration: 'all', targetCount: 20 }

describe('适配器：排序 → 网页筛选面板上的选项', () => {
  it('小红书：排序依据 + 笔记类型视频', () => {
    expect(xiaohongshuAdapter.nativeSearchFilters!('keyword', { ...base, sortBy: 'mostLiked' }))
      .toEqual([{ group: '排序依据', option: '最多点赞' }, { group: '笔记类型', option: '视频' }])
    expect(xiaohongshuAdapter.nativeSearchFilters!('keyword', { ...base, sortBy: 'mostCollected' })[0]).toEqual({ group: '排序依据', option: '最多收藏' })
    expect(xiaohongshuAdapter.nativeSearchFilters!('keyword', { ...base, sortBy: 'latest' })[0]).toEqual({ group: '排序依据', option: '最新' })
    expect(xiaohongshuAdapter.nativeSearchFilters!('keyword', base)).toEqual([{ group: '笔记类型', option: '视频' }])
  })

  it('抖音：只在搜索时排序，作者主页不点；没选排序就什么都不点', () => {
    expect(douyinAdapter.nativeSearchFilters!('keyword', { ...base, sortBy: 'mostLiked' })).toEqual([{ group: '排序依据', option: '最多点赞' }])
    expect(douyinAdapter.nativeSearchFilters!('hashtag', { ...base, sortBy: 'latest' })).toEqual([{ group: '排序依据', option: '最新发布' }])
    expect(douyinAdapter.nativeSearchFilters!('author', { ...base, sortBy: 'mostLiked' })).toEqual([])
    expect(douyinAdapter.nativeSearchFilters!('keyword', base)).toEqual([])
  })

  it('各平台能选哪些排序', () => {
    expect(douyinAdapter.sortOptions).toEqual(['mostLiked', 'latest'])
    expect(xiaohongshuAdapter.sortOptions).toEqual(['mostLiked', 'mostCollected', 'mostCommented', 'latest'])
  })

  it('抖音：选了排序就开「视频」标签页（只有这页的接口带 sort_type）；没选还是原来的搜索页', () => {
    expect(douyinAdapter.buildSearchUrl('猫咪', { ...base, sortBy: 'mostLiked' })).toBe('https://www.douyin.com/search/%E7%8C%AB%E5%92%AA?type=video')
    expect(douyinAdapter.buildSearchUrl('猫咪', base)).toBe('https://www.douyin.com/search/%E7%8C%AB%E5%92%AA')
  })

  it('抖音：截到的地址是相对路径也认', () => {
    expect(douyinAdapter.acceptsSortedResponse!('/aweme/v1/web/search/item/?device_platform=webapp&sort_type=1', { ...base, sortBy: 'mostLiked' })).toBe(true)
  })

  it('抖音：认得哪批搜索结果是按要求排过序的', () => {
    const f = { ...base, sortBy: 'mostLiked' as const }
    expect(douyinAdapter.acceptsSortedResponse!('https://www.douyin.com/aweme/v1/web/search/item/?sort_type=1&offset=0', f)).toBe(true)
    expect(douyinAdapter.acceptsSortedResponse!('https://www.douyin.com/aweme/v1/web/search/item/?sort_type=0&offset=0', f)).toBe(false)
    expect(douyinAdapter.acceptsSortedResponse!('https://www.douyin.com/aweme/v1/web/general/search/stream/?aid=1', f)).toBe(false)
    expect(douyinAdapter.acceptsSortedResponse!('https://www.douyin.com/aweme/v1/web/search/item/?sort_type=2', { ...base, sortBy: 'latest' })).toBe(true)
  })
})

describe('调度器：抖音按排序抓', () => {
  const aweme = (id: string, likes: number) => ({
    aweme_id: id, desc: '标题' + id, create_time: Math.floor(Date.now() / 1000) - 60,
    author: { sec_uid: 'SEC' + id, nickname: '作者' }, video: { play_addr: { url_list: [`https://cdn.test/${id}.mp4`] } },
    statistics: { digg_count: likes, comment_count: 1 }, duration: 8000
  })

  function setup(applied: boolean) {
    const db = new DatabaseSync(':memory:'); initDb(db)
    const taskId = createTask(db, {
      platform: 'douyin', type: 'keyword', query: '猫咪', filters: { ...base, targetCount: 2, sortBy: 'mostLiked' },
      aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: false
    })
    let s!: RealScheduler
    const calls: unknown[] = []
    const browser = {
      load: vi.fn(async () => {
        // 页面一打开先按「综合」排序返回一批（还没点排序）
        await s.handleRaw(douyinAdapter, 'https://www.douyin.com/aweme/v1/web/search/item/?sort_type=0&offset=0', { data: [{ aweme_info: aweme('UNSORTED', 5) }] })
      }),
      applyNativeSearchFilters: vi.fn(async (f: unknown) => {
        calls.push(f)
        if (applied) {
          await s.handleRaw(douyinAdapter, 'https://www.douyin.com/aweme/v1/web/search/item/?sort_type=1&offset=0',
            { data: [{ aweme_info: aweme('HOT1', 90000) }, { aweme_info: aweme('HOT2', 80000) }] })
        }
        return { applied, noteIds: [] }
      }),
      scrollToBottom: vi.fn(async () => {}), abortScroll: vi.fn(), findBottomText: vi.fn(async () => null),
      findVerifyIndicator: vi.fn(async () => null), findLoginIndicator: vi.fn(async () => null), resetPage: vi.fn()
    }
    const S = RealScheduler as unknown as new (deps: Record<string, unknown>) => RealScheduler
    s = new S({
      db, browser, analyzer: null, downloader: { onEvent: () => {}, enqueue: () => {} }, emit: () => {},
      getScrollParams: () => ({ scrollSpeed: 'fast', scrollPageWaitMs: 1, scrollIntervalMs: 1 }), getStallThresholdSec: () => 0.05
    })
    return { db, taskId, s, calls }
  }

  it('点上了「最多点赞」：只收排过序的那批，页面一开始按综合排序返回的不要', async () => {
    const { db, taskId, s, calls } = setup(true)
    await s.run(taskId)
    expect(calls).toEqual([[{ group: '排序依据', option: '最多点赞' }]])
    expect(listVideos(db, taskId).map(v => v.aweme_id).sort()).toEqual(['HOT1', 'HOT2'])
  })

  it('没点上：照常按综合排序抓（不能因为排序失败就一条都不收）', async () => {
    const { db, taskId, s } = setup(false)
    const p = s.run(taskId)
    await new Promise(r => setTimeout(r, 50))
    await s.handleRaw(douyinAdapter, 'https://www.douyin.com/aweme/v1/web/search/item/?sort_type=0&offset=16', { data: [{ aweme_info: aweme('LATER', 7) }] })
    await s.pause()
    await p
    expect(listVideos(db, taskId).map(v => v.aweme_id)).toContain('LATER')
  })
})
