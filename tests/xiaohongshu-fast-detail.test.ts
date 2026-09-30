import { describe, expect, it } from 'vitest'
import { xiaohongshuAdapter, parseXiaohongshuDetailHtml } from '../src/main/adapters/xiaohongshu'

/**
 * 快速模式：详情 HTML 里 window.__INITIAL_STATE__ 不是标准 JSON，
 * 含 undefined、new Map([]) 等写法，需要先宽松清理再 JSON.parse。
 * 夹具按总控真机实测形态构造：currentNoteId 是纯字符串，
 * 视频流分组为 EF4/EF5，条目字段是驼峰（masterUrl/avgBitrate/videoCodec）。
 */
const stateJson = (noteId: string): string => `{
  "note": {
    "currentNoteId": "${noteId}",
    "noteDetailMap": { "${noteId}": {
      "note": {
        "noteId": "${noteId}", "type": "video", "title": "测试笔记", "desc": "正文 #美食[话题]#",
        "time": 1780000000000,
        "user": { "userId": "AUTHOR1", "nickname": "作者甲", "nickName": undefined },
        "interactInfo": { "likedCount": "1.2万", "commentCount": "300" },
        "imageList": [],
        "extraIndex": new Map([]),
        "video": { "capa": { "duration": 12 }, "media": { "stream": {
          "EF4": [{ "masterUrl": "https://sns-video-zl.xhscdn.com/ef4.mp4", "backupUrls": ["https://bak.test/ef4.mp4"], "width": 720, "height": 1280, "avgBitrate": 900, "videoCodec": "EF4", "duration": 12000 }],
          "EF5": [{ "masterUrl": "https://sns-video-zl.xhscdn.com/ef5.mp4", "width": 1080, "height": 1920, "avgBitrate": 1500, "videoCodec": "EF5", "duration": 12000 }]
        } } }
      },
      "comments": undefined
    } }
  },
  "other": { "mapping": new Map([["a", 1], ["b", [2, 3]]]) }
}`

const detailHtml = (noteId: string): string => {
  const json = stateJson(noteId)
  if (!json.includes('new Map([])') || !json.includes('undefined')) throw new Error('夹具必须含非标准写法')
  return `<!doctype html><html><head><title>${noteId} - 小红书</title></head><body><script>window.__INITIAL_STATE__=${json};</script></body></html>`
}

describe('小红书快速模式：详情 HTML 解析', () => {
  it('含 undefined 与 new Map([]) 的注水状态解析出完整视频条目', () => {
    const out = parseXiaohongshuDetailHtml(
      `https://www.xiaohongshu.com/explore/NOTE1?xsec_token=PRIVATE_TOKEN`,
      detailHtml('NOTE1'),
      'NOTE1'
    )
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.item.awemeId).toBe('NOTE1')
    expect(out.item.title).toBe('测试笔记')
    expect(out.item.authorSecUid).toBe('AUTHOR1')
    expect(out.item.authorNickname).toBe('作者甲')
    expect(out.item.authorHomeUrl).toBe('https://www.xiaohongshu.com/user/profile/AUTHOR1')
    // 短边 ≤1080 里取最大 → EF5 1080×1920
    expect(out.item.playUrl).toBe('https://sns-video-zl.xhscdn.com/ef5.mp4')
    expect(out.item.width).toBe(1080)
    expect(out.item.height).toBe(1920)
    expect(out.item.durationSec).toBe(12)
    expect(out.item.publishTime).toBe(1780000000)
    expect(out.item.likes).toBe(12000)
    expect(out.item.comments).toBe(300)
    expect(out.item.sourceUrl).toBe('https://www.xiaohongshu.com/explore/NOTE1')
    // 令牌不进解析结果
    expect(JSON.stringify(out.item)).not.toContain('PRIVATE_TOKEN')
  })

  it('响应被重定向到登录页 → login（调度器按 login_required 暂停）', () => {
    const out = parseXiaohongshuDetailHtml(
      'https://www.xiaohongshu.com/login?redirect=x',
      '<html><body>请登录</body></html>',
      'NOTE1'
    )
    expect(out).toEqual({ kind: 'login' })
  })

  it('响应是验证码页 → verify（调度器按 stalled_verify 暂停）', () => {
    const out = parseXiaohongshuDetailHtml(
      'https://www.xiaohongshu.com/web/captcha?x',
      '<html><head><title>安全验证</title></head><body>验证码</body></html>',
      'NOTE1'
    )
    expect(out).toEqual({ kind: 'verify' })
  })

  it('不是详情页的响应 → skip，原因固定文案，不泄露响应内容', () => {
    const out = parseXiaohongshuDetailHtml(
      'https://www.xiaohongshu.com/explore/NOTE1',
      '<html><body>服务器出错了 稍后再试</body></html>',
      'NOTE1'
    )
    expect(out.kind).toBe('skip')
    if (out.kind !== 'skip') return
    expect(out.reason).not.toContain('出错了')
    expect(out.reason).not.toContain('稍后再试')
  })

  it('状态里没有当前笔记（noteId 不匹配）→ skip', () => {
    const html = detailHtml('OTHER')
    const out = parseXiaohongshuDetailHtml('https://www.xiaohongshu.com/explore/NOTE1', html, 'NOTE1')
    expect(out.kind).toBe('skip')
  })

  it('解析出的 note 无视频流（图文）→ skip', () => {
    const json = JSON.stringify({
      note: {
        currentNoteId: 'IMG1',
        noteDetailMap: { IMG1: { note: {
          noteId: 'IMG1', type: 'normal', title: '图文', desc: '',
          user: { userId: 'AUTHOR1', nickname: '作者甲' },
          imageList: [], video: null
        }, comments: null } }
      }
    })
    const out = parseXiaohongshuDetailHtml(
      'https://www.xiaohongshu.com/explore/IMG1',
      `<html><script>window.__INITIAL_STATE__=${json};</script></html>`,
      'IMG1'
    )
    expect(out.kind).toBe('skip')
  })

  it('currentNoteId 是 Vue ref（真机见过的形态）也能拆出值', () => {
    const json = JSON.stringify({
      note: {
        currentNoteId: { __v_isRef: true, _value: 'NOTE1' },
        noteDetailMap: { NOTE1: { note: {
          noteId: 'NOTE1', type: 'video', title: 'ref 页', desc: '', time: 1780000000000,
          user: { userId: 'A', nickname: 'n' },
          video: { capa: { duration: 5 }, media: { stream: { EF4: [{ masterUrl: 'https://cdn.test/a.mp4', width: 720, height: 1280, duration: 5000 }] } } }
        }, comments: null } }
      }
    })
    const out = parseXiaohongshuDetailHtml(
      'https://www.xiaohongshu.com/explore/NOTE1',
      `<html><script>window.__INITIAL_STATE__=${json};</script></html>`,
      'NOTE1'
    )
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') expect(out.item.awemeId).toBe('NOTE1')
  })

  it('适配器挂载 parseDetailHtml', () => {
    expect(xiaohongshuAdapter.parseDetailHtml).toBe(parseXiaohongshuDetailHtml)
  })
})
