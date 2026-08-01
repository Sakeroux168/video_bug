import { describe, it, expect } from 'vitest'
import { douyinAdapter, collectAwemeList } from '../src/main/adapters/douyin'

const AWEME = {
  aweme_id: '7300000000000000001',
  desc: '美食探店 第3期',
  author: { sec_uid: 'MS4wLjABAAAA1', nickname: '探店小王' },
  video: { play_addr: { url_list: ['https://v.douyin.com/xxx/playwm/?foo=bar'] } },
  duration: 45000, // ms
  create_time: 1710000000,
  statistics: { digg_count: 1234 }
}

describe('douyinAdapter.parseApiJson', () => {
  it('解析搜索接口结构（data[].aweme_list）', () => {
    const json = { status_code: 0, data: [{ aweme_list: [AWEME] }] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/search/item/', json)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      awemeId: '7300000000000000001', title: '美食探店 第3期',
      authorSecUid: 'MS4wLjABAAAA1', authorNickname: '探店小王',
      authorHomeUrl: 'https://www.douyin.com/user/MS4wLjABAAAA1',
      playUrl: 'https://v.douyin.com/xxx/playwm/?foo=bar',
      durationSec: 45, publishTime: 1710000000, likes: 1234
    })
  })

  it('解析作者主页接口结构（顶层 aweme_list）', () => {
    const json = { aweme_list: [AWEME], has_more: 0 }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/aweme/post/', json)
    expect(items).toHaveLength(1)
  })

  it('过滤掉无播放地址/无 id 的脏数据', () => {
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [AWEME, { aweme_id: '', desc: 'x' }] })
    expect(items).toHaveLength(1)
  })
})

describe('collectAwemeList', () => {
  it('深度扫描任意嵌套中的 aweme_list 数组', () => {
    const json = { a: { b: { aweme_list: [AWEME] } } }
    expect(collectAwemeList(json)).toHaveLength(1)
  })
})

describe('douyinAdapter.normalizePlayUrl', () => {
  it('playwm 替换为 play', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/playwm/1')).toBe('https://a/play/1')
  })
  it('不做 _watermark 字符串替换（避免改坏 CDN 文件名导致黑屏）', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/x_watermark_100')).toBe('https://a/x_watermark_100')
  })
  it('已是无水印则原样返回', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/play/1')).toBe('https://a/play/1')
  })
})

describe('douyinAdapter URL 构造', () => {
  it('buildSearchUrl 编码关键词', () => {
    expect(douyinAdapter.buildSearchUrl('美食 探店', { timeRange: 'all', duration: 'all', targetCount: 200 }))
      .toBe('https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F%20%E6%8E%A2%E5%BA%97')
  })
  it('buildAuthorUrl 拼接 sec_uid', () => {
    expect(douyinAdapter.buildAuthorUrl('SEC123')).toBe('https://www.douyin.com/user/SEC123')
  })
})
