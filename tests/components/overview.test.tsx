import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Overview from '../../src/renderer/src/components/Overview'
import { installFakeApi } from '../helpers/fake-api'

const gstats = (over: Record<string, unknown> = {}) => ({
  videos: { total: 1200, pending: 210, downloading: 3, done: 980, failed: 7, filtered: 0, collected: 0, cancelled: 0, paused: 0 },
  tasks: { total: 8, pending: 5, running: 2, done: 1, paused: 0, failed: 0 },
  ...over
})

beforeEach(() => { installFakeApi() })

describe('概览页', () => {
  it('渲染任务/视频/作者三张统计卡的关键数字', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    const { container } = render(<Overview onGoto={() => {}} />)
    await waitFor(() => expect(container.textContent).toContain('980'))
    expect(container.textContent).toContain('210')
    expect(container.textContent).toContain('2')
  })

  // 这条是本页最重要的约束：scanFilesTree 是同步 readdirSync+statSync，
  // 跑在主进程上，扫描期间所有 IPC / 窗口事件 / 下载器回调全部排队。
  it('挂载时**绝不**自动扫磁盘（同步扫描会阻塞主进程）', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    render(<Overview onGoto={() => {}} />)
    await waitFor(() => expect(window.api.getGlobalStats).toHaveBeenCalled())
    expect(window.api.getFilesTree).not.toHaveBeenCalled()
  })

  it('点「扫描」按钮才真的扫，扫完显示总大小', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    vi.mocked(window.api.getFilesTree).mockResolvedValue({
      root: { name: '', videoCount: 10, size: 1024 * 1024 * 500, files: [], dirs: [{ name: '美食', videoCount: 10, size: 1024 * 1024 * 500, dirs: [], files: [] }] },
      totalSize: 1024 * 1024 * 500, downloadDir: 'D:/x'
    } as never)
    const { container } = render(<Overview onGoto={() => {}} />)
    await screen.findByRole('button', { name: /扫描/ })
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await waitFor(() => expect(window.api.getFilesTree).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.textContent).toMatch(/500|0\.49/))
  })

  it('最近完成显示标题与作者，而不是光秃秃的 id', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    vi.mocked(window.api.getRecentDownloads).mockResolvedValue([
      { id: 412, title: '某某视频标题', downloaded_at: '2026-08-01T12:00:00Z', author_nickname: '张三' }
    ] as never)
    const { container } = render(<Overview onGoto={() => {}} />)
    await waitFor(() => expect(container.textContent).toContain('某某视频标题'))
    expect(container.textContent).toContain('张三')
    expect(container.textContent).not.toContain('#412')
  })

  it('卡片上的「查看全部」能跳到对应页', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    const onGoto = vi.fn()
    render(<Overview onGoto={onGoto} />)
    const btns = await screen.findAllByRole('button', { name: /查看全部/ })
    fireEvent.click(btns[0])
    expect(onGoto).toHaveBeenCalled()
  })

  it('环境自检：AI 未配置时给出提示', async () => {
    vi.mocked(window.api.getGlobalStats).mockResolvedValue(gstats() as never)
    vi.mocked(window.api.getSettings).mockResolvedValue({ aiApiKey: '', downloadDir: 'D:/x' } as never)
    const { container } = render(<Overview onGoto={() => {}} />)
    await waitFor(() => expect(container.textContent).toContain('AI'))
  })
})
