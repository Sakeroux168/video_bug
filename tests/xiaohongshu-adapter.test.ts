import { describe, expect, it } from 'vitest'
import { getAdapter, listAdapters } from '../src/main/adapters'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'
import { xiaohongshuAdapter, parseXiaohongshuNoteStubs } from '../src/main/adapters/xiaohongshu'

// 小红书接入第 1 步：只建骨架，不写解析器。
//
// 快手那一轮的教训：照公开资料把整个解析器写完，真机一跑发现平台早从 GraphQL
// 换成了 REST，白写。所以这次倒过来——先让浏览器能打开小红书、能登录、能把流量
// 记进拦截日志，拿到真实接口和响应结构之后再写解析。
//
// 骨架阶段最要防的是「半成品暴露」：平台出现在建任务下拉框里，用户选了却跑不通。
// 因此适配器带 taskReady 标记，建任务一侧明确拒绝并说明原因。

describe('xiaohongshuAdapter 骨架', () => {
  it('已注册，能被平台注册表取到', () => {
    expect(getAdapter('xiaohongshu')).toBe(xiaohongshuAdapter)
  })

  it('taskReady 为 false —— 解析器还没写，不能让它出现在建任务下拉框里', () => {
    expect(xiaohongshuAdapter.taskReady).toBe(false)
    expect(douyinAdapter.taskReady).toBe(true)
    expect(kuaishouAdapter.taskReady).toBe(true)
  })

  it('登录态分区独立，不与抖音快手共用', () => {
    expect(xiaohongshuAdapter.sessionPartition).toBe('persist:xiaohongshu')
    const partitions = [douyinAdapter, kuaishouAdapter, xiaohongshuAdapter].map(a => a.sessionPartition)
    expect(new Set(partitions).size).toBe(3)
  })

  it('首页可打开（抓包与扫码登录都要靠它），且主机在作品白名单内', () => {
    expect(xiaohongshuAdapter.homeUrl).toBe('https://www.xiaohongshu.com/')
    expect(xiaohongshuAdapter.sourceHosts).toContain(new URL(xiaohongshuAdapter.homeUrl).hostname)
  })

  it('解析器是空的，而且明说是空的：任何响应都不匹配、都解析不出条目', () => {
    const anything = { data: { items: [{ note_card: {} }] } }
    for (const type of ['keyword', 'author', 'hashtag'] as const) {
      expect(xiaohongshuAdapter.matchesTaskResponse(type, 'https://edith.xiaohongshu.com/api/x', anything)).toBe(false)
    }
    expect(xiaohongshuAdapter.parseApiJson('https://edith.xiaohongshu.com/api/x', anything)).toEqual([])
  })

  it('作者输入：完整主页链接与裸 ID 都能归一化，短链拒绝', () => {
    expect(xiaohongshuAdapter.parseAuthorInput('https://www.xiaohongshu.com/user/profile/5f2a1b3c0000000001')).toBe('5f2a1b3c0000000001')
    expect(xiaohongshuAdapter.parseAuthorInput('5f2a1b3c0000000001')).toBe('5f2a1b3c0000000001')
    expect(xiaohongshuAdapter.parseAuthorInput('https://www.douyin.com/user/SEC1')).toBeNull()
    expect(xiaohongshuAdapter.parseAuthorInput('')).toBeNull()
  })

  it('短链识别：xhslink.com 拒绝，不联网猜后面的真实 ID', () => {
    expect(xiaohongshuAdapter.isShortLink('https://xhslink.com/a/ABCDEF')).toBe(true)
    expect(xiaohongshuAdapter.isShortLink('http://xhslink.com/xyz')).toBe(true)
    expect(xiaohongshuAdapter.isShortLink('https://www.xiaohongshu.com/user/profile/5f2a')).toBe(false)
    expect(xiaohongshuAdapter.isShortLink('https://v.douyin.com/ABC')).toBe(false)
  })

  it('作品链接只认小红书主机，跨平台地址一律拒绝', () => {
    expect(xiaohongshuAdapter.sourceHosts).toEqual(['www.xiaohongshu.com'])
    expect(xiaohongshuAdapter.sourceHosts).not.toContain('www.douyin.com')
  })
})

describe('平台注册表暴露 taskReady', () => {
  it('listAdapters 带出 taskReady，渲染层据此决定哪些平台能建任务', () => {
    const list = listAdapters()
    const xhs = list.find(p => p.name === 'xiaohongshu')
    expect(xhs).toMatchObject({ displayName: '小红书', taskReady: false })
    expect(list.find(p => p.name === 'douyin')).toMatchObject({ taskReady: true })
  })

  it('三个平台都在列表里 —— 内置浏览器要能打开小红书去登录', () => {
    expect(listAdapters().map(p => p.name).sort()).toEqual(['douyin', 'kuaishou', 'xiaohongshu'])
  })
})

// ---------------------------------------------------------------------------
// 任务 1：搜索列表解析。全部结构来自 2026-09-08 用户本机抓取的真实响应，
// 字段名与层级一比一，值全部编造。
//
// 与抖音/快手的根本差异：列表只给卡片，没有播放地址、没有时长。
// 所以这里只产出「笔记存根」（id + xsec_token + 卡片信息），播放地址在任务 2 的详情解析里取。
// ---------------------------------------------------------------------------
const SEARCH_URL = '//so.xiaohongshu.com/api/sns/web/v2/search/notes'

function videoNote(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    model_type: 'note',
    xsec_token: `TOKEN_${id}`,
    note_card: {
      type: 'video',
      display_title: `视频标题${id}`,
      cover: { url_default: `http://cover.test/${id}.webp`, url_pre: `http://cover.test/${id}-pre.webp`, width: 1080, height: 1440 },
      image_list: [{ width: 1080, height: 1440, info_list: [{ image_scene: 'WB_DFT', url: `http://cover.test/${id}.webp` }] }],
      user: { user_id: `USER_${id}`, nickname: `作者${id}`, nick_name: `作者${id}`, avatar: 'http://a.test/x.jpg', xsec_token: 'UTOKEN' },
      interact_info: { liked: false, liked_count: '1947', collected: false, collected_count: '403', comment_count: '48', shared_count: '739' },
      corner_tag_info: [{ type: 'publish_time', text: '07-03' }],
      ...over
    }
  }
}

const imageNote = { ...videoNote('IMG1'), note_card: { ...videoNote('IMG1').note_card, type: 'normal' } }
const hotQuery = {
  id: 'hq-1', model_type: 'hot_query', xsec_token: 'HQ',
  hot_query: { title: '大家都在搜', source: 2, queries: [{ id: 'q', name: 'q', search_word: 'q', cover: '' }] }
}

const SEARCH_RESPONSE = {
  code: 0, success: true, msg: '成功',
  data: { items: [videoNote('N1'), imageNote, hotQuery, videoNote('N2')], has_more: true, request_dqa_instant: false }
}

describe('xiaohongshuAdapter 搜索页地址', () => {
  it('地址与实测一致：search_result_ai，keyword 二次编码', () => {
    // 实测地址：https://www.xiaohongshu.com/search_result_ai?keyword=%25E7%25BE%258E%25E9%25A3%259F&source=unknown
    expect(xiaohongshuAdapter.buildSearchUrl('美食', { timeRange: 'all', duration: 'all', targetCount: 10 }))
      .toBe('https://www.xiaohongshu.com/search_result_ai?keyword=%25E7%25BE%258E%25E9%25A3%259F&source=unknown')
  })

  it('话题走同一个搜索页', () => {
    expect(xiaohongshuAdapter.buildHashtagUrl('美食')).toMatch(/^https:\/\/www\.xiaohongshu\.com\/search_result_ai\?keyword=/)
  })
})

describe('xiaohongshuAdapter 搜索接口匹配', () => {
  it('URL 特征认得协议相对形态的搜索接口（日志里就是 // 开头）', () => {
    expect(xiaohongshuAdapter.apiUrlPatterns.some(r => r.test(SEARCH_URL))).toBe(true)
    expect(xiaohongshuAdapter.apiUrlPatterns.some(r => r.test('https://so.xiaohongshu.com/api/sns/web/v2/search/notes'))).toBe(true)
  })

  it('埋点与性能上报不匹配（日志里 90% 是这些）', () => {
    for (const u of ['https://t2.xiaohongshu.com/api/v2/collect', 'https://apm-fe.xiaohongshu.com/api/data', '//edith.xiaohongshu.com/api/sns/web/unread_count']) {
      expect(xiaohongshuAdapter.apiUrlPatterns.some(r => r.test(u))).toBe(false)
    }
  })

  it('关键词/话题任务收搜索响应，作者任务不收（作者接口未取证）', () => {
    expect(xiaohongshuAdapter.matchesTaskResponse('keyword', SEARCH_URL, SEARCH_RESPONSE)).toBe(true)
    expect(xiaohongshuAdapter.matchesTaskResponse('hashtag', SEARCH_URL, SEARCH_RESPONSE)).toBe(true)
    expect(xiaohongshuAdapter.matchesTaskResponse('author', SEARCH_URL, SEARCH_RESPONSE)).toBe(false)
  })

  it('URL 对但没有 items 数组 → 拒绝（错误页、风控页）', () => {
    for (const json of [{ code: 0, data: {} }, { code: -1, msg: 'x' }, null, 'text', []]) {
      expect(xiaohongshuAdapter.matchesTaskResponse('keyword', SEARCH_URL, json)).toBe(false)
    }
  })

  it('响应对但 URL 不是搜索接口 → 拒绝', () => {
    expect(xiaohongshuAdapter.matchesTaskResponse('keyword', '//edith.xiaohongshu.com/api/sns/web/v1/feed', SEARCH_RESPONSE)).toBe(false)
  })
})

describe('parseXiaohongshuNoteStubs 只收视频笔记', () => {
  it('只留 type=video 的笔记；图文与推荐词跳过并分别计数', () => {
    const r = parseXiaohongshuNoteStubs(SEARCH_RESPONSE)
    expect(r.stubs.map(s => s.noteId)).toEqual(['N1', 'N2'])
    expect(r.skipped).toEqual({ image: 1, other: 1 })
  })

  it('存根带齐详情阶段与入库需要的卡片信息', () => {
    const [s] = parseXiaohongshuNoteStubs({ data: { items: [videoNote('N1')] } }).stubs
    expect(s).toEqual({
      noteId: 'N1',
      xsecToken: 'TOKEN_N1',
      title: '视频标题N1',
      authorId: 'USER_N1',
      authorNickname: '作者N1',
      coverUrl: 'http://cover.test/N1.webp',
      likes: 1947,
      comments: 48
    })
  })

  it('互动数是字符串：纯数字、「万」后缀、空串都要认；空串为未知 null', () => {
    const mk = (liked: string, comment: string) => videoNote('X', {
      interact_info: { liked: false, liked_count: liked, collected: false, collected_count: '0', comment_count: comment, shared_count: '0' }
    })
    expect(parseXiaohongshuNoteStubs({ data: { items: [mk('57914', '631')] } }).stubs[0]).toMatchObject({ likes: 57914, comments: 631 })
    expect(parseXiaohongshuNoteStubs({ data: { items: [mk('1.2万', '3千')] } }).stubs[0]).toMatchObject({ likes: 12000, comments: 3000 })
    expect(parseXiaohongshuNoteStubs({ data: { items: [mk('', '')] } }).stubs[0]).toMatchObject({ likes: null, comments: null })
  })

  it('标题为空的笔记仍保留（实测 20 条里 2 条空标题），标题留空待详情补', () => {
    const [s] = parseXiaohongshuNoteStubs({ data: { items: [videoNote('E', { display_title: '' })] } }).stubs
    expect(s.title).toBe('')
  })

  it('缺 id 或缺 xsec_token 的条目丢弃：没有 token 进不了详情页', () => {
    const noToken = { ...videoNote('T'), xsec_token: '' }
    const noId = { ...videoNote('I'), id: '' }
    expect(parseXiaohongshuNoteStubs({ data: { items: [noToken, noId] } }).stubs).toEqual([])
  })

  it('畸形响应不抛错，返回空', () => {
    for (const json of [null, 'x', [], {}, { data: null }, { data: { items: 'no' } }]) {
      expect(parseXiaohongshuNoteStubs(json)).toEqual({ stubs: [], skipped: { image: 0, other: 0 } })
    }
  })

  it('parseApiJson 仍为空：列表没有播放地址，不能伪造成可下载的 VideoItem', () => {
    expect(xiaohongshuAdapter.parseApiJson(SEARCH_URL, SEARCH_RESPONSE)).toEqual([])
  })
})
