import { describe, expect, it } from 'vitest'
import { resolveVideoSourceUrl } from '../src/main/videoSource'

describe('resolveVideoSourceUrl', () => {
  it('旧抖音行没有存储链接时生成规范作品页', () => {
    expect(resolveVideoSourceUrl('douyin', 'AW1', null))
      .toBe('https://www.douyin.com/video/AW1')
  })

  it('保留通过平台白名单校验的存储链接和公开查询参数', () => {
    expect(resolveVideoSourceUrl('douyin', 'AW1', 'https://www.douyin.com/video/AW1?from=test'))
      .toBe('https://www.douyin.com/video/AW1?from=test')
  })

  it.each([
    'javascript:alert(1)',
    'http://www.douyin.com/video/AW1',
    'https://evil.example/video/AW1',
    'https://www.douyin.com.evil.example/video/AW1',
    'not a url'
  ])('拒绝不安全或非平台作品链接：%s', (url) => {
    expect(resolveVideoSourceUrl('douyin', 'AW1', url)).toBeNull()
  })

  it('未知平台即使传入抖音地址也拒绝', () => {
    expect(resolveVideoSourceUrl('unknown', 'AW1', 'https://www.douyin.com/video/AW1')).toBeNull()
  })
})

describe('resolveVideoSourceUrl 快手', () => {
  it('旧行无存储链接时生成快手规范作品页', () => {
    expect(resolveVideoSourceUrl('kuaishou', '3xPHOTO1', null))
      .toBe('https://www.kuaishou.com/short-video/3xPHOTO1')
  })

  it('保留通过快手白名单校验的存储链接', () => {
    expect(resolveVideoSourceUrl('kuaishou', '3xPHOTO1', 'https://www.kuaishou.com/short-video/3xPHOTO1?fid=1'))
      .toBe('https://www.kuaishou.com/short-video/3xPHOTO1?fid=1')
  })

  it.each([
    'javascript:alert(1)',
    'http://www.kuaishou.com/short-video/3xPHOTO1',
    'https://evil.example/short-video/3xPHOTO1',
    'https://www.kuaishou.com.evil.example/short-video/3xPHOTO1',
    'https://v.kuaishou.com/ABC123'
  ])('拒绝不安全或非快手作品链接：%s', (url) => {
    expect(resolveVideoSourceUrl('kuaishou', '3xPHOTO1', url)).toBeNull()
  })

  it('跨平台不串台：快手行里存着抖音地址也拒绝', () => {
    expect(resolveVideoSourceUrl('kuaishou', '3xPHOTO1', 'https://www.douyin.com/video/AW1')).toBeNull()
    expect(resolveVideoSourceUrl('douyin', 'AW1', 'https://www.kuaishou.com/short-video/3xPHOTO1')).toBeNull()
  })
})
