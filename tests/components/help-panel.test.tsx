import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import HelpPanel from '../../src/renderer/src/components/HelpPanel'

// Task2（round15）：程序内置「使用说明」面板。纯静态展示，内容来源 docs/员工使用说明.md，
// 但删掉「怎么拿到 exe」「SmartScreen 首次放行」两节（用户已经打开程序了，这两节没意义）。
// 用整体 textContent 断言关键信息存在，避免因段落里同时含标签文本与正文文本导致
// getByText 多重命中（同一短语既出现在小标题又出现在正文里）。

describe('HelpPanel（使用说明面板）', () => {
  it('渲染出首次设置关键信息：下载目录、扫码登录', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('下载目录')
    expect(text).toContain('扫码登录')
  })

  it('渲染出注意事项：别开多个程序窗口', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('别开多个程序窗口')
  })

  it('渲染出数据路径：%APPDATA%\\video-scraper', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('%APPDATA%\\video-scraper')
  })

  it('渲染出「会遇到的情况」表格与「参数别乱调」的三个具体数值', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('已重搜 3 次仍爬不满')
    expect(text).toContain('3500')
    expect(text).toContain('停滞检测(秒)')
    expect(text).toContain('25')
  })

  it('渲染出「暂时用不了的功能」提示 AI 自动判断品类未开启', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('AI 自动判断品类')
  })

  it('不应包含「怎么拿到 exe」「SmartScreen 首次放行」这两节（程序内没意义）', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).not.toContain('SmartScreen')
    expect(text).not.toContain('仍要运行')
    expect(text).not.toContain('已保护你的电脑')
  })

  it('显示官方免费版本、源码可用许可边界和第三方许可位置', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('官方免费版本')
    expect(text).toContain('允许利用软件输出赚钱')
    expect(text).toContain('禁止出售软件本身')
    expect(text).toContain('源码可用')
    expect(text).toContain('https://github.com/Sakeroux168/video_bug')
    expect(text).toContain('resources\\licenses')
    expect(text).toContain('按现状提供')
  })
})
