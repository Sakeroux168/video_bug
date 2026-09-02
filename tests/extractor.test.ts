import { describe, it, expect } from 'vitest'
import { filterVideos, matchTimeRange, matchDuration, dedupeVideos } from '../src/main/extractor'
import type { VideoItem } from '../src/main/adapters/types'
import type { Filters } from '../src/shared/types'

const NOW = 1720000000 // 基准时间
const day = 86400
const item = (over: Partial<VideoItem>): VideoItem => ({
  awemeId: '1', title: 't', authorSecUid: 's', authorNickname: 'n', authorHomeUrl: 'h',
  playUrl: 'p', durationSec: 120, publishTime: NOW, likes: 0, ...over
})

const baseFilters: Filters = { timeRange: 'all', duration: 'all', targetCount: 200 }

describe('matchTimeRange', () => {
  it('all 恒真', () => expect(matchTimeRange(0, 'all', undefined, undefined, NOW)).toBe(true))
  it('7d 只留近7天', () => {
    expect(matchTimeRange(NOW - 3 * day, '7d', undefined, undefined, NOW)).toBe(true)
    expect(matchTimeRange(NOW - 10 * day, '7d', undefined, undefined, NOW)).toBe(false)
  })
  it('custom 用起止日期', () => {
    const start = '2024-01-01', end = '2024-12-31'
    const inRange = new Date('2024-06-01T00:00:00Z').getTime() / 1000
    const outRange = new Date('2025-06-01T00:00:00Z').getTime() / 1000
    expect(matchTimeRange(inRange, 'custom', start, end, NOW)).toBe(true)
    expect(matchTimeRange(outRange, 'custom', start, end, NOW)).toBe(false)
  })
})

describe('matchDuration', () => {
  it('30秒内排除未知时长和31秒，包含29秒与30秒边界', () => {
    expect(matchDuration(0, 'under30')).toBe(false)
    expect(matchDuration(29, 'under30')).toBe(true)
    expect(matchDuration(30, 'under30')).toBe(true)
    expect(matchDuration(31, 'under30')).toBe(false)
  })
  it('自定义10-20秒包含两端，排除范围外与非法边界', () => {
    expect(matchDuration(10, 'custom', 10, 20)).toBe(true)
    expect(matchDuration(20, 'custom', 10, 20)).toBe(true)
    expect(matchDuration(9, 'custom', 10, 20)).toBe(false)
    expect(matchDuration(21, 'custom', 10, 20)).toBe(false)
    expect(matchDuration(15, 'custom', 20, 10)).toBe(false)
    expect(matchDuration(15, 'custom')).toBe(false)
  })
  it('短 <60s', () => { expect(matchDuration(30, 'short')).toBe(true); expect(matchDuration(90, 'short')).toBe(false) })
  it('中 60-300s', () => { expect(matchDuration(120, 'medium')).toBe(true); expect(matchDuration(30, 'medium')).toBe(false) })
  it('长 >300s', () => { expect(matchDuration(600, 'long')).toBe(true); expect(matchDuration(120, 'long')).toBe(false) })
})

describe('filterVideos', () => {
  it('时间+时长联合过滤', () => {
    const filters: Filters = { ...baseFilters, timeRange: '7d', duration: 'short' }
    const items = [item({ durationSec: 30, publishTime: NOW - day }), item({ durationSec: 500, publishTime: NOW - day })]
    expect(filterVideos(items, filters, NOW)).toHaveLength(1)
  })
  it('把自定义秒数边界传给时长过滤器', () => {
    const filters: Filters = { ...baseFilters, duration: 'custom', durationMinSec: 10, durationMaxSec: 20 }
    const items = [9, 10, 15, 20, 21].map((durationSec, index) => item({ awemeId: String(index), durationSec }))
    expect(filterVideos(items, filters, NOW).map(video => video.durationSec)).toEqual([10, 15, 20])
  })
})

describe('dedupeVideos', () => {
  it('按 awemeId 去重且不重复消耗 seen', () => {
    const seen = new Set(['a'])
    const items = [item({ awemeId: 'a' }), item({ awemeId: 'b' }), item({ awemeId: 'c' })]
    const out = dedupeVideos(items, seen)
    expect(out.map(i => i.awemeId)).toEqual(['b', 'c'])
    expect(seen.has('c')).toBe(true)
  })
})

describe('extractCategory', () => {
  it('提取第一个 #话题 为品类', async () => {
    const { extractCategory } = await import('../src/main/extractor')
    expect(extractCategory('周末撸猫日常 #猫咪 #萌宠 #搞笑')).toBe('猫咪')
    expect(extractCategory('没有话题的标题')).toBeNull()
    expect(extractCategory('#探店 某餐厅')).toBe('探店')
    expect(extractCategory('#' + '猫'.repeat(30))).toBe('猫'.repeat(20))
  })
})
