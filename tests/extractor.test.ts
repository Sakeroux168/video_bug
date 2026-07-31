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
