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
  statistics: { digg_count: 1234, comment_count: 0 }
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
      coverUrl: '', width: 0, height: 0,
      durationSec: 45, publishTime: 1710000000, likes: 1234,
      comments: 0,
      sourceUrl: 'https://www.douyin.com/video/7300000000000000001'
    })
  })

  it('评论数保留真实0与非零值，缺失或非法值归一为null', () => {
    const parse = (comment_count: unknown, include = true): number | null | undefined => {
      const statistics = include ? { digg_count: 1, comment_count } : { digg_count: 1 }
      return douyinAdapter.parseApiJson('https://x/', {
        aweme_list: [{ ...AWEME, statistics }]
      })[0].comments
    }
    expect(parse(0)).toBe(0)
    expect(parse(45)).toBe(45)
    expect(parse('45')).toBe(45)
    expect(parse(undefined, false)).toBeNull()
    expect(parse(null)).toBeNull()
    expect(parse('')).toBeNull()
    expect(parse(false)).toBeNull()
    expect(parse(-1)).toBeNull()
    expect(parse(1.5)).toBeNull()
    expect(parse('bad')).toBeNull()
  })

  it('作品链接和允许主机由适配器声明', () => {
    expect(douyinAdapter.buildVideoUrl('7300000000000000001'))
      .toBe('https://www.douyin.com/video/7300000000000000001')
    expect(douyinAdapter.sourceHosts).toEqual(['www.douyin.com'])
  })

  it('解析封面地址与视频宽高，优先使用 origin_cover', () => {
    const aweme = {
      ...AWEME,
      video: {
        ...AWEME.video,
        origin_cover: { url_list: ['https://cdn.test/origin.jpg'] },
        cover: { url_list: ['https://cdn.test/cover.jpg'] },
        dynamic_cover: { url_list: ['https://cdn.test/dynamic.webp'] },
        width: 1080,
        height: 1920
      }
    }
    const [item] = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(item.coverUrl).toBe('https://cdn.test/origin.jpg')
    expect(item.width).toBe(1080)
    expect(item.height).toBe(1920)
  })

  it('封面逐级回退；无效宽高归一为 0', () => {
    const aweme = {
      ...AWEME,
      video: {
        ...AWEME.video,
        origin_cover: { url_list: [] },
        cover: { url_list: ['https://cdn.test/cover.jpg'] },
        dynamic_cover: { url_list: ['https://cdn.test/dynamic.webp'] },
        width: -1,
        height: 'unknown'
      }
    }
    const [item] = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(item.coverUrl).toBe('https://cdn.test/cover.jpg')
    expect(item.width).toBe(0)
    expect(item.height).toBe(0)
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

describe('douyinAdapter.parseAuthorInput', () => {
  const cases: Array<{ label: string; input: string; expected: string | null }> = [
    { label: '标准主页 URL', input: 'https://www.douyin.com/user/MS4wLjABAAAA1', expected: 'MS4wLjABAAAA1' },
    { label: '容忍 http://', input: 'http://www.douyin.com/user/MS4wLjABAAAA1', expected: 'MS4wLjABAAAA1' },
    { label: '容忍 ?query', input: 'https://www.douyin.com/user/MS4wLjABAAAA1?from_tab_name=main', expected: 'MS4wLjABAAAA1' },
    { label: '容忍 #hash', input: 'https://www.douyin.com/user/MS4wLjABAAAA1#hash', expected: 'MS4wLjABAAAA1' },
    { label: '容忍尾斜杠', input: 'https://www.douyin.com/user/MS4wLjABAAAA1/', expected: 'MS4wLjABAAAA1' },
    { label: '容忍前后空白', input: '  https://www.douyin.com/user/MS4wLjABAAAA1  ', expected: 'MS4wLjABAAAA1' },
    { label: '裸 sec_uid 原样返回', input: 'MS4wLjABAAAA1', expected: 'MS4wLjABAAAA1' },
    { label: 'v.douyin.com 短链不解析', input: 'https://v.douyin.com/iXXXXXXX/', expected: null },
    { label: '非抖音域名', input: 'https://www.baidu.com/user/MS4wLjABAAAA1', expected: null },
    { label: '空串', input: '', expected: null },
    { label: '含非法字符（空格）', input: 'MS4w Ljab AAAA1', expected: null }
  ]
  for (const c of cases) {
    it(c.label, () => {
      expect(douyinAdapter.parseAuthorInput(c.input)).toBe(c.expected)
    })
  }
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
  // 审查补：手机端分享出来的主页链接有时带 m. 子域，原实现只认 www. 与裸域名，
  // 员工粘 m.douyin.com 会拿到「未识别到抖音主页链接」却看不出问题在子域上。
  it('parseAuthorInput 认 m. 子域的主页链接', () => {
    expect(douyinAdapter.parseAuthorInput('https://m.douyin.com/user/MS4wLjABAAAA')).toBe('MS4wLjABAAAA')
  })

})

// ---------------------------------------------------------------------------
// 任务接口匹配下沉到适配器。这里逐条锁死 scheduler 里原有的抖音规则，
// 搬家不是重写：keyword→/search/、author→/aweme/post/、hashtag→/challenge/ 或 /search/。
// 抖音只看 URL，不看响应体（同一路径不会混装两种任务的数据）。
// ---------------------------------------------------------------------------
describe('douyinAdapter.matchesTaskResponse', () => {
  const search = 'https://www.douyin.com/aweme/v1/web/search/item/?device_platform=webapp'
  const general = 'https://www.douyin.com/aweme/v1/web/general/search/single/?device_platform=webapp'
  const post = 'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC1'
  const challenge = 'https://www.douyin.com/aweme/v1/web/challenge/aweme/?ch_id=1'
  const unrelated = 'https://www.douyin.com/aweme/v1/web/im/user/info/?aid=6383'

  it('关键词任务收 /search/，不收作者作品列表和无关接口', () => {
    expect(douyinAdapter.matchesTaskResponse('keyword', search, {})).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('keyword', general, {})).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('keyword', post, {})).toBe(false)
    expect(douyinAdapter.matchesTaskResponse('keyword', unrelated, {})).toBe(false)
  })

  it('作者任务只收 /aweme/post/', () => {
    expect(douyinAdapter.matchesTaskResponse('author', post, {})).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('author', search, {})).toBe(false)
    expect(douyinAdapter.matchesTaskResponse('author', challenge, {})).toBe(false)
    expect(douyinAdapter.matchesTaskResponse('author', unrelated, {})).toBe(false)
  })

  it('话题任务收 /challenge/ 也收 /search/（话题页实际会走搜索接口）', () => {
    expect(douyinAdapter.matchesTaskResponse('hashtag', challenge, {})).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('hashtag', search, {})).toBe(true)
    expect(douyinAdapter.matchesTaskResponse('hashtag', post, {})).toBe(false)
    expect(douyinAdapter.matchesTaskResponse('hashtag', unrelated, {})).toBe(false)
  })

  it('判定只依赖 URL，响应体畸形也不抛错', () => {
    for (const json of [null, undefined, 0, '', [], {}]) {
      expect(douyinAdapter.matchesTaskResponse('keyword', search, json)).toBe(true)
      expect(douyinAdapter.matchesTaskResponse('author', search, json)).toBe(false)
    }
  })
})

describe('douyinAdapter 平台知识集中在适配器里', () => {
  it('作者输入 placeholder / 下载 Referer / 短链识别都由适配器提供', () => {
    expect(douyinAdapter.authorInputPlaceholder).toBe('https://www.douyin.com/user/xxx')
    expect(douyinAdapter.downloadReferer).toBe('https://www.douyin.com/')
    expect(douyinAdapter.isShortLink('https://v.douyin.com/ABC123/')).toBe(true)
    expect(douyinAdapter.isShortLink('https://www.douyin.com/user/SEC1')).toBe(false)
    expect(douyinAdapter.isShortLink('https://v.kuaishou.com/ABC')).toBe(false)
  })
})
