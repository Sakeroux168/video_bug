// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { douyinAdapter, collectAwemeList, drainDurationDiags } from '../src/main/adapters/douyin'

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

describe('douyinAdapter 时长多候选解析（毫秒→秒）', () => {
  it('顶层无 duration 时回退 video.duration', () => {
    const aweme = { ...AWEME, duration: undefined, video: { ...AWEME.video, duration: 45000 } }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items).toHaveLength(1)
    expect(items[0].durationSec).toBe(45)
  })

  it('顶层 duration 优先于 video.duration（候选顺序正确）', () => {
    const aweme = { ...AWEME, video: { ...AWEME.video, duration: 60000 } }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items).toHaveLength(1)
    expect(items[0].durationSec).toBe(45)
  })

  it('顶层与 video 皆无时长时解析为 0', () => {
    const aweme = { ...AWEME, duration: undefined }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items[0].durationSec).toBe(0)
  })
})

describe('douyinAdapter 0 时长诊断（drainDurationDiags）', () => {
  it('解析出 0 时长有效条目时记录其顶层字段名', () => {
    drainDurationDiags() // 先清空历史诊断
    const aweme = { ...AWEME }
    delete (aweme as Record<string, unknown>).duration // 真实接口无该字段时键不存在
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items[0].durationSec).toBe(0)
    const diags = drainDurationDiags()
    expect(diags).toHaveLength(1)
    expect(diags[0].topKeys).toEqual(expect.arrayContaining(['aweme_id', 'desc', 'author', 'video', 'create_time', 'statistics']))
    expect(diags[0].topKeys).not.toContain('duration')
  })

  it('时长正常时不产生诊断', () => {
    drainDurationDiags()
    douyinAdapter.parseApiJson('https://x/', { aweme_list: [{ ...AWEME }] })
    expect(drainDurationDiags()).toHaveLength(0)
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

describe('douyinAdapter 解析新 general/search 结构', () => {
  it('data 直接放视频对象（无 aweme_list 键）', () => {
    const json = { status_code: 0, cursor: 1, data: [AWEME, { ...AWEME, aweme_id: '7300000000000000002' }] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/general/search/single/', json)
    expect(items).toHaveLength(2)
    expect(items[1].awemeId).toBe('7300000000000000002')
  })
  it('视频嵌套在任意层级的键下也能收集', () => {
    const json = { status_code: 0, extra: { data: { items: [AWEME] } } }
    expect(collectAwemeList(json)).toHaveLength(1)
  })
})

describe('douyinAdapter 解析新版卡片结构（aweme_info 包装）', () => {
  it('data[] 是卡片，视频在 aweme_info 里', () => {
    const card = (id: string) => ({ type: 1, doc_type: 0, aweme_info: { ...AWEME, aweme_id: id } })
    const json = { status_code: 0, data: [card('7300000000000000011'), card('7300000000000000012')] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/general/search/single/', json)
    expect(items).toHaveLength(2)
    expect(items[0].awemeId).toBe('7300000000000000011')
    expect(items[1].awemeId).toBe('7300000000000000012')
  })
})
