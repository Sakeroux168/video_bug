import { describe, it, expect } from 'vitest'
import { filterVideos, matchTimeRange, matchDuration, dedupeVideos, chinaDayStartSec, chinaDayEndSec, chinaToday } from '../src/main/extractor'
import type { VideoItem } from '../src/main/adapters/types'
import type { Filters } from '../src/shared/types'
import { douyinAdapter } from '../src/main/adapters/douyin'

const NOW = 1720000000 // 基准时间
const day = 86400
const item = (over: Partial<VideoItem>): VideoItem => ({
  awemeId: '1', title: 't', authorSecUid: 's', authorNickname: 'n', authorHomeUrl: 'h', coverUrl: '', width: 0, height: 0,
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

describe('matchTimeRange 自定义日期按北京时间整天算（R20）', () => {
  const cst = (iso: string): number => Date.parse(iso + '+08:00') / 1000
  it('起始日北京时间 00:00:00 算在内，前一秒不算（以前按 UTC，差 8 小时）', () => {
    expect(matchTimeRange(cst('2024-03-10T00:00:00'), 'custom', '2024-03-10', '2024-03-20')).toBe(true)
    expect(matchTimeRange(cst('2024-03-09T23:59:59'), 'custom', '2024-03-10', '2024-03-20')).toBe(false)
    // 北京时间 3 月 10 日早上 7 点 = UTC 3 月 9 日 23 点：旧实现会错误地排除
    expect(matchTimeRange(cst('2024-03-10T07:00:00'), 'custom', '2024-03-10', '2024-03-20')).toBe(true)
  })
  it('结束日北京时间 23:59:59 算在内，次日 00:00:00 不算', () => {
    expect(matchTimeRange(cst('2024-03-20T23:59:59'), 'custom', '2024-03-10', '2024-03-20')).toBe(true)
    expect(matchTimeRange(cst('2024-03-21T00:00:00'), 'custom', '2024-03-10', '2024-03-20')).toBe(false)
    // 北京时间 3 月 21 日早上 5 点 = UTC 3 月 20 日 21 点：旧实现会错误地收进来
    expect(matchTimeRange(cst('2024-03-21T05:00:00'), 'custom', '2024-03-10', '2024-03-20')).toBe(false)
  })
  it('只填「从」= 从那天到现在；只填「到」= 那天及以前；都不填 = 不限', () => {
    expect(matchTimeRange(cst('2030-01-01T12:00:00'), 'custom', '2024-03-10', undefined)).toBe(true)
    expect(matchTimeRange(cst('2024-03-09T12:00:00'), 'custom', '2024-03-10', undefined)).toBe(false)
    expect(matchTimeRange(cst('2000-01-01T12:00:00'), 'custom', undefined, '2024-03-20')).toBe(true)
    expect(matchTimeRange(cst('2024-03-21T12:00:00'), 'custom', undefined, '2024-03-20')).toBe(false)
    expect(matchTimeRange(0, 'custom', undefined, undefined)).toBe(true)
  })
  it('边界换算用固定 +08:00，不看这台电脑的时区', () => {
    expect(chinaDayStartSec('2024-03-10')).toBe(Date.UTC(2024, 2, 9, 16, 0, 0) / 1000)
    expect(chinaDayEndSec('2024-03-10')).toBe(Date.UTC(2024, 2, 10, 15, 59, 59) / 1000)
    expect(chinaDayStartSec('3.10')).toBeNull()
  })
  it('日期不存在 → null（R20 复查：以前 2026-02-31 会悄悄滚到 3 月 3 日、13 月会变成 NaN）', () => {
    expect(chinaDayStartSec('2024-13-01')).toBeNull()
    expect(chinaDayStartSec('2026-02-31')).toBeNull()
    expect(chinaDayStartSec('2026-02-29')).toBeNull()
    expect(chinaDayStartSec('2026-04-31')).toBeNull()
    expect(chinaDayStartSec('2024-02-29')).not.toBeNull()
    expect(chinaDayStartSec('2026-12-31')).not.toBeNull()
  })
  it('chinaToday：UTC 晚上 16 点以后已经是北京时间第二天', () => {
    expect(chinaToday(Date.UTC(2026, 8, 28, 15, 59, 0))).toBe('2026-09-28')
    expect(chinaToday(Date.UTC(2026, 8, 28, 16, 0, 0))).toBe('2026-09-29')
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
  it('接口毫秒精度保留：9.6/20.4 秒不通过10-20范围，30.4秒不通过30秒内', () => {
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [9600, 10000, 20000, 20400, 30000, 30400].map(ms => ({
      aweme_id: String(ms), desc: '边界测试', duration: ms,
      video: { play_addr: { url_list: ['https://cdn.test/v.mp4'] } }
    })) })
    expect(filterVideos(items, { ...baseFilters, duration: 'custom', durationMinSec: 10, durationMaxSec: 20 }).map(v => v.awemeId))
      .toEqual(['10000', '20000'])
    expect(filterVideos(items, { ...baseFilters, duration: 'under30' }).map(v => v.awemeId))
      .toEqual(['9600', '10000', '20000', '20400', '30000'])
  })
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
