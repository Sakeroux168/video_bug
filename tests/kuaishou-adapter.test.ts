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
      publishTime: 1710000000.123,
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
