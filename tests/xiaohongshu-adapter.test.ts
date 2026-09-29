import { describe, expect, it } from 'vitest'
import { getAdapter, listAdapters } from '../src/main/adapters'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'
import { JSDOM } from 'jsdom'
import { xiaohongshuAdapter, parseXiaohongshuNoteStubs, parseXiaohongshuNoteDetail, isXiaohongshuDetailResponse, buildXiaohongshuAuthorListDomScript, parseXiaohongshuAuthorDomResult, xiaohongshuNativeSearchFilters } from '../src/main/adapters/xiaohongshu'

// 平台登记、任务能力以及来自真机响应的列表/详情解析。

describe('xiaohongshuAdapter 骨架', () => {
  it('已注册，能被平台注册表取到', () => {
    expect(getAdapter('xiaohongshu')).toBe(xiaohongshuAdapter)
  })

  it('两段式流程就绪，关键词、作者与话题任务均开放', () => {
    expect(xiaohongshuAdapter.taskReady).toBe(true)
    expect(xiaohongshuAdapter.supportedTaskTypes).toEqual(['keyword', 'author', 'hashtag'])
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
    expect(xhs).toMatchObject({ displayName: '小红书', taskReady: true, supportedTaskTypes: ['keyword', 'author', 'hashtag'] })
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
  it('详情地址符合用户提供的 pc_search 形态且正确编码令牌，永久作品链接不带令牌', () => {
    const stub = parseXiaohongshuNoteStubs({ data: { items: [videoNote('N1')] } }).stubs[0]
    stub.detailToken = 'FAKE+/=&'
    const url = new URL(xiaohongshuAdapter.buildDetailUrl!(stub))
    expect(url.origin + url.pathname).toBe('https://www.xiaohongshu.com/explore/N1')
    expect(url.searchParams.get('xsec_token')).toBe('FAKE+/=&')
    expect(url.searchParams.get('xsec_source')).toBe('pc_search')
    expect(xiaohongshuAdapter.buildVideoUrl('N1')).not.toContain('?')
  })

  it('地址与实测一致：search_result_ai，keyword 二次编码', () => {
    // 实测地址：https://www.xiaohongshu.com/search_result_ai?keyword=%25E7%25BE%258E%25E9%25A3%259F&source=unknown
    expect(xiaohongshuAdapter.buildSearchUrl('美食', { timeRange: 'all', duration: 'all', targetCount: 10 }))
      .toBe('https://www.xiaohongshu.com/search_result_ai?keyword=%25E7%25BE%258E%25E9%25A3%259F&source=unknown')
  })

  it('话题走同一个搜索页', () => {
    expect(xiaohongshuAdapter.buildHashtagUrl('美食')).toMatch(/^https:\/\/www\.xiaohongshu\.com\/search_result_ai\?keyword=/)
  })
})

describe('小红书网页原生筛选与作者卡片', () => {
  it('关键词/话题固定筛视频；近7天映射一周内，近30天不错误收窄成一周', () => {
    const base = { duration: 'all', targetCount: 10 } as const
    expect(xiaohongshuNativeSearchFilters('keyword', { ...base, timeRange: 'all' }))
      .toEqual([{ group: '笔记类型', option: '视频' }])
    expect(xiaohongshuNativeSearchFilters('hashtag', { ...base, timeRange: '7d' }))
      .toEqual([{ group: '笔记类型', option: '视频' }, { group: '发布时间', option: '一周内' }])
    expect(xiaohongshuNativeSearchFilters('keyword', { ...base, timeRange: '30d' }))
      .toEqual([{ group: '笔记类型', option: '视频' }])
    expect(xiaohongshuNativeSearchFilters('author', { ...base, timeRange: '7d' })).toEqual([])
  })

  it('作者 DOM 只收带 play-icon 的卡片，并保留 pc_user 详情入口', () => {
    const html = `<section class="note-item" data-note-id="V1"><a class="cover" href="/user/profile/U1/V1?xsec_token=T%2B1%3D&xsec_source=pc_user"><img src="https://img.test/v.webp"><span class="play-icon"></span></a><div class="title"><span>视频一</span></div><span class="count">1.2万</span></section>
      <section class="note-item" data-note-id="I1"><a class="cover" href="/user/profile/U1/I1?xsec_token=IMG&xsec_source=pc_user"><img src="https://img.test/i.webp"></a></section>`
    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/user/profile/U1', runScripts: 'outside-only' })
    const raw = dom.window.eval(buildXiaohongshuAuthorListDomScript()) as unknown
    const result = parseXiaohongshuAuthorDomResult(raw)
    expect(result.stubs).toHaveLength(1)
    expect(result.stubs[0]).toMatchObject({ noteId: 'V1', detailToken: 'T+1=', detailSource: 'pc_user', authorId: 'U1', title: '视频一', likes: 12000 })
    expect(result.stubs[0].detailUrl).toContain('/user/profile/U1/V1?')
    expect(xiaohongshuAdapter.buildDetailUrl!(result.stubs[0])).toBe(result.stubs[0].detailUrl)
  })

  it('作者 DOM 结果拒绝跨站或路径与 noteId 不一致的详情地址', () => {
    const result = parseXiaohongshuAuthorDomResult([{ noteId: 'N1', detailToken: 'T', detailSource: 'pc_user', authorId: 'U1', detailUrl: 'https://evil.test/user/profile/U1/N1?xsec_token=T' }])
    expect(result.stubs).toEqual([])
    expect(result.skipped.other).toBe(1)
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
      detailToken: 'TOKEN_N1',
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

// ---------------------------------------------------------------------------
// 任务 2：笔记详情解析。结构来自 2026-09-08 用户本机抓取的
// edith.xiaohongshu.com/api/sns/web/v1/feed 响应，字段名与层级一比一，值编造。
//
// 播放地址只在这里有：note_card.video.media.stream.{EF4|EF5|EF6|EF7}[].master_url
// 实测一条视频给了 EF4 一档（720p）+ EF5 四档（720/1080/1440/2160p，2160p 单文件 212MB）。
// ---------------------------------------------------------------------------
const DETAIL_URL = '//edith.xiaohongshu.com/api/sns/web/v1/feed'

function stream(codec: 'EF4' | 'EF5', type: number, w: number, h: number, bitrate: number, over: Record<string, unknown> = {}) {
  return {
    stream_type: type, stream_desc: `WEB_${type}`, default_stream: 0, format: 'mp4',
    width: w, height: h, duration: 275436, size: 1000, volume: 0, avg_bitrate: bitrate, fps: 60,
    video_codec: codec, video_bitrate: bitrate - 100000, video_duration: 275366,
    audio_codec: 'aac', audio_bitrate: 128064, audio_duration: 275435, audio_channels: 2, rotate: 0,
    master_url: `http://sns-video.test/stream/${type}.mp4?sign=SIG&t=6aa455a6`,
    backup_urls: [`http://sns-bak.test/stream/${type}.mp4`],
    hdr_type: 0, quality_type: 'HD', weight: 62,
    ...over
  }
}

const FULL_STREAMS = {
  EF4: [stream('EF4', 259, 720, 1280, 1660659)],
  EF5: [
    stream('EF5', 114, 720, 1280, 1117011),
    stream('EF5', 115, 1080, 1920, 1791480),
    stream('EF5', 108, 1440, 2560, 3671723),
    stream('EF5', 109, 2160, 3840, 6172777)
  ],
  EF6: [],
  EF7: []
}

function detailCard(over: Record<string, unknown> = {}, streams: Record<string, unknown[]> = FULL_STREAMS) {
  const media = {
    video_id: 137673405018525020,
    video: { stream_types: [259, 114, 115, 108, 109], biz_name: 110, biz_id: 'B', duration: 276, md5: 'M', hdr_type: 0, drm_type: 0 },
    stream: streams
  }
  return {
    note_id: 'NOTE1',
    title: '详情标题',
    desc: '#重庆美食[话题]# 正文 @某人',
    type: 'video',
    time: 1763540281000,
    last_update_time: 1763523708000,
    user: { user_id: 'USER1', nickname: '详情作者', avatar: 'http://a.test/x', xsec_token: 'UT' },
    interact_info: { nice_count: '', liked: false, comment_count: '436', share_count: '1502', followed: false, relation: 'none', liked_count: '5373', collected: false, collected_count: '504' },
    image_list: [{ url_default: 'http://cover.test/c.webp', url_pre: 'http://cover.test/p.webp', file_id: 'F', url: '', width: 1769, height: 2359, live_photo: false, stream: {}, trace_id: '', info_list: [{ image_scene: 'WB_DFT', url: 'http://cover.test/c.webp' }] }],
    video: {
      media_v2: JSON.stringify(media),
      media,
      image: { thumbnail_fileid: 'T' },
      capa: { duration: 275 }
    },
    tag_list: [{ type: 'topic', id: 'TAG', name: '重庆美食' }],
    at_user_list: [],
    share_info: { un_share: false },
    ...over
  }
}

function detailResponse(card: Record<string, unknown> = detailCard()) {
  return {
    code: 0, success: true, msg: '成功',
    data: { cursor_score: '', items: [{ id: 'NOTE1', model_type: 'note', note_card: card, ignore: false }], current_time: 1788852326725 }
  }
}

describe('xiaohongshuAdapter 详情接口匹配', () => {
  it('URL 特征认得详情接口（协议相对形态）', () => {
    expect(xiaohongshuAdapter.apiUrlPatterns.some(r => r.test(DETAIL_URL))).toBe(true)
    expect(xiaohongshuAdapter.apiUrlPatterns.some(r => r.test('https://edith.xiaohongshu.com/api/sns/web/v1/feed'))).toBe(true)
  })

  it('isXiaohongshuDetailResponse：URL 对 + items 是数组才算', () => {
    expect(isXiaohongshuDetailResponse(DETAIL_URL, detailResponse())).toBe(true)
    expect(isXiaohongshuDetailResponse(SEARCH_URL, detailResponse())).toBe(false)
    expect(isXiaohongshuDetailResponse(DETAIL_URL, { data: {} })).toBe(false)
  })

  it('详情响应不会被关键词任务当成搜索结果（用户手点笔记不能污染任务）', () => {
    expect(xiaohongshuAdapter.matchesTaskResponse('keyword', DETAIL_URL, detailResponse())).toBe(false)
  })
})

describe('parseXiaohongshuNoteDetail 组装完整条目', () => {
  it('读取真机 INITIAL_STATE 的驼峰详情结构，且脚本只返回当前笔记', () => {
    const note = {
      noteId: 'STATE1', xsecToken: 'NOTE_PRIVATE_TOKEN', type: 'video', title: '页面详情', desc: '', time: 1780000000000,
      user: { userId: 'USER_STATE', nickname: '页面作者', xsecToken: 'USER_PRIVATE_TOKEN' },
      interactInfo: { likedCount: '1.2万', commentCount: '35' },
      imageList: [{ urlDefault: 'https://img.test/cover.jpg' }],
      video: { capa: { duration: 18 }, media: { stream: { h264: [{ width: 720, height: 1280,
        masterUrl: 'https://cdn.test/state.mp4', avgBitrate: 1234, duration: 18000, videoCodec: 'h264' }] } } }
    }
    const dom = new JSDOM('', { url: 'https://www.xiaohongshu.com/explore/STATE1', runScripts: 'outside-only' })
    ;(dom.window as unknown as { __INITIAL_STATE__: unknown }).__INITIAL_STATE__ = {
      note: {
        currentNoteId: { __v_isRef: true, _value: 'STATE1', _rawValue: 'STATE1', value: 'STATE1' },
        noteDetailMap: { STATE1: { note }, OTHER: { note: { ...note, noteId: 'OTHER' } } }
      }
    }
    const raw = dom.window.eval(xiaohongshuAdapter.buildDetailDomScript!('STATE1'))
    expect(JSON.stringify(raw)).not.toContain('PRIVATE_TOKEN')
    expect(structuredClone(raw)).toEqual(raw)
    expect(parseXiaohongshuNoteDetail(raw)).toMatchObject({
      awemeId: 'STATE1', title: '页面详情', authorSecUid: 'USER_STATE', authorNickname: '页面作者',
      playUrl: 'https://cdn.test/state.mp4', coverUrl: 'https://img.test/cover.jpg', durationSec: 18,
      publishTime: 1780000000, likes: 12000, comments: 35
    })
    ;((dom.window as unknown as { __INITIAL_STATE__: { note: { currentNoteId: unknown } } }).__INITIAL_STATE__.note.currentNoteId) = 'STATE1'
    expect(parseXiaohongshuNoteDetail(dom.window.eval(xiaohongshuAdapter.buildDetailDomScript!('STATE1'))))
      .toMatchObject({ awemeId: 'STATE1' })
    expect(dom.window.eval(xiaohongshuAdapter.buildDetailDomScript!('OTHER'))).toBeNull()
  })

  it('取标题、作者、时长、发布时间、点赞、评论、封面、作品链接、播放地址与宽高', () => {
    const item = parseXiaohongshuNoteDetail(detailResponse())
    expect(item).toEqual({
      awemeId: 'NOTE1',
      title: '详情标题',
      authorSecUid: 'USER1',
      authorNickname: '详情作者',
      authorHomeUrl: 'https://www.xiaohongshu.com/user/profile/USER1',
      // 选 1080p：转码目标就是 1080×1920，再高是白花流量与转码时间
      playUrl: 'http://sns-video.test/stream/115.mp4?sign=SIG&t=6aa455a6',
      coverUrl: 'http://cover.test/c.webp',
      width: 1080,
      height: 1920,
      durationSec: 275,
      publishTime: 1763540281,
      likes: 5373,
      comments: 436,
      // 作品链接不带 xsec_token：那是一次性短期令牌，不能当永久身份存库
      sourceUrl: 'https://www.xiaohongshu.com/explore/NOTE1'
    })
  })

  it('清晰度选择：短边 ≤1080 里取最大；2160p 与 1440p 有更小的可选时不要', () => {
    const only720and2160 = { EF4: [], EF5: [stream('EF5', 114, 720, 1280, 1), stream('EF5', 109, 2160, 3840, 9)], EF6: [], EF7: [] }
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({}, only720and2160)))?.playUrl).toContain('/114.mp4')
  })

  it('全部高于 1080 时取最小的那档，不要 2160p', () => {
    const big = { EF4: [], EF5: [stream('EF5', 108, 1440, 2560, 3), stream('EF5', 109, 2160, 3840, 6)], EF6: [], EF7: [] }
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({}, big)))?.playUrl).toContain('/108.mp4')
  })

  it('同分辨率时优先 EF4：编码含义未取证，EF4 更保守', () => {
    const tie = { EF4: [stream('EF4', 259, 1080, 1920, 1)], EF5: [stream('EF5', 115, 1080, 1920, 9)], EF6: [], EF7: [] }
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({}, tie)))?.playUrl).toContain('/259.mp4')
  })

  it('master_url 缺失时回落 backup_urls（无签名版本）', () => {
    const noMaster = { EF4: [], EF5: [stream('EF5', 115, 1080, 1920, 1, { master_url: '' })], EF6: [], EF7: [] }
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({}, noMaster)))?.playUrl).toBe('http://sns-bak.test/stream/115.mp4')
  })

  it('media 缺失但 media_v2（JSON 字符串副本）在 → 从副本里取', () => {
    const card = detailCard()
    const video = card.video as Record<string, unknown>
    delete video.media
    expect(parseXiaohongshuNoteDetail(detailResponse(card))?.playUrl).toContain('/115.mp4')
  })

  it('一档播放地址都取不到 → 整条丢弃，不入库一个点不开的视频', () => {
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({}, { EF4: [], EF5: [], EF6: [], EF7: [] })))).toBeNull()
    const card = detailCard()
    delete (card as Record<string, unknown>).video
    expect(parseXiaohongshuNoteDetail(detailResponse(card))).toBeNull()
  })

  it('图文笔记（type≠video）→ null', () => {
    expect(parseXiaohongshuNoteDetail(detailResponse(detailCard({ type: 'normal' })))).toBeNull()
  })

  it('时长回落：capa.duration → media.video.duration → 所选档位毫秒时长', () => {
    const card = detailCard()
    ;(card.video as Record<string, unknown>).capa = {}
    expect(parseXiaohongshuNoteDetail(detailResponse(card))?.durationSec).toBe(276)
    const media = ((card.video as Record<string, unknown>).media as Record<string, unknown>)
    ;(media.video as Record<string, unknown>).duration = 0
    expect(parseXiaohongshuNoteDetail(detailResponse(card))?.durationSec).toBeCloseTo(275.436, 3)
  })

  it('标题为空时用正文（去掉话题标记）顶上', () => {
    const item = parseXiaohongshuNoteDetail(detailResponse(detailCard({ title: '', desc: '#重庆美食[话题]# 正文一句 #豆花饭[话题]#' })))
    expect(item?.title).toBe('正文一句')
  })

  it('评论字符串为空 → null；「万」后缀能认', () => {
    const a = detailCard({ interact_info: { liked_count: '1.2万', comment_count: '' } })
    expect(parseXiaohongshuNoteDetail(detailResponse(a))).toMatchObject({ likes: 12000, comments: null })
  })

  it('畸形响应不抛错，返回 null', () => {
    for (const json of [null, 'x', [], {}, { data: {} }, { data: { items: [] } }, { data: { items: [{}] } }]) {
      expect(parseXiaohongshuNoteDetail(json)).toBeNull()
    }
  })
})
