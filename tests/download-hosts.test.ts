import { describe, it, expect } from 'vitest'
import { isAllowedMediaUrl } from '../src/main/downloadHosts'

// 2026-10-07 安全加固 A8（全面检查 安全 M5）：下载地址只认平台自己的域名。
// 以前 play_addr / cover_url 是什么地址就请求什么——页面里的第三方嵌入框伪造一条「搜索结果」，
// 就能让主进程去请求内网、127.0.0.1 或任意网站。

describe('下载地址白名单', () => {
  it('平台自己的视频 / 图片域名（含子域名）放行；http 和 https 都行（小红书视频地址是 http）', () => {
    expect(isAllowedMediaUrl('douyin', 'https://v5-dy-ov-experiment.zjcdn.com/a.mp4')).toBe(true)
    expect(isAllowedMediaUrl('douyin', 'https://p3-pc-sign.douyinpic.com/c.jpeg')).toBe(true)
    expect(isAllowedMediaUrl('douyin', 'https://v26-web.douyinvod.com/x')).toBe(true)
    expect(isAllowedMediaUrl('xiaohongshu', 'http://sns-video-zl.xhscdn.com/v')).toBe(true)
    expect(isAllowedMediaUrl('xiaohongshu', 'http://sns-webpic-qc.xhscdn.com/p')).toBe(true)
    expect(isAllowedMediaUrl('kuaishou', 'https://v2.kwaicdn.com/upic/x.mp4')).toBe(true)
    expect(isAllowedMediaUrl('kuaishou', 'https://p2.a.yximgs.com/c.jpg')).toBe(true)
  })

  it('别的网站、内网、本机、IP 地址、非 http 协议一律拦下', () => {
    expect(isAllowedMediaUrl('douyin', 'https://evil.example.com/a.mp4')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'https://zjcdn.com.evil.com/a.mp4')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'https://evilzjcdn.com/a.mp4')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'http://127.0.0.1:47321/task')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'http://localhost/a')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'http://192.168.1.1/a')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'http://[::1]/a')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedMediaUrl('douyin', 'not a url')).toBe(false)
    expect(isAllowedMediaUrl('douyin', null)).toBe(false)
  })

  it('平台之间不串：抖音的任务不能下小红书域名的地址；不认识的平台一律不放', () => {
    expect(isAllowedMediaUrl('douyin', 'http://sns-video-zl.xhscdn.com/v')).toBe(false)
    expect(isAllowedMediaUrl('nope', 'https://v5.zjcdn.com/a.mp4')).toBe(false)
  })
})
