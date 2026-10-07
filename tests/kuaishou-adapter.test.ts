import { describe, expect, it } from 'vitest'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'

const H264_RESOURCE = {
  json: {
    h264: {
      adaptationSet: [{
        representation: [
          { url: 'https://cdn.kuaishou.test/720.mp4', width: 720, height: 1280, maxBitrate: 1200 },
          { url: 'https://cdn.kuaishou.test/1080.mp4', width: 1080, height: 1920, maxBitrate: 2600 }
        ]
      }]
    },
    hevc: {
      adaptationSet: [{
        representation: [
          { url: 'https://cdn.kuaishou.test/hevc.mp4', width: 1440, height: 2560, maxBitrate: 3000 }
        ]
      }]
    }
  }
}

const FEED = {
  author: { id: '3xAUTHOR1', name: '快手作者' },
  photo: {
    id: '3xPHOTO1',
    caption: '快手测试作品',
    originCaption: '原标题',
    duration: 12500,
    timestamp: 1710000000123,
    likeCount: 456,
    commentCount: 0,
    coverUrl: 'https://cdn.kuaishou.test/cover.jpg',
    photoUrl: 'https://cdn.kuaishou.test/original.mp4',
    videoResource: H264_RESOURCE
  }
}

describe('kuaishouAdapter.parseApiJson', () => {
  it('解析 visionSearchPhoto 搜索响应并保留真实 0 评论', () => {
    const json = { data: { visionSearchPhoto: { result: 1, feeds: [FEED], pcursor: 'next' } } }
    const items = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', json)

    expect(items).toEqual([{
      awemeId: '3xPHOTO1',
      title: '快手测试作品',
      authorSecUid: '3xAUTHOR1',
      authorNickname: '快手作者',
      authorHomeUrl: 'https://www.kuaishou.com/profile/3xAUTHOR1',
      playUrl: 'https://cdn.kuaishou.test/original.mp4',
      coverUrl: 'https://cdn.kuaishou.test/cover.jpg',
      width: 1080,
      height: 1920,
      durationSec: 12.5,
      publishTime: 1710000000, // 13 位毫秒转秒后取整（原先漏了取整，断言里固化成了 .123）
      likes: 456,
      comments: 0,
      sourceUrl: 'https://www.kuaishou.com/short-video/3xPHOTO1'
    }])
  })

  it('解析 visionProfilePhotoList 作者响应，缺 photoUrl 时优先最高质量 H.264', () => {
    const feed = {
      ...FEED,
      photo: { ...FEED.photo, id: '3xPHOTO2', photoUrl: '', coverUrl: '' }
    }
    const json = { data: { visionProfilePhotoList: { result: 1, feeds: [feed] } } }
    const [item] = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', json)

    expect(item.awemeId).toBe('3xPHOTO2')
    expect(item.playUrl).toBe('https://cdn.kuaishou.test/1080.mp4')
    expect(item.width).toBe(1080)
    expect(item.height).toBe(1920)
  })

  it('解析 visionVideoDetail 详情响应，兼容 photo 内作者与 coverUrls 回退', () => {
    const photo = {
      id: '3xDETAIL1',
      originCaption: '详情页标题',
      duration: '30000',
      timestamp: 1710001234,
      likeCount: '88',
      coverUrls: [{ url: 'https://cdn.kuaishou.test/detail-cover.webp' }],
      author: { id: '3xAUTHOR2', name: '详情作者' },
      photoUrl: 'https://cdn.kuaishou.test/detail.mp4',
      videoResource: { json: JSON.stringify(H264_RESOURCE.json) }
    }
    const json = { data: { visionVideoDetail: { result: 1, photo } } }
    const [item] = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', json)

    expect(item).toMatchObject({
      awemeId: '3xDETAIL1',
      title: '详情页标题',
      authorSecUid: '3xAUTHOR2',
      authorNickname: '详情作者',
      coverUrl: 'https://cdn.kuaishou.test/detail-cover.webp',
      durationSec: 30,
      publishTime: 1710001234,
      likes: 88,
      comments: null
    })
  })

  it('photoUrl 与 H.264 都缺失时回退最高质量 HEVC', () => {
    const photo = {
      ...FEED.photo,
      id: '3xHEVC1',
      photoUrl: '',
      videoResource: {
        json: {
          hevc: H264_RESOURCE.json.hevc
        }
      }
    }
    const [item] = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', {
      data: { visionSearchPhoto: { result: 1, feeds: [{ ...FEED, photo }] } }
    })
    expect(item.playUrl).toBe('https://cdn.kuaishou.test/hevc.mp4')
    expect(item.width).toBe(1440)
    expect(item.height).toBe(2560)
  })

  it('过滤缺作品 ID、播放地址或作者 ID 的脏条目', () => {
    const dirty = [
      { ...FEED, photo: { ...FEED.photo, id: '' } },
      { ...FEED, photo: { ...FEED.photo, photoUrl: '', videoResource: null } },
      { ...FEED, author: { id: '', name: '无 ID 作者' } }
    ]
    expect(kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', {
      data: { visionSearchPhoto: { result: 1, feeds: dirty } }
    })).toEqual([])
  })
})

describe('kuaishouAdapter URL 与任务接口', () => {
  it('构造搜索、作者、话题和作品地址', () => {
    expect(kuaishouAdapter.buildSearchUrl('美食 探店', { timeRange: 'all', duration: 'all', targetCount: 20 }))
      .toBe('https://www.kuaishou.com/search/video?searchKey=%E7%BE%8E%E9%A3%9F%20%E6%8E%A2%E5%BA%97')
    expect(kuaishouAdapter.buildAuthorUrl('3xAUTHOR1')).toBe('https://www.kuaishou.com/profile/3xAUTHOR1')
    expect(kuaishouAdapter.buildHashtagUrl('乡村生活'))
      .toBe('https://www.kuaishou.com/search/video?searchKey=%23%E4%B9%A1%E6%9D%91%E7%94%9F%E6%B4%BB')
    expect(kuaishouAdapter.buildVideoUrl('3xPHOTO1')).toBe('https://www.kuaishou.com/short-video/3xPHOTO1')
    expect(kuaishouAdapter.sourceHosts).toEqual(['www.kuaishou.com'])
  })

  it.each([
    ['https://www.kuaishou.com/profile/3xAUTHOR1', '3xAUTHOR1'],
    ['http://kuaishou.com/profile/3xAUTHOR1?foo=1', '3xAUTHOR1'],
    ['3xAUTHOR1', '3xAUTHOR1'],
    ['https://v.kuaishou.com/ABC123', null],
    ['https://www.baidu.com/profile/3xAUTHOR1', null],
    ['', null],
    ['bad author id', null]
  ])('解析作者输入 %s', (input, expected) => {
    expect(kuaishouAdapter.parseAuthorInput(input)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// 任务接口匹配下沉到适配器。
// 抖音靠接口路径就能区分任务类型；快手关键词/作者/详情全部走同一个
// https://www.kuaishou.com/graphql，URL 一模一样，只能看响应里出现了哪个 operation 根字段。
// ---------------------------------------------------------------------------
const GQL = 'https://www.kuaishou.com/graphql'

const searchResponse = { data: { visionSearchPhoto: { result: 1, feeds: [FEED], pcursor: 'next' } } }
const profileResponse = { data: { visionProfilePhotoList: { result: 1, feeds: [FEED], pcursor: 'next' } } }
const detailResponse = { data: { visionVideoDetail: { status: 1, photo: FEED.photo, author: FEED.author } } }

describe('kuaishouAdapter.matchesTaskResponse', () => {
  it('关键词任务只收搜索响应', () => {
    expect(kuaishouAdapter.matchesTaskResponse('keyword', GQL, searchResponse)).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('keyword', GQL, profileResponse)).toBe(false)
    expect(kuaishouAdapter.matchesTaskResponse('keyword', GQL, detailResponse)).toBe(false)
  })

  it('话题任务走搜索接口，与关键词同源', () => {
    expect(kuaishouAdapter.matchesTaskResponse('hashtag', GQL, searchResponse)).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('hashtag', GQL, profileResponse)).toBe(false)
  })

  it('作者任务只收作者作品列表', () => {
    expect(kuaishouAdapter.matchesTaskResponse('author', GQL, profileResponse)).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('author', GQL, searchResponse)).toBe(false)
    expect(kuaishouAdapter.matchesTaskResponse('author', GQL, detailResponse)).toBe(false)
  })

  it('详情响应不属于任何任务类型：用户手点一条视频不能污染正在跑的任务', () => {
    for (const type of ['keyword', 'author', 'hashtag'] as const) {
      expect(kuaishouAdapter.matchesTaskResponse(type, GQL, detailResponse)).toBe(false)
    }
  })

  it('推荐流等未知 operation 一律拒绝，不靠"能解析出视频"来放行', () => {
    // 这个响应结构完整、解析得出视频，但它不是当前任务要的数据
    const feedResponse = { data: { brilliantTypeDataV2: { feeds: [FEED] } } }
    expect(kuaishouAdapter.parseApiJson(GQL, feedResponse).length).toBeGreaterThan(0)
    for (const type of ['keyword', 'author', 'hashtag'] as const) {
      expect(kuaishouAdapter.matchesTaskResponse(type, GQL, feedResponse)).toBe(false)
    }
  })

  it('operation 未包在 data 里时也认（有中间层会拆包），但仍按根字段判定', () => {
    expect(kuaishouAdapter.matchesTaskResponse('keyword', GQL, { visionSearchPhoto: { feeds: [FEED] } })).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('author', GQL, { visionSearchPhoto: { feeds: [FEED] } })).toBe(false)
  })

  it('畸形响应不抛错，一律拒绝', () => {
    for (const json of [null, undefined, 0, '', 'text', [], { data: null }, { data: [] }, { data: {} }]) {
      expect(kuaishouAdapter.matchesTaskResponse('keyword', GQL, json)).toBe(false)
    }
  })
})

describe('kuaishouAdapter 平台知识集中在适配器里', () => {
  it('作者输入 placeholder / 下载 Referer / 短链识别都由适配器提供', () => {
    expect(kuaishouAdapter.authorInputPlaceholder).toBe('https://www.kuaishou.com/profile/xxx')
    expect(kuaishouAdapter.downloadReferer).toBe('https://www.kuaishou.com/')
    expect(kuaishouAdapter.isShortLink('https://v.kuaishou.com/ABC123')).toBe(true)
    expect(kuaishouAdapter.isShortLink('https://c.kuaishou.com/ABC123')).toBe(true)
    expect(kuaishouAdapter.isShortLink('https://www.kuaishou.com/profile/3xA')).toBe(false)
    expect(kuaishouAdapter.isShortLink('https://v.douyin.com/ABC')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 真机烟测（2026-09-07）实测：快手网页端搜索走的不是 GraphQL，而是
//   POST https://www.kuaishou.com/rest/v/search/feed?__NS_hxfalcon=...&caver=2
// 响应根形如 { result, webPageArea, pcursor, feeds: [...], llsid, searchSessionId }
// 每条 feed 形如 { type, tags[], photo{}, author{}, comment{}, authorStatement? }
//
// 下面的夹具是照实测响应的**结构**手写的，字段名与层级一比一，值全部是编造的，
// 不含任何真实作品 ID、作者名或带签名的地址。
// ---------------------------------------------------------------------------

/** photo.manifest：与 photoUrls 并存的自适应清单，representation 里带宽高码率 */
const MANIFEST = {
  adaptationSet: [{
    id: 1,
    duration: 12500,
    representation: [
      { id: 1, url: 'https://v-fixture.test/720p.mp4', width: 720, height: 1280, maxBitrate: 3300, avgBitrate: 1974, qualityType: '720p' },
      { id: 2, url: 'https://v-fixture.test/1080p.mp4', width: 1080, height: 1920, maxBitrate: 5200, avgBitrate: 3100, qualityType: '1080p' }
    ]
  }]
}

const REST_FEED = {
  type: 1,
  tags: [{ name: '标签一', type: 1 }, { name: '标签二', type: 1 }],
  // 实测 comment 只有 us_c，20 条样本里全是 0（点赞几十万的也是 0），
  // 因此它不是评论数。评论数在这个接口里根本没有。
  comment: { us_c: 0 },
  danmakuSwitch: true,
  author: {
    id: '3xREALAUTHOR1',
    name: '快手作者',
    headerUrl: 'https://p-fixture.test/head.jpg',
    following: false,
    livingInfo: { living: false, livingId: null, iconType: 0 }
  },
  photo: {
    id: '3xREALPHOTO01',
    caption: '快手搜索结果标题',
    duration: 12500,
    timestamp: 1757850158602,
    width: 720,
    height: 1280,
    likeCount: 228227,
    viewCount: 11484563,
    collectCount: 0,
    coverUrl: 'https://p-fixture.test/cover.jpg',
    animatedCoverUrl: 'https://p-fixture.test/cover.webp',
    // 播放地址是数组，多 CDN 同内容；photoUrls=H.264，photoH265Urls=HEVC
    photoUrls: [
      { cdn: 'v23-3.kwaicdn.test', url: 'https://v23-3.kwaicdn.test/h264-a.mp4' },
      { cdn: 'v4.oskwai.test', url: 'https://v4.oskwai.test/h264-b.mp4' }
    ],
    photoH265Urls: [
      { cdn: 'v23-3.kwaicdn.test', url: 'https://v23-3.kwaicdn.test/h265-a.mp4' }
    ],
    manifest: MANIFEST,
    manifestH265: MANIFEST,
    expTag: 'exp-tag',
    riskTagContent: null,
    riskTagUrl: null,
    stereoType: 0,
    musicBlocked: false,
    liked: false,
    collected: false,
    disableSensitivePhoto: false
  }
}

const REST_SEARCH_RESPONSE = {
  result: 1,
  webPageArea: 'searchxxnull',
  pcursor: '1',
  feeds: [REST_FEED],
  llsid: '2010054898359520577',
  searchSessionId: 'SESSION_FIXTURE'
}

const REST_URL = 'https://www.kuaishou.com/rest/v/search/feed?__NS_hxfalcon=REDACTED&caver=2'

describe('kuaishouAdapter 解析 REST 搜索 feed（真机实测结构）', () => {
  it('拦截 URL 特征认得 /rest/v/search/feed（否则第一道闸门就把响应丢了）', () => {
    expect(kuaishouAdapter.apiUrlPatterns.some(r => r.test(REST_URL))).toBe(true)
    expect(kuaishouAdapter.apiUrlPatterns.some(r => r.test('https://www.kuaishou.com/rest/v/search/feed'))).toBe(true)
  })

  it('关键词/话题任务认这个响应，作者任务不认', () => {
    expect(kuaishouAdapter.matchesTaskResponse('keyword', REST_URL, REST_SEARCH_RESPONSE)).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('hashtag', REST_URL, REST_SEARCH_RESPONSE)).toBe(true)
    expect(kuaishouAdapter.matchesTaskResponse('author', REST_URL, REST_SEARCH_RESPONSE)).toBe(false)
  })

  it('解析出完整视频项：播放地址取 photoUrls[0].url（H.264），宽高取 photo 自身', () => {
    const items = kuaishouAdapter.parseApiJson(REST_URL, REST_SEARCH_RESPONSE)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      awemeId: '3xREALPHOTO01',
      title: '快手搜索结果标题',
      authorSecUid: '3xREALAUTHOR1',
      authorNickname: '快手作者',
      authorHomeUrl: 'https://www.kuaishou.com/profile/3xREALAUTHOR1',
      playUrl: 'https://v23-3.kwaicdn.test/h264-a.mp4',
      coverUrl: 'https://p-fixture.test/cover.jpg',
      width: 720,
      height: 1280,
      durationSec: 12.5,
      publishTime: 1757850158,
      likes: 228227,
      plays: 11484563, // 2026-10-07 补数据：播放数（这份真机样本里就有 viewCount）
      // 这个接口不返回评论数（comment.us_c 实测恒为 0，不是评论数）。
      // 按既有红线，未知必须是 null 让界面显示「—」，不能伪装成 0。
      comments: null,
      sourceUrl: 'https://www.kuaishou.com/short-video/3xREALPHOTO01'
    })
  })

  it('photoUrls 缺失时回落到 manifest 的最高码率 H.264 representation', () => {
    const noUrls = {
      ...REST_SEARCH_RESPONSE,
      feeds: [{ ...REST_FEED, photo: { ...REST_FEED.photo, photoUrls: [] } }]
    }
    const items = kuaishouAdapter.parseApiJson(REST_URL, noUrls)
    expect(items).toHaveLength(1)
    expect(items[0].playUrl).toBe('https://v-fixture.test/1080p.mp4')
  })

  it('photoUrls 与 manifest 都没有时回落 HEVC，仍不丢条目', () => {
    const h265Only = {
      ...REST_SEARCH_RESPONSE,
      feeds: [{
        ...REST_FEED,
        photo: {
          ...REST_FEED.photo,
          photoUrls: [],
          manifest: { adaptationSet: [] },
          manifestH265: { adaptationSet: [] }
        }
      }]
    }
    const items = kuaishouAdapter.parseApiJson(REST_URL, h265Only)
    expect(items[0].playUrl).toBe('https://v23-3.kwaicdn.test/h265-a.mp4')
  })

  it('一条播放地址都取不到 → 整条丢弃，不入库一个点不开的视频', () => {
    const broken = {
      ...REST_SEARCH_RESPONSE,
      feeds: [{
        ...REST_FEED,
        photo: {
          ...REST_FEED.photo,
          photoUrls: [], photoH265Urls: [],
          manifest: { adaptationSet: [] }, manifestH265: { adaptationSet: [] }
        }
      }]
    }
    expect(kuaishouAdapter.parseApiJson(REST_URL, broken)).toEqual([])
  })

  it('photo.width/height 缺失时才回落 representation 的宽高', () => {
    const noSize = {
      ...REST_SEARCH_RESPONSE,
      feeds: [{ ...REST_FEED, photo: { ...REST_FEED.photo, width: 0, height: 0, photoUrls: [] } }]
    }
    const items = kuaishouAdapter.parseApiJson(REST_URL, noSize)
    expect(items[0]).toMatchObject({ width: 1080, height: 1920 })
  })

  it('空 feeds / 畸形响应不抛错也不产生条目', () => {
    for (const json of [{ result: 1, feeds: [] }, { result: 0 }, null, 'text', []]) {
      expect(kuaishouAdapter.parseApiJson(REST_URL, json)).toEqual([])
      expect(kuaishouAdapter.matchesTaskResponse('keyword', REST_URL, json)).toBe(false)
    }
  })
})

// 2026-09-08 真机：作者主页走 POST /rest/v/profile/feed?__NS_hxfalcon=...
// 拦截日志里连出现 5 次、全被标「忽略」——URL 特征只认了搜索那条。
//
// 与搜索页不同的是：搜索页我拿到了完整响应结构（root 有 searchSessionId/webPageArea），
// 作者页目前只确知 URL。所以判据锚在 URL 上，再要求 feeds 是数组——
// 不去猜 root 还有哪些字段。解析器本身是按形状找 { photo, author } 的，不依赖根字段名。
const PROFILE_URL = 'https://www.kuaishou.com/rest/v/profile/feed?__NS_hxfalcon=REDACTED&caver=2'

describe('kuaishouAdapter 解析 REST 作者主页 feed', () => {
  const profileResponse = { result: 1, pcursor: '1', feeds: [REST_FEED] }

  it('URL 特征认得 /rest/v/profile/feed（真机上它一直被标「忽略」）', () => {
    expect(kuaishouAdapter.apiUrlPatterns.some(r => r.test(PROFILE_URL))).toBe(true)
  })

  it('作者任务收作者主页响应', () => {
    expect(kuaishouAdapter.matchesTaskResponse('author', PROFILE_URL, profileResponse)).toBe(true)
  })

  it('关键词/话题任务不收作者主页响应（用户手点作者头像不能污染搜索任务）', () => {
    expect(kuaishouAdapter.matchesTaskResponse('keyword', PROFILE_URL, profileResponse)).toBe(false)
    expect(kuaishouAdapter.matchesTaskResponse('hashtag', PROFILE_URL, profileResponse)).toBe(false)
  })

  it('作者任务不收搜索响应（反向也不能串）', () => {
    expect(kuaishouAdapter.matchesTaskResponse('author', REST_URL, REST_SEARCH_RESPONSE)).toBe(false)
  })

  it('URL 对但根本没有 feeds 数组 → 拒绝（错误页、风控页都长这样）', () => {
    for (const json of [{ result: 0 }, { result: 1 }, null, 'text', []]) {
      expect(kuaishouAdapter.matchesTaskResponse('author', PROFILE_URL, json)).toBe(false)
    }
  })

  it('解析作者主页 feed：解析器按形状取，不依赖根字段名', () => {
    const items = kuaishouAdapter.parseApiJson(PROFILE_URL, profileResponse)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      awemeId: '3xREALPHOTO01',
      authorSecUid: '3xREALAUTHOR1',
      playUrl: 'https://v23-3.kwaicdn.test/h264-a.mp4',
      comments: null
    })
  })
})

// 2026-10-07 补数据（功能 N05）：快手作品有播放数 viewCount
describe('快手互动数补全', () => {
  it('播放数读 viewCount（数字或数字字符串）；没有就不给', () => {
    const withView = { visionSearchPhoto: { feeds: [{ ...FEED, photo: { ...FEED.photo, viewCount: '12345' } }] } }
    const [a] = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', { data: withView })
    expect(a.plays).toBe(12345)
    const [b] = kuaishouAdapter.parseApiJson('https://www.kuaishou.com/graphql', { data: { visionSearchPhoto: { feeds: [FEED] } } })
    expect(b.plays).toBeUndefined()
  })
})
