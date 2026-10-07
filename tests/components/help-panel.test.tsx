import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import HelpPanel from '../../src/renderer/src/components/HelpPanel'

// Task2（round15）：程序内置「使用说明」面板。纯静态展示，内容来源 docs/使用说明.md，
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

  // 2026-10-07 许可改成 PolyForm Noncommercial：非商业免费，商用要买授权（以前是「允许靠输出赚钱、只禁止出售」）
  it('显示官方免费版本、源码可用许可边界和第三方许可位置', () => {
    const { container } = render(<HelpPanel />)
    const text = container.textContent ?? ''
    expect(text).toContain('官方免费版本')
    expect(text).toContain('非商业用途免费')
    expect(text).toContain('商业授权')
    expect(text).toContain('源码可用')
    expect(text).toContain('https://github.com/Sakeroux168/video_bug')
    expect(text).toContain('resources\\licenses')
    expect(text).toContain('按现状提供')
  })
})

// 2026-10-06 全面检查「界面」D7：使用说明有 7 处和软件对不上，照着找不到按钮
describe('D7 使用说明和软件对得上', () => {
  const text = (): string => render(<HelpPanel />).container.textContent ?? ''

  it('按钮、设置项用软件里真实的名字', () => {
    const t = text()
    expect(t).toContain('点「开始抓取」')
    expect(t).not.toContain('点「开始」')
    expect(t).toContain('每页最大等待(秒)') // 设置页的叫法
    expect(t).not.toContain('每页等待(秒)')
    expect(t).toContain('没有新结果') // 任务行现在显示的中文
    expect(t).not.toContain('stalled')
  })

  it('不再教关掉已经删掉的「统一输出分辨率」；说清楚下载的是原视频', () => {
    const t = text()
    expect(t).not.toContain('统一输出分辨率')
    expect(t).toContain('视频处理')
  })

  // 2026-10-07 素材库第二部分：分文件夹多了「关键词」一层；说明里要讲素材库和打包交付
  it('讲到按关键词分文件夹、素材库、打包交付', () => {
    const t = text()
    expect(t).toContain('关键词 / 品类 / 作者 / 横竖屏 / 时长')
    expect(t).toContain('素材库')
    expect(t).toContain('打包交付')
  })

  // 2026-10-07 自动化
  it('讲到托盘、系统通知、定时追更', () => {
    const t = text()
    expect(t).toContain('设置 → 自动化')
    expect(t).toContain('缩到托盘')
    expect(t).toContain('定时追更')
  })

  it('「未分类」只在勾了按品类分文件夹时才有；登录不只说抖音；不再叫人截图给技术', () => {
    const t = text()
    expect(t).toMatch(/勾了「按品类分文件夹」[^。]*未分类/)
    expect(t).not.toContain('扫码登录抖音')
    expect(t).not.toContain('截图给技术')
    expect(t).not.toContain('找技术')
  })
})
