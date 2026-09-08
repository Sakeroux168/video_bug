import { describe, expect, it } from 'vitest'
import { getAdapter, listAdapters } from '../src/main/adapters'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'
import { xiaohongshuAdapter } from '../src/main/adapters/xiaohongshu'

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
